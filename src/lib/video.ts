// Videos (computers only, see `videoUnavailableReason`): opening, face analysis, preview frames and export.
//
// Frames are decoded with WebCodecs, read and written with Mediabunny. The export is a new MP4 encoded
// from the masked frames: none of the original's metadata or sensor tracks are copied, and the sound is
// only kept on request (a voice can identify someone).

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  getFirstEncodableVideoCodec,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny'
import { applyMask, type MaskOptions } from './anonymize'
import { detectFaces } from './detector'
import { cleanMp4, findMp4Metadata, readMetadataBoxes } from './mp4'
import type { Zone } from './photo'
import type { AnalysedFrame } from './tracks'

export type AnalysisMode = 'standard' | 'deep'

/**
 * How often frames are analysed (seconds) and the largest resolution scanned (see `planPasses`). Standard
 * finds faces down to about 1/40 of the image height; deep, those as small as in photos, but is 4 to 6
 * times slower.
 */
export const ANALYSIS: Record<AnalysisMode, { interval: number; maxLevel: number }> = {
  standard: { interval: 1 / 10, maxLevel: 1280 },
  deep: { interval: 1 / 15, maxLevel: Infinity },
}

/** The export is built in memory: about 1 GB for 10 minutes of 1080p. */
const MAX_DURATION_S = 10 * 60
const PREVIEW_MAX_SIDE = 1280

export interface Video {
  file: File
  input: Input
  track: InputVideoTrack
  audio: InputAudioTrack | null
  /** Whether the sound can go into the exported MP4 as it is. */
  audioCopyable: boolean
  /** Display size (rotation applied), in which zones are expressed. */
  width: number
  height: number
  /** First and end timestamps of the video track, in seconds. */
  start: number
  end: number
  frameRate: number
  /** Metadata found in the original file; null when the format could not be analysed (WebM…). */
  metadata: string[] | null
  /** Preview frames, at most PREVIEW_MAX_SIDE wide or high. */
  frames: CanvasSink
}

export async function openVideo(file: File): Promise<Video> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const track = await input.getPrimaryVideoTrack().catch(() => null)
    if (!track) throw new Error('Ce fichier n’est pas une vidéo lisible.')
    if (!(await track.canDecode())) {
      throw new Error(`Ce navigateur ne sait pas décoder cette vidéo (format ${(await track.getCodec()) ?? 'inconnu'}). Essayez avec Chrome ou Edge.`)
    }
    const [width, height, start, end, stats, audio] = await Promise.all([
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getFirstTimestamp(),
      track.computeDuration(),
      track.computePacketStats(100),
      input.getPrimaryAudioTrack(),
    ])
    if (end - start > MAX_DURATION_S) throw new Error(`Cette vidéo dure plus de ${MAX_DURATION_S / 60} minutes : coupez-la en plusieurs parties.`)
    const audioCodec = audio && (await audio.getCodec())
    let metadata: string[] | null = null
    try {
      const boxes = await readMetadataBoxes(file)
      metadata = boxes && findMp4Metadata(boxes)
    } catch {
      // Malformed file the decoder could still read: just don't list its metadata.
    }
    const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(width, height))
    return {
      file,
      input,
      track,
      audio,
      audioCopyable: audioCodec !== null && new Mp4OutputFormat().getSupportedAudioCodecs().includes(audioCodec),
      width,
      height,
      start,
      end,
      frameRate: stats.averagePacketRate || 30,
      metadata,
      frames: new CanvasSink(track, { width: Math.round(width * scale), height: Math.round(height * scale), fit: 'fill' }),
    }
  } catch (error) {
    input.dispose()
    throw error
  }
}

export function closeVideo(video: Video): void {
  video.input.dispose()
}

function abortError(): DOMException {
  return new DOMException('Annulé', 'AbortError')
}

/** Timestamps to analyse: every `interval` seconds, plus the last frame. */
function* analysisTimes(video: Video, interval: number): Generator<number> {
  for (let t = video.start; t < video.end; t += interval) yield t
  yield video.end - 1e-6
}

/**
 * Detects faces on frames sampled across the video, calling `onFrame` in order. `progress` goes from 0 to 1.
 * Decoding the next frame overlaps with the analysis of the current one.
 */
