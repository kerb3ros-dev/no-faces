// Face tracking across a video, from detections on sampled frames.
//
// The detector only runs on some frames (several per second). In between, a face must still be masked,
// otherwise it shows for a few frames. Detections are linked into tracks, and for any frame the mask covers
// where the face is on the analysed frames just before AND just after it (union of the two boxes): with
// motion between them, the face is somewhere in that union. Tracks also extend one analysed frame beyond
// their ends, in case the detector loses a face that is turning away.

import type { Detection } from './scrfd'
import type { Zone } from './photo'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Detections of one analysed frame, at its timestamp in seconds. */
export interface AnalysedFrame {
  t: number
  detections: Detection[]
}

interface Point {
  /** Index of the analysed frame. */
  i: number
  box: Box
}

export interface Track {
  id: number
  /** Highest detector score along the track: a face confidently detected once is masked all along. */
  score: number
  points: Point[]
}

export interface Tracking {
  /** Timestamps of the analysed frames, increasing. */
  times: number[]
  tracks: Track[]
}

/** Analysed frames a face may be missed on without breaking its track (gaps are interpolated). */
const MAX_GAP = 3
/** Analysed frames a track is extended by at both ends. */
const HOLD = 1
/** A detection continues a track if its centre moved less than this many face sizes since the last sighting. */
const MAX_JUMP = 1.5
const MAX_SIZE_RATIO = 2

/** Links detections into tracks, frame by frame. Deterministic: track ids are stable as frames are appended. */
export function buildTracks(frames: AnalysedFrame[]): Tracking {
  const tracks: Track[] = []
  frames.forEach((frame, i) => {
    const open = tracks.filter((t) => i - t.points[t.points.length - 1].i <= MAX_GAP + 1)
    const pairs: { track: Track; detection: Detection; cost: number }[] = []
    for (const track of open) {
      const last = track.points[track.points.length - 1].box
      for (const detection of frame.detections) {
        const cost = linkCost(last, detection, i - track.points[track.points.length - 1].i)
        if (cost !== null) pairs.push({ track, detection, cost })
      }
    }
    pairs.sort((a, b) => a.cost - b.cost)
    const usedTracks = new Set<Track>()
    const usedDetections = new Set<Detection>()
    for (const { track, detection } of pairs) {
      if (usedTracks.has(track) || usedDetections.has(detection)) continue
      usedTracks.add(track)
      usedDetections.add(detection)
      track.points.push({ i, box: boxOf(detection) })
      track.score = Math.max(track.score, detection.score)
    }
    for (const detection of frame.detections) {
      if (!usedDetections.has(detection)) tracks.push({ id: tracks.length + 1, score: detection.score, points: [{ i, box: boxOf(detection) }] })
    }
  })
  return { times: frames.map((f) => f.t), tracks }
}

const boxOf = ({ x, y, w, h }: Box): Box => ({ x, y, w, h })

/** Centre distance in face sizes (per analysed frame elapsed), or null if the detection cannot be this face. */
function linkCost(a: Box, b: Box, frames: number): number | null {
  const size = Math.max(a.w, a.h, b.w, b.h)
  const ratio = Math.max(a.w * a.h, b.w * b.h) / Math.max(1e-6, Math.min(a.w * a.h, b.w * b.h))
  if (ratio > MAX_SIZE_RATIO * MAX_SIZE_RATIO) return null
  const distance = Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) / size
  return distance <= MAX_JUMP * frames ? distance : null
}

export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/** Where the track is on analysed frame `i`: interpolated across missed frames, held at its ends. */
function boxAtFrame(track: Track, i: number, times: number[]): Box {
  const { points } = track
  if (i <= points[0].i) return points[0].box
  const last = points[points.length - 1]
  if (i >= last.i) return last.box
  let k = 0
  while (points[k + 1].i < i) k++
  const p = points[k]
  const q = points[k + 1]
  if (q.i === i) return q.box
  const f = (times[i] - times[p.i]) / (times[q.i] - times[p.i])
  const lerp = (a: number, b: number) => a + (b - a) * f
  return { x: lerp(p.box.x, q.box.x), y: lerp(p.box.y, q.box.y), w: lerp(p.box.w, q.box.w), h: lerp(p.box.h, q.box.h) }
}

/** Index of the last analysed frame at or before `t` (-1 if none). */
function frameBefore(times: number[], t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/**
 * Zones to mask on the frame at `t`, one per track present on the analysed frames around it. Past the last
 * analysed frame (while the analysis runs), the faces found on it are held.
 */
export function zonesAt({ times, tracks }: Tracking, t: number): Zone[] {
  if (times.length === 0) return []
  const before = frameBefore(times, t)
  // A frame that was analysed only needs its own detections; any other lies between two analysed frames.
  const around = before >= 0 && times[before] === t ? [before] : [before, before + 1]
  const zones: Zone[] = []
  for (const track of tracks) {
    const first = track.points[0].i - HOLD
    const last = track.points[track.points.length - 1].i + HOLD
    let box: Box | null = null
    for (const i of around) {
      if (i < first || i > last) continue
      const at = boxAtFrame(track, Math.min(Math.max(i, 0), times.length - 1), times)
      box = box ? union(box, at) : at
    }
    if (box) zones.push({ id: track.id, ...box, score: track.score })
  }
  return zones
}

/** A position given by hand to a zone on one frame. */
export interface Keyframe {
  t: number
  box: Box
}

/** Where a hand-placed zone is at `t`: interpolated between its keyframes, held before the first and after the last. */
export function keyframeBox(keys: Keyframe[], t: number): Box {
  if (t <= keys[0].t) return keys[0].box
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.box
  let k = 0
  while (keys[k + 1].t < t) k++
  const p = keys[k]
  const q = keys[k + 1]
  const f = (t - p.t) / (q.t - p.t)
  const lerp = (a: number, b: number) => a + (b - a) * f
  return { x: lerp(p.box.x, q.box.x), y: lerp(p.box.y, q.box.y), w: lerp(p.box.w, q.box.w), h: lerp(p.box.h, q.box.h) }
}

/** Keyframes with `box` at `t`, replacing the one on the same frame (within `tolerance` seconds). */
export function setKeyframe(keys: Keyframe[], t: number, box: Box, tolerance: number): Keyframe[] {
  return [...keys.filter((k) => Math.abs(k.t - t) >= tolerance), { t, box }].sort((a, b) => a.t - b.t)
}
