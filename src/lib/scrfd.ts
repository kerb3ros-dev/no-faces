// Pre- and post-processing for the SCRFD face detector (InsightFace), independent of the inference runtime.

export interface Detection {
  x: number
  y: number
  w: number
  h: number
  score: number
}

/** The exported model has a fixed 640×640 input. */
export const INPUT_SIZE = 640
const STRIDES = [8, 16, 32] as const
const ANCHORS_PER_CELL = 2

/** A crop of the image fed to the model: source rect in image pixels, drawn at `scale` into the input's top-left corner. */
export interface Pass {
  sx: number
  sy: number
  sw: number
  sh: number
  scale: number
}

/** Long-side resolutions the image is scanned at. Above 640 the image is cut into overlapping tiles so small faces stay detectable. */
const LEVELS = [640, 1280, 2560]
/**
 * Small images are scanned up to twice their size to catch tiny faces (crowds in a 1000 px photo). Larger
 * ones are not upscaled: there, faces too small for the native resolution are too small to identify, and
 * upscaling would multiply the passes.
 */
const SMALL_IMAGE = 1600
const MAX_UPSCALE_SMALL = 2
const TILE_OVERLAP = 0.2

/** `maxLevel` caps the resolution scanned, to trade the smallest faces for speed (video). */
export function planPasses(width: number, height: number, maxLevel = Infinity): Pass[] {
  const long = Math.max(width, height)
  // The whole image shrunk to half the input catches faces that fill the frame, which the model misses at full size.
  const passes: Pass[] = [{ sx: 0, sy: 0, sw: width, sh: height, scale: INPUT_SIZE / 2 / long }]
  let previous = 0
  for (const level of LEVELS.filter((l) => l <= maxLevel)) {
    const scale = Math.min(level / long, long < SMALL_IMAGE ? MAX_UPSCALE_SMALL : 1)
    if (scale < previous * 1.3) continue
    previous = scale
    const tile = INPUT_SIZE / scale
    for (const sy of tileStarts(height, tile)) {
      for (const sx of tileStarts(width, tile)) {
        passes.push({ sx, sy, sw: Math.min(tile, width - sx), sh: Math.min(tile, height - sy), scale })
      }
    }
  }
  return passes
}

function tileStarts(length: number, tile: number): number[] {
  if (length <= tile) return [0]
  const count = Math.ceil((length - tile) / (tile * (1 - TILE_OVERLAP))) + 1
  return Array.from({ length: count }, (_, i) => (i * (length - tile)) / (count - 1))
}

/** RGBA pixels of the 640×640 input → normalised planar RGB, as the model was trained. */
export function toTensorData(rgba: Uint8ClampedArray, out: Float32Array): void {
  const n = INPUT_SIZE * INPUT_SIZE
  for (let i = 0; i < n; i++) {
    out[i] = (rgba[i * 4] - 127.5) / 128
    out[n + i] = (rgba[i * 4 + 1] - 127.5) / 128
    out[2 * n + i] = (rgba[i * 4 + 2] - 127.5) / 128
  }
}

/** Boxes (in input pixels) from the `score_*` / `bbox_*` outputs of one run. Scores are already sigmoid-activated. */
export function decodeOutputs(output: (name: string) => Float32Array, minScore: number): Detection[] {
  const detections: Detection[] = []
  for (const stride of STRIDES) {
    const scores = output(`score_${stride}`)
    const boxes = output(`bbox_${stride}`)
    const cols = INPUT_SIZE / stride
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] < minScore) continue
      const cell = Math.floor(i / ANCHORS_PER_CELL)
      const ax = (cell % cols) * stride
      const ay = Math.floor(cell / cols) * stride
      const x1 = ax - boxes[i * 4] * stride
      const y1 = ay - boxes[i * 4 + 1] * stride
      const x2 = ax + boxes[i * 4 + 2] * stride
      const y2 = ay + boxes[i * 4 + 3] * stride
      detections.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score: scores[i] })
    }
  }
  return detections
}

function intersection(a: Detection, b: Detection): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Greedy non-maximum suppression across all passes. A box is also dropped when it lies mostly inside a
 * higher-scoring one (a face cut in half by a tile border), since the bigger box already covers it.
 * Suppressors always score higher, so filtering the result by a score threshold afterwards stays consistent.
 */
export function suppress(detections: Detection[], iouThreshold = 0.4, containedThreshold = 0.8): Detection[] {
  const kept: Detection[] = []
  for (const d of [...detections].sort((a, b) => b.score - a.score)) {
    const area = d.w * d.h
    const redundant = kept.some((k) => {
      const inter = intersection(d, k)
      return inter / (area + k.w * k.h - inter) >= iouThreshold || inter / area >= containedThreshold
    })
    if (!redundant) kept.push(d)
  }
  return kept
}
