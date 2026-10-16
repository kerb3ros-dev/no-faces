// Irreversibility check: the masked output must not depend AT ALL on the pixels inside any face zone.
// If changing the faces' pixels changes a single output byte, information about a face leaks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyMask, coreOf, type MaskOptions, type MaskZone } from '../src/lib/anonymize.ts'

const W = 320
const H = 240

/** Just enough of CanvasRenderingContext2D for the pixel-based methods. */
function fakeContext(pixels: Uint8ClampedArray) {
  return {
    canvas: { width: W, height: H },
    getImageData(x: number, y: number, w: number, h: number) {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let row = 0; row < h; row++) data.set(pixels.subarray(((y + row) * W + x) * 4, ((y + row) * W + x + w) * 4), row * w * 4)
      return { data, width: w, height: h }
    },
    putImageData(image: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) {
      for (let row = 0; row < image.height; row++) pixels.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * W + x) * 4)
    },
  } as unknown as CanvasRenderingContext2D
}

function randomImage(seed: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4)
  let s = seed
  for (let i = 0; i < px.length; i++) px[i] = i % 4 === 3 ? 255 : (s = (s * 1103515245 + 12345) & 0x7fffffff) & 255
  return px
}

// Two overlapping faces, two faces a few pixels apart (each one sits in the other's surroundings, the
// riskiest case), one cut by the image border, and areas: a long thin line of text and a plate next to a face.
const zones: MaskZone[] = [
  { x: 20, y: 30, w: 50, h: 60, seed: 1 },
  { x: 72, y: 35, w: 45, h: 55, seed: 2 },
  { x: 60, y: 150, w: 50, h: 60, seed: 3 },
  { x: 156, y: 150, w: 50, h: 60, seed: 4 },
  { x: 290, y: 10, w: 40, h: 40, seed: 5 },
  { x: 130, y: 105, w: 170, h: 12, seed: 6, kind: 'area' },
  { x: 212, y: 175, w: 44, h: 18, seed: 7, kind: 'area' },
]

for (const shape of ['ellipse', 'rect'] as const) {
  for (const margin of [0, 0.1, 0.3]) {
    test(`blur/${shape}/margin ${margin}: output is independent of the faces' pixels`, () => {
      const options: MaskOptions = { method: 'blur', shape, margin, color: '#000' }
      const cores = zones.map((z) => coreOf(z, options))
      const inFace = (x: number, y: number) =>
        cores.some((c) => {
          const dx = Math.abs(x + 0.5 - c.cx) / c.rx
          const dy = Math.abs(y + 0.5 - c.cy) / c.ry
          return (c.ellipse ? Math.hypot(dx, dy) : Math.max(dx, dy)) < 1
        })

      const base = randomImage(42)
      const a = base.slice()
      const b = base.slice()
      // Same background, opposite faces: black in one image, white in the other. (Random noise would be a
      // weak test: once averaged, two noise patterns look alike and a leak would hide in the rounding.)
      let changed = 0
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!inFace(x, y)) continue
          const i = (y * W + x) * 4
          a.fill(0, i, i + 3)
          b.fill(255, i, i + 3)
          changed++
        }
      }
      assert.ok(changed > 3000)

      applyMask(fakeContext(a), zones, options)
      applyMask(fakeContext(b), zones, options)
      let leaked = 0
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) leaked++
      assert.equal(leaked, 0, `${leaked} output bytes depend on the faces' pixels`)
    })
  }
}

test('the fill matches plain surroundings at any zone size (no holes in the field)', () => {
  // Sizes chosen so the field grid overhangs the region by a fraction of a cell.
  for (const size of [17, 23, 31, 37, 41, 53, 61, 77, 89]) {
    for (const shape of ['ellipse', 'rect'] as const) {
      const options: MaskOptions = { method: 'blur', shape, margin: 0.1, color: '#000' }
      const px = new Uint8ClampedArray(W * H * 4).fill(200)
      const zone = { x: 150 - size / 2, y: 110 - size / 2, w: size, h: size * 1.2, seed: size }
      applyMask(fakeContext(px), [zone], options)
      const core = coreOf(zone, options)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const dx = Math.abs(x + 0.5 - core.cx) / core.rx
          const dy = Math.abs(y + 0.5 - core.cy) / core.ry
          if ((core.ellipse ? Math.hypot(dx, dy) : Math.max(dx, dy)) >= 1) continue
          const value = px[(y * W + x) * 4]
          assert.ok(Math.abs(value - 200) <= 16, `${shape} size ${size}: pixel (${x},${y}) is ${value}, expected ≈200`)
        }
      }
    }
  }
})

test('from the default margin up, the whole detected box is covered', () => {
  const zone = { x: 100, y: 50, w: 80, h: 100, seed: 1 }
  for (const shape of ['ellipse', 'rect'] as const) {
    for (const margin of [0.1, 0.2, 0.5]) {
      const core = coreOf(zone, { shape, margin })
      for (const [x, y] of [[zone.x, zone.y], [zone.x + zone.w, zone.y], [zone.x, zone.y + zone.h], [zone.x + zone.w, zone.y + zone.h]]) {
        const dx = Math.abs(x - core.cx) / core.rx
        const dy = Math.abs(y - core.cy) / core.ry
        assert.ok((core.ellipse ? Math.hypot(dx, dy) : Math.max(dx, dy)) < 1, `${shape} margin ${margin}: corner (${x},${y}) not covered`)
      }
    }
  }
})

test('an area (text, plate) is covered entirely, whatever the face settings', () => {
  for (const zone of [
    { x: 100, y: 50, w: 300, h: 14, seed: 1, kind: 'area' as const },
    { x: 10, y: 10, w: 40, h: 90, seed: 2, kind: 'area' as const },
  ]) {
    for (const shape of ['ellipse', 'rect'] as const) {
      const core = coreOf(zone, { shape, margin: 0 })
      assert.equal(core.ellipse, false)
      for (const [x, y] of [[zone.x, zone.y], [zone.x + zone.w, zone.y + zone.h]]) {
        assert.ok(Math.abs(x - core.cx) < core.rx && Math.abs(y - core.cy) < core.ry, `${shape}: corner (${x},${y}) not covered`)
      }
    }
  }
})

test('a long line of text is filled from what is above and below it', () => {
  // Red above the line, blue below: the fill must blend both, not fall back to a flat average grey.
  const px = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      px.set(y < 120 ? [220, 30, 30, 255] : [30, 30, 220, 255], i)
    }
  }
  const zone = { x: 20, y: 114, w: 280, h: 12, seed: 3, kind: 'area' as const }
  applyMask(fakeContext(px), [zone], { method: 'blur', shape: 'ellipse', margin: 0.1, color: '#000' })
  const at = (x: number, y: number) => [...px.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]
  assert.ok(at(160, 112)[0] > at(160, 112)[2], 'top of the line should lean red')
  assert.ok(at(160, 127)[2] > at(160, 127)[0], 'bottom of the line should lean blue')
})