export async function analyseVideo(
  video: Video,
  mode: AnalysisMode,
  onFrame: (frame: AnalysedFrame, progress: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const { interval, maxLevel } = ANALYSIS[mode]
  const scale = Math.min(1, maxLevel / Math.max(video.width, video.height))
  const canvas = new OffscreenCanvas(Math.round(video.width * scale), Math.round(video.height * scale))
  const ctx = canvas.getContext('2d')!
  const toVideo = video.width / canvas.width
  const inFlight: Promise<void>[] = []
  let previous = -Infinity
  const sink = new VideoSampleSink(video.track)
  for await (const sample of sink.samplesAtTimestamps(analysisTimes(video, interval))) {
    if (!sample) continue
    try {
      if (signal.aborted) throw abortError()
      // Frames longer than the interval are returned several times.
      if (sample.timestamp === previous) continue
      const t = (previous = sample.timestamp)
      sample.draw(ctx, 0, 0, canvas.width, canvas.height)
      const job = detectFaces(canvas.transferToImageBitmap(), () => {}, maxLevel).then(({ detections }) => {
        if (signal.aborted) return
        const scaled = detections.map((d) => ({ x: d.x * toVideo, y: d.y * toVideo, w: d.w * toVideo, h: d.h * toVideo, score: d.score }))
        onFrame({ t, detections: scaled }, Math.min(1, (t - video.start) / (video.end - video.start)))
      })
      inFlight.push(job)
      if (inFlight.length >= 2) await inFlight.shift()
    } finally {
      sample.close()
    }
  }
  await Promise.all(inFlight)
  if (signal.aborted) throw abortError()
}

/** The preview frame shown at `t` (the last one starting at or before it). */
export async function previewFrame(video: Video, t: number): Promise<{ canvas: HTMLCanvasElement | OffscreenCanvas; timestamp: number }> {
  const frame = (await video.frames.getCanvas(t)) ?? (await video.frames.getCanvas(video.start))
  if (!frame) throw new Error('Image introuvable dans la vidéo.')
  return frame
}

/**
 * Encodes the masked video as MP4. `zonesAt` gives the zones of the frame at a timestamp, in video pixels.
 * The file is built in memory, then its own metadata (dates, track names) is neutralised and checked.
 */
export async function exportVideo(
  video: Video,
  zonesAt: (t: number) => Zone[],
  options: MaskOptions,
  keepAudio: boolean,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
): Promise<File> {
  const format = new Mp4OutputFormat({ fastStart: 'in-memory' })
  const target = new BufferTarget()
  const output = new Output({ format, target })
  // H.264 first: it plays everywhere. Its encoders want even dimensions; the last row or column is dropped.
  const width = video.width - (video.width % 2)
  const height = video.height - (video.height % 2)
  const codec = await getFirstEncodableVideoCodec(
    (['avc', 'hevc', 'vp9', 'av1'] as const).filter((c) => format.getSupportedVideoCodecs().includes(c)),
    { width, height },
  )
  if (!codec) throw new Error('Ce navigateur ne sait encoder aucun format vidéo compatible MP4 à cette taille.')

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const videoSource = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH })
  output.addVideoTrack(videoSource)
  const audio = keepAudio && video.audioCopyable ? video.audio : null
  const audioCodec = audio && (await audio.getCodec())
  const audioSource = audioCodec ? new EncodedAudioPacketSource(audioCodec) : null
  if (audioSource) output.addAudioTrack(audioSource)

  try {
    await output.start()
    const writeVideo = async () => {
      const duration = video.end - video.start
      for await (const sample of new VideoSampleSink(video.track).samples()) {
        try {
          if (signal.aborted) throw abortError()
          sample.draw(ctx, 0, 0, video.width, video.height)
          applyMask(ctx, zonesAt(sample.timestamp).map((z) => ({ ...z, seed: z.id })), options)
          await videoSource.add(sample.timestamp - video.start, sample.duration)
          onProgress(Math.min(1, (sample.timestamp + sample.duration - video.start) / duration))
        } finally {
          sample.close()
        }
      }
      videoSource.close()
    }
    // The sound is copied as it is, shifted like the video so that both start at 0.
    const writeAudio = async () => {
      if (!audio || !audioSource) return
      const decoderConfig = (await audio.getDecoderConfig()) ?? undefined
      let first = true
      for await (const packet of new EncodedPacketSink(audio).packets()) {
        if (signal.aborted) throw abortError()
        const timestamp = packet.timestamp - video.start
        if (timestamp < 0) continue
        await audioSource.add(packet.clone({ timestamp }), first ? { decoderConfig } : undefined)
        first = false
      }
      audioSource.close()
    }
    await Promise.all([writeVideo(), writeAudio()])
    await output.finalize()
  } catch (error) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {})
    throw error
  }

  const bytes = new Uint8Array(target.buffer!)
  cleanMp4(bytes)
  if (findMp4Metadata(bytes)?.length !== 0) throw new Error('Des métadonnées n’ont pas pu être supprimées : export annulé.')
  // A generic name: the original file name may itself identify someone.
  return new File([bytes], 'video-anonyme.mp4', { type: 'video/mp4' })
}
