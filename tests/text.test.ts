import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TEXT_INPUT, decodeTextMap, mergeTextBoxes, planTextPasses } from '../src/lib/text.ts'

test('one box per text region, grown like PaddleOCR; faint regions are dropped', () => {
  const size = 64
  const map = new Float32Array(size * size)
  const fill = (x0: number, y0: number, w: number, h: number, p: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) map[y * size + x] = p
  }
  fill(5, 10, 10, 4, 0.9) // a word
  fill(30, 30, 6, 6, 0.4) // above the pixel threshold, below the region threshold
  fill(50, 50, 8, 8, 0.9) // outside the part of the input that holds the image
  const boxes = decodeTextMap(map, size, 40, 40)
  assert.equal(boxes.length, 1)
  const d = (10 * 4 * 1.6) / (2 * 14)
  const [box] = boxes
  assert.ok(Math.abs(box.x - (5 - d)) < 1e-6 && Math.abs(box.y - (10 - d)) < 1e-6)
  assert.ok(Math.abs(box.w - (10 + 2 * d)) < 1e-6 && Math.abs(box.h - (4 + 2 * d)) < 1e-6)
  assert.ok(Math.abs(box.score - 0.9) < 1e-6)
})

test('text found by overlapping passes is kept once, by its largest box', () => {
  const merged = mergeTextBoxes([
    { x: 10, y: 10, w: 100, h: 20, score: 0.8 },
    { x: 12, y: 11, w: 60, h: 18, score: 0.9 }, // same text, cut by a tile border
    { x: 200, y: 10, w: 50, h: 20, score: 0.7 },
  ])
  assert.deepEqual(merged.map((b) => b.x), [10, 200])
})

test('passes cover the whole image, in input-sized pieces', () => {
  for (const [width, height] of [[400, 300], [800, 600], [4032, 3024], [3000, 1000], [1080, 1920]]) {
    const passes = planTextPasses(width, height)
    for (const p of passes) assert.ok(p.sw * p.scale <= TEXT_INPUT + 1e-6 && p.sh * p.scale <= TEXT_INPUT + 1e-6)
    for (let y = 0; y < height; y += 37) {
      for (let x = 0; x < width; x += 37) {
        assert.ok(passes.some((p) => x >= p.sx && x <= p.sx + p.sw && y >= p.sy && y <= p.sy + p.sh), `${width}×${height}: (${x},${y})`)
      }
    }
    // Small photos are enlarged (up to 2×) for their small text; tiny ones fit in a single pass.
    assert.equal(passes.length === 1, Math.max(width, height) * 2 <= TEXT_INPUT * 1.3, `${width}×${height}: ${passes.length} passes`)
  }
})
