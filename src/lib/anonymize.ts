// Irreversible face masking.
//
// Both methods replace the pixels of each face ("core" = detected box + margin) with content computed
// WITHOUT reading them: a field interpolated from the pixels *around* the faces, or a solid colour.
// A classic blur or mosaic keeps a degraded copy of the face that AI models can exploit; here nothing of
// the face remains in the output, so there is nothing to recover.

export type Method = 'blur' | 'solid'
export type Shape = 'ellipse' | 'rect'

export interface MaskOptions {
  method: Method
  shape: Shape
  /** Extra coverage around the detected box, as a fraction of its size on each side. */
  margin: number
  /** CSS colour for the `solid` method. */
  color: string
}

/** A face (shape, margin and forehead from the settings) or any other area: text, plate, tattoo… masked as the rectangle it is. */
export type ZoneKind = 'face' | 'area'

export interface MaskZone {
  x: number
  y: number
  w: number
  h: number
  /** Keeps the random grain of a zone identical between the preview and the export. */
  seed: number
  /** 'face' when absent. */
  kind?: ZoneKind
}


/** Half-axis of the ellipse relative to the box size, before the margin. With the default 10 % margin the ellipse contains the box's corners. */
const ELLIPSE_BASE = 0.63
/** The detector's box stops around the eyebrows: the core extends this much further up (fraction of the height) to cover the forehead. */
const FOREHEAD = 0.12
/** Soft edge of the blur, drawn OUTSIDE the core so it never lets face pixels through. In units of the core radius. */
const FEATHER = 0.2
/** Band around the core whose pixels feed the fill, in units of the core radius. */
const RING = 0.35
/** Resolution of the interpolated field across the core. */
const FIELD_CELLS = 20
const FIELD_ITERATIONS = 160
/** Samples per field cell side when averaging the surroundings: enough for a mean, far cheaper than every pixel. */
const SAMPLES_PER_CELL = 4
/** Extra coverage around an area (text, plate…), as a fraction of its smaller side. */
const AREA_MARGIN = 0.15

