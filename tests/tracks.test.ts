// Between two analysed frames, a moving face must stay covered on every frame.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTracks, keyframeBox, setKeyframe, zonesAt, type Box } from '../src/lib/tracks.ts'

const face = (x: number, y: number, size = 40, score = 0.9) => ({ x, y, w: size, h: size, score })

const contains = (outer: Box, inner: Box) =>
  outer.x <= inner.x + 1e-9 && outer.y <= inner.y + 1e-9 && outer.x + outer.w >= inner.x + inner.w - 1e-9 && outer.y + outer.h >= inner.y + inner.h - 1e-9

test('a face moving steadily is covered on every frame in between, even if missed once', () => {
  // Analysed every 0.1 s; the face moves 30 px per 0.1 s (most of its size) and is missed at t = 0.3.
  const frames = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map((t) => ({ t, detections: t === 0.3 ? [] : [face(300 * t, 50)] }))
  const tracking = buildTracks(frames)
  assert.equal(tracking.tracks.length, 1)
  for (let t = 0; t <= 0.5; t += 1 / 30) {
    const truth = face(300 * t, 50)
    const zones = zonesAt(tracking, t)
    assert.equal(zones.length, 1, `t=${t}`)
    assert.ok(contains(zones[0], truth), `t=${t}: face not covered`)
  }
})

test('two faces stay two tracks, and a far jump starts a new one', () => {
  const frames = [
    { t: 0, detections: [face(10, 10), face(400, 10)] },
    { t: 0.1, detections: [face(20, 10), face(390, 10)] },
    { t: 0.2, detections: [face(30, 10), face(900, 300)] },
  ]
  const { tracks } = buildTracks(frames)
  assert.equal(tracks.length, 3)
  assert.deepEqual(
    tracks.map((t) => t.points.length),
    [3, 2, 1],
  )
})

test('tracks are held one analysed frame beyond their ends, then dropped', () => {
  const frames = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((t) => ({ t, detections: t >= 0.2 && t <= 0.3 ? [face(100, 100)] : [] }))
  const tracking = buildTracks(frames)
  // Seen at 0.2 and 0.3: held as if also seen at 0.1 and 0.4, so it covers everything between 0 and 0.5.
  assert.equal(zonesAt(tracking, 0).length, 0)
  assert.equal(zonesAt(tracking, 0.05).length, 1)
  assert.equal(zonesAt(tracking, 0.1).length, 1)
  assert.equal(zonesAt(tracking, 0.45).length, 1)
  assert.equal(zonesAt(tracking, 0.5).length, 0)
  assert.equal(zonesAt(tracking, 0.55).length, 0)
})

test('a track carries its best score, so the sensitivity setting applies to the whole face', () => {
  const frames = [0.3, 0.8, 0.35].map((score, i) => ({ t: i / 10, detections: [face(100, 100, 40, score)] }))
  const { tracks } = buildTracks(frames)
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].score, 0.8)
})

test('track ids do not change as frames are appended', () => {
  const frames = [0, 0.1, 0.2, 0.3].map((t) => ({ t, detections: [face(10, 10), face(300 + t * 100, 10)] }))
  const partial = buildTracks(frames.slice(0, 2)).tracks.map((t) => [t.id, t.points[0].box.x])
  const full = buildTracks(frames).tracks.map((t) => [t.id, t.points[0].box.x])
  assert.deepEqual(full, partial)
})

test('a hand-placed zone slides between its keyframes and holds beyond them', () => {
  let keys = setKeyframe([], 1, { x: 0, y: 0, w: 10, h: 10 }, 0.01)
  keys = setKeyframe(keys, 3, { x: 100, y: 50, w: 30, h: 10 }, 0.01)
  keys = setKeyframe(keys, 2, { x: 10, y: 10, w: 10, h: 10 }, 0.01)
  keys = setKeyframe(keys, 2.004, { x: 50, y: 20, w: 20, h: 10 }, 0.01) // same frame: replaced
  assert.deepEqual(keys.map((k) => k.t), [1, 2.004, 3])
  assert.deepEqual(keyframeBox(keys, 0), { x: 0, y: 0, w: 10, h: 10 })
  assert.deepEqual(keyframeBox(keys, 9), { x: 100, y: 50, w: 30, h: 10 })
  const mid = keyframeBox(keys, (2.004 + 3) / 2)
  assert.ok(Math.abs(mid.x - 75) < 1e-9 && Math.abs(mid.y - 35) < 1e-9 && Math.abs(mid.w - 25) < 1e-9)
})
