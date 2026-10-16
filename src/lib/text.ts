// Pre- and post-processing for the PP-OCR text detector (DBNet, PaddleOCR), independent of the inference
// runtime. It finds where text is — licence plates, signs, name badges, screens — without reading it.

import type { Detection } from './scrfd'

/** Side of the square input fed to the model. Fixed, so the GPU compiles its shaders once. */
export const TEXT_INPUT = 960
/** The image is scanned at this long side at most: text smaller than that is too small to read. */
const MAX_SIDE = 1920
/** Small photos are enlarged up to this much, so their small text is as large as in a big photo. */
const MAX_UPSCALE = 2
const TILE_OVERLAP = 0.2
/** A pixel is text when the model's probability is above this. */
const PIXEL_THRESHOLD = 0.3
/** A region is kept when its mean probability is above this. */
const BOX_THRESHOLD = 0.6
/** How much the detected text core is grown, as in PaddleOCR (its "unclip ratio"). */
const UNCLIP_RATIO = 1.6
/** Regions thinner than this, in input pixels, are noise. */
const MIN_SIZE = 3

/** ImageNet statistics in the model's BGR channel order (PaddleOCR reads images with OpenCV). */
const MEAN = [0.406, 0.456, 0.485]
const STD = [0.225, 0.224, 0.229]

/** A crop of the image fed to the model: source rect in image pixels, drawn at `scale` into the input's top-left corner. */
export interface TextPass {
  sx: number
  sy: number
  sw: number
  sh: number
  scale: number
}

/** The whole image at input size (large text), then overlapping tiles up to MAX_SIDE (small text). */
export function planTextPasses(width: number, height: number): TextPass[] {
  const long = Math.max(width, height)
  const passes: TextPass[] = [{ sx: 0, sy: 0, sw: width, sh: height, scale: Math.min(1, TEXT_INPUT / long) }]
  const scale = Math.min(MAX_UPSCALE, MAX_SIDE / long)
  if (long * scale <= TEXT_INPUT * 1.3) return passes
  const tile = TEXT_INPUT / scale
  for (const sy of tileStarts(height, tile)) {
    for (const sx of tileStarts(width, tile)) {
      passes.push({ sx, sy, sw: Math.min(tile, width - sx), sh: Math.min(tile, height - sy), scale })
    }
  }
  return passes
}

function tileStarts(length: number, tile: number): number[] {
  if (length <= tile) return [0]
  const count = Math.ceil((length - tile) / (tile * (1 - TILE_OVERLAP))) + 1
  return Array.from({ length: count }, (_, i) => (i * (length - tile)) / (count - 1))
}

/** RGBA pixels of the input → normalised planar BGR. */
export function toTextTensor(rgba: Uint8ClampedArray, out: Float32Array): void {
  const n = TEXT_INPUT * TEXT_INPUT
  for (let i = 0; i < n; i++) {
    out[i] = (rgba[i * 4 + 2] / 255 - MEAN[0]) / STD[0]
    out[n + i] = (rgba[i * 4 + 1] / 255 - MEAN[1]) / STD[1]
    out[2 * n + i] = (rgba[i * 4] / 255 - MEAN[2]) / STD[2]
  }
}

/**
 * Boxes (in input pixels) from the model's probability map, limited to the `width` × `height` part of the
 * input that holds the image. Each connected text region gives one box, grown like PaddleOCR does — the
 * model outputs a shrunk core of each word or line. Boxes are axis-aligned: slanted text is covered by a
 * larger rectangle, never a smaller one.
 */
export function decodeTextMap(prob: Float32Array, size: number, width: number, height: number): Detection[] {
  const w = Math.min(size, Math.ceil(width))
  const h = Math.min(size, Math.ceil(height))
  const labels = new Int32Array(w * h)
  const stack: number[] = []
  const boxes: Detection[] = []
  let label = 0
  for (let start = 0; start < w * h; start++) {
    const sx = start % w
    const sy = (start - sx) / w
    if (labels[start] || prob[sy * size + sx] <= PIXEL_THRESHOLD) continue
    // Flood fill (8-connected) of one region.
    label++
    labels[start] = label
    stack.push(start)
    let x0 = sx
    let x1 = sx
    let y0 = sy
    let y1 = sy
    let sum = 0
    let count = 0
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i - x) / w
      sum += prob[y * size + x]
      count++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const j = ny * w + nx
          if (labels[j] || prob[ny * size + nx] <= PIXEL_THRESHOLD) continue
          labels[j] = label
          stack.push(j)
        }
      }
    }
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const score = sum / count
    if (Math.min(bw, bh) < MIN_SIZE || score < BOX_THRESHOLD) continue
    // PaddleOCR's unclip: offset = area × ratio / perimeter.
    const d = (bw * bh * UNCLIP_RATIO) / (2 * (bw + bh))
    boxes.push({ x: x0 - d, y: y0 - d, w: bw + 2 * d, h: bh + 2 * d, score })
  }
  return boxes
}

function intersection(a: Detection, b: Detection): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Text found by several passes (tile overlaps, whole image) gives overlapping boxes: a box mostly inside a
 * larger one is dropped, since the larger one already masks it.
 */
export function mergeTextBoxes(boxes: Detection[], containedThreshold = 0.7): Detection[] {
  const kept: Detection[] = []
  for (const b of [...boxes].sort((p, q) => q.w * q.h - p.w * p.h)) {
    if (!kept.some((k) => intersection(b, k) >= containedThreshold * b.w * b.h)) kept.push(b)
  }
  return kept
}