interface Core {
  cx: number
  cy: number
  rx: number
  ry: number
  ellipse: boolean
  seed: number
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export function coreOf(zone: MaskZone, options: Pick<MaskOptions, 'shape' | 'margin'>): Core {
  if (zone.kind === 'area') {
    const pad = AREA_MARGIN * Math.min(zone.w, zone.h)
    return { cx: zone.x + zone.w / 2, cy: zone.y + zone.h / 2, rx: zone.w / 2 + pad, ry: zone.h / 2 + pad, ellipse: false, seed: zone.seed }
  }
  const ellipse = options.shape === 'ellipse'
  const base = ellipse ? ELLIPSE_BASE : 0.5
  return {
    cx: zone.x + zone.w / 2,
    cy: zone.y + zone.h / 2 - (zone.h * FOREHEAD) / 2,
    rx: zone.w * (base + options.margin),
    ry: zone.h * (base + options.margin + FOREHEAD / 2),
    ellipse,
    seed: zone.seed,
  }
}

/** Squared normalised distance to the core centre for an ellipse (Chebyshev for a rectangle, squared too): < 1 inside. */
function distance2(core: Core, x: number, y: number): number {
  const dx = (x - core.cx) / core.rx
  const dy = (y - core.cy) / core.ry
  return core.ellipse ? dx * dx + dy * dy : Math.max(dx * dx, dy * dy)
}

/** Masks every zone on the canvas in place. Zones are in canvas pixels. */
export function applyMask(ctx: Context, zones: MaskZone[], options: MaskOptions): void {
  const cores = zones.filter((z) => z.w > 0 && z.h > 0).map((z) => coreOf(z, options))
  if (options.method === 'solid') {
    ctx.save()
    ctx.fillStyle = options.color
    for (const c of cores) {
      ctx.beginPath()
      if (c.ellipse) ctx.ellipse(c.cx, c.cy, c.rx, c.ry, 0, 0, Math.PI * 2)
      else ctx.rect(c.cx - c.rx, c.cy - c.ry, c.rx * 2, c.ry * 2)
      ctx.fill()
    }
    ctx.restore()
    return
  }
  for (const core of cores) fillCore(ctx, core, cores)
}

/** Pixel area read and written for one core: the core, its feather and the ring of surroundings. */
interface Region {
  x0: number
  y0: number
  width: number
  height: number
  px: Uint8ClampedArray
}

function fillCore(ctx: Context, core: Core, cores: Core[]): void {
  const reach = 1 + FEATHER + RING
  const x0 = Math.max(0, Math.floor(core.cx - core.rx * reach))
  const y0 = Math.max(0, Math.floor(core.cy - core.ry * reach))
  const x1 = Math.min(ctx.canvas.width, Math.ceil(core.cx + core.rx * reach))
  const y1 = Math.min(ctx.canvas.height, Math.ceil(core.cy + core.ry * reach))
  if (x1 <= x0 || y1 <= y0) return

  const image = ctx.getImageData(x0, y0, x1 - x0, y1 - y0)
  const region: Region = { x0, y0, width: image.width, height: image.height, px: image.data }
  // Pixels of ANY face are excluded from the field, otherwise a neighbouring face would bleed into this fill.
  const near = cores.filter((c) => c.cx + c.rx > x0 && c.cx - c.rx < x1 && c.cy + c.ry > y0 && c.cy - c.ry < y1)
  paintBlur(region, core, surroundingsField(region, core, near))
  ctx.putImageData(image, x0, y0)
}

/** Coarse colour grid over the region: averages of the pixels outside every core, interpolated across the cores. */
interface Field {
  values: Float32Array
  gw: number
  gh: number
  cell: number
  x0: number
  y0: number
}

function surroundingsField(region: Region, core: Core, near: Core[]): Field {
  const { x0, y0, width, height, px } = region
  // Sized on the larger radius, but at most twice the smaller one: a long line of text still gets several
  // cells across its height, so its fill comes from above and below it.
  const radius = Math.min(Math.max(core.rx, core.ry), 2 * Math.min(core.rx, core.ry))
  const cell = Math.max(1, (2 * radius) / FIELD_CELLS)
  const gw = Math.ceil(width / cell)
  const gh = Math.ceil(height / cell)
  const cells = gw * gh

  // 1. Average the surroundings, from pixels outside every core.
  const step = Math.max(1, Math.floor(cell / SAMPLES_PER_CELL))
  const sums = new Float64Array(cells * 3)
  const seen = new Uint32Array(cells)
  const total = new Uint32Array(cells)
  for (let y = 0; y < height; y += step) {
    const row = Math.floor(y / cell) * gw
    for (let x = 0; x < width; x += step) {
      const g = row + Math.floor(x / cell)
      total[g]++
      if (near.some((c) => distance2(c, x0 + x + 0.5, y0 + y + 0.5) < 1)) continue
      const i = (y * width + x) * 4
      seen[g]++
      sums[g * 3] += px[i]
      sums[g * 3 + 1] += px[i + 1]
      sums[g * 3 + 2] += px[i + 2]
    }
  }

  // 2. Cells mostly covered by faces are unknown: fill them by harmonic interpolation from the known ones
  //    (successive over-relaxation), which gives the smooth, out-of-focus look of a strong blur.
  const values = new Float32Array(cells * 3)
  const known = new Uint8Array(cells)
  const mean = [0, 0, 0]
  let knownCount = 0
  for (let g = 0; g < cells; g++) {
    // Empty cells (the grid overhangs the region by a fraction of a cell) are interpolated like face cells.
    if (seen[g] === 0 || seen[g] * 2 < total[g]) continue
    known[g] = 1
    knownCount++
    for (let c = 0; c < 3; c++) {
      values[g * 3 + c] = sums[g * 3 + c] / seen[g]
      mean[c] += values[g * 3 + c]
    }
  }
  for (let c = 0; c < 3; c++) mean[c] = knownCount ? mean[c] / knownCount : 128
  const unknown: number[] = []
  const neighbours: number[][] = []
  for (let g = 0; g < cells; g++) {
    if (known[g]) continue
    for (let c = 0; c < 3; c++) values[g * 3 + c] = mean[c]
    const gx = g % gw
    const gy = Math.floor(g / gw)
    unknown.push(g)
    neighbours.push([gx > 0 && g - 1, gx < gw - 1 && g + 1, gy > 0 && g - gw, gy < gh - 1 && g + gw].filter((n) => n !== false))
  }
  if (knownCount) {
    for (let it = 0; it < FIELD_ITERATIONS; it++) {
      for (let k = 0; k < unknown.length; k++) {
        const g = unknown[k]
        const around = neighbours[k]
        for (let c = 0; c < 3; c++) {
          let sum = 0
          for (const n of around) sum += values[n * 3 + c]
          const v = values[g * 3 + c]
          values[g * 3 + c] = v + 1.8 * (sum / around.length - v)
        }
      }
    }
  }
  return { values, gw, gh, cell, x0, y0 }
}

/** Bilinear sample of the field at image coordinates. */
function sampleField(field: Field, x: number, y: number, out: Float32Array): void {
  const { values, gw, gh, cell } = field
  const fx = Math.min(gw - 1, Math.max(0, (x - field.x0) / cell - 0.5))
  const fy = Math.min(gh - 1, Math.max(0, (y - field.y0) / cell - 0.5))
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const ix1 = Math.min(gw - 1, ix + 1)
  const iy1 = Math.min(gh - 1, iy + 1)
  const tx = fx - ix
  const ty = fy - iy
  const a = (iy * gw + ix) * 3
  const b = (iy * gw + ix1) * 3
  const c = (iy1 * gw + ix) * 3
  const d = (iy1 * gw + ix1) * 3
  for (let k = 0; k < 3; k++) {
    const top = values[a + k] + (values[b + k] - values[a + k]) * tx
    const bottom = values[c + k] + (values[d + k] - values[c + k]) * tx
    out[k] = top + (bottom - top) * ty
  }
}

/** Pixel bounds of the core scaled by `scale`, clipped to the region. */
function bounds(region: Region, core: Core, scale: number) {
  return {
    left: Math.max(0, Math.floor(core.cx - core.rx * scale) - region.x0),
    top: Math.max(0, Math.floor(core.cy - core.ry * scale) - region.y0),
    right: Math.min(region.width, Math.ceil(core.cx + core.rx * scale) - region.x0),
    bottom: Math.min(region.height, Math.ceil(core.cy + core.ry * scale) - region.y0),
  }
}

/** The surroundings field over the core, with a feathered edge. */
function paintBlur(region: Region, core: Core, field: Field): void {
  const { x0, y0, width, px } = region
  const { left, top, right, bottom } = bounds(region, core, 1 + FEATHER)
  const outer2 = (1 + FEATHER) * (1 + FEATHER)
  const random = mulberry32(core.seed)
  const color = new Float32Array(3)
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const ix = x0 + x + 0.5
      const iy = y0 + y + 0.5
      const d2 = distance2(core, ix, iy)
      if (d2 >= outer2) continue
      const alpha = d2 < 1 ? 1 : smoothstep(1 - (Math.sqrt(d2) - 1) / FEATHER)
      sampleField(field, ix, iy, color)
      const grain = (random() - 0.5) * 6
      const i = (y * width + x) * 4
      for (let c = 0; c < 3; c++) px[i + c] = px[i + c] * (1 - alpha) + (color[c] + grain) * alpha
    }
  }
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
