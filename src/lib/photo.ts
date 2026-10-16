import { applyMask, type MaskOptions, type ZoneKind } from './anonymize'
import type { FaceModel } from './detector-protocol'
import { decodeHeic, isHeic } from './heic'
import { findMetadata, stripMetadata } from './metadata'

/** iOS Safari refuses canvases above ~16.7 megapixels; larger photos are scaled down to fit. */
const MAX_PIXELS = 16_000_000
const PREVIEW_MAX_SIDE = 2048
const THUMB_SIDE = 160

export interface Zone {
  id: number
  x: number
  y: number
  w: number
  h: number
  /** Detector confidence, or null for a zone drawn by hand (always kept). */
  score: number | null
  /** 'face' when absent. */
  kind?: ZoneKind
  /** Left visible on purpose ("tout masquer sauf…"): shown in the editor, not masked. */
  keep?: boolean
}

export interface Photo {
  id: number
  file: File
  /** Working size, in which zones are expressed (the original size, capped to MAX_PIXELS). */
  width: number
  height: number
  downscaled: boolean
  /** Metadata found in the original file, shown before export; null when the format could not be analysed. */
  metadata: string[] | null
  preview: HTMLCanvasElement
  thumb: string
  /** Faces found by the detector, and the model that found them (null before the first analysis). */
  detected: Zone[]
  faceModel: FaceModel | null
  /** Text found by the text detector; null until it has run on this photo. */
  textDetected: Zone[] | null
  /** What the editor and the export use: detections (possibly moved), zones drawn by hand. */
  zones: Zone[]
  status: 'detecting' | 'ready' | 'error'
  /** What is being looked for, while detecting. */
  task: 'faces' | 'text'
  progress: number
  /** Estimated time left for the analysis. */
  remainingMs: number | null
  error?: string
}

/** Zones the export will mask: those shown in the editor, except the ones left visible on purpose. */
export function maskedZones(photo: Photo, threshold: number): Zone[] {
  return zonesAbove(photo.zones, threshold).filter((z) => !z.keep)
}

/**
 * Zones shown in the editor: hand-drawn ones, detected text, and faces at or above the sensitivity
 * threshold (text has its own, fixed threshold in the detector).
 */
export function zonesAbove(zones: Zone[], threshold: number): Zone[] {
  return zones.filter((z) => z.score === null || z.kind === 'area' || z.score >= threshold)
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** Frees the canvas backing store right away; iOS caps the total canvas memory of a page. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

/**
 * Decodes the file at working size. Goes through an <img> because every browser applies the EXIF
 * orientation there, and Safari decodes HEIC photos that way.
 */
async function decodeToCanvas(file: File): Promise<{ canvas: HTMLCanvasElement; downscaled: boolean }> {
  const image = await decodeImage(file)
  try {
    const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width
    const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)))
    const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale))
    // The export reads the pixels back to mask them.
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return { canvas, downscaled: scale < 1 }
  } finally {
    if (image instanceof ImageBitmap) image.close()
  }
}

/** The browser's own decoder first; HEIC photos it cannot read (outside Safari) go through libheif. */
async function decodeImage(file: File): Promise<HTMLImageElement | ImageBitmap> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } catch {
    // Below.
  } finally {
    URL.revokeObjectURL(url)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!isHeic(bytes)) throw new Error('Ce fichier n’est pas une image lisible.')
  return decodeHeic(bytes)
}

function scaledCopy(source: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height))
  const canvas = createCanvas(Math.round(source.width * scale), Math.round(source.height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Decodes a photo for editing. The full-size bitmap is only returned for detection; the app keeps the preview. */
export async function loadPhoto(file: File): Promise<{
  width: number
  height: number
  downscaled: boolean
  metadata: string[] | null
  preview: HTMLCanvasElement
  thumb: string
  bitmap: ImageBitmap
}> {
  const { canvas, downscaled } = await decodeToCanvas(file)
  let metadata: string[] | null = null
  try {
    metadata = findMetadata(new Uint8Array(await file.arrayBuffer()))
  } catch {
    // Malformed file the browser could still decode: just don't list its metadata.
  }
  try {
    const thumbCanvas = scaledCopy(canvas, THUMB_SIDE)
    const thumb = thumbCanvas.toDataURL('image/jpeg', 0.7)
    releaseCanvas(thumbCanvas)
    return {
      width: canvas.width,
      height: canvas.height,
      downscaled,
      metadata,
      preview: scaledCopy(canvas, PREVIEW_MAX_SIDE),
      thumb,
      bitmap: await createImageBitmap(canvas),
    }
  } finally {
    releaseCanvas(canvas)
  }
}

/** The photo at working size, for a new analysis (another model, text). */
export async function decodeForAnalysis(file: File): Promise<ImageBitmap> {
  const { canvas } = await decodeToCanvas(file)
  try {
    return await createImageBitmap(canvas)
  } finally {
    releaseCanvas(canvas)
  }
}

/**
 * Renders the masked photo at working size and encodes it. Re-encoding from a canvas leaves EXIF (GPS,
 * device, date), XMP and the embedded thumbnail — which often still shows the unmasked face — behind;
 * what the browser adds itself is then stripped, and the result checked.
 */
export async function exportPhoto(photo: Photo, zones: Zone[], options: MaskOptions): Promise<File> {
  const { canvas } = await decodeToCanvas(photo.file)
  try {
    applyMask(canvas.getContext('2d')!, zones.map((z) => ({ ...z, seed: z.id })), options)
    const png = photo.file.type === 'image/png'
    const type = png ? 'image/png' : 'image/jpeg'
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92))
    if (!blob) throw new Error('L’encodage de l’image a échoué (mémoire insuffisante ?).')
    const clean = stripMetadata(new Uint8Array(await blob.arrayBuffer()))
    if (findMetadata(clean)?.length !== 0) throw new Error('Des métadonnées n’ont pas pu être supprimées : export annulé.')
    // A generic name: the original file name may itself identify someone.
    return new File([clean], `photo-anonyme-${photo.id}.${png ? 'png' : 'jpg'}`, { type })
  } finally {
    releaseCanvas(canvas)
  }
}
