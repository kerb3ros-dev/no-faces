import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanMp4, findMp4Metadata } from '../src/lib/mp4.ts'

const text = (s: string) => [...s].map((c) => c.charCodeAt(0))
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const box = (type: string, ...content: number[][]) => {
  const body = content.flat()
  return [...u32(body.length + 8), ...text(type), ...body]
}

/** Version 0: version/flags, creation and modification dates, then the rest. */
const dated = (type: string, date: number) => box(type, [0, 0, 0, 0], u32(date), u32(date), new Array(12).fill(7))
const hdlr = (handler: string) => box('hdlr', [0, 0, 0, 0, 0, 0, 0, 0], text(handler), new Array(12).fill(0))
const trak = (handler: string, ...extra: number[][]) =>
  box('trak', dated('tkhd', 3_700_000_000), box('mdia', dated('mdhd', 3_700_000_000), hdlr(handler)), ...extra)

/** An iPhone-like MOV: dates, GPS and device in udta and in a QuickTime meta/keys box, a sensor track. */
function iphoneMov(): Uint8Array {
  const keys = box('keys', [0, 0, 0, 0], u32(2), box('mdta', text('com.apple.quicktime.location.ISO6709')), box('mdta', text('com.apple.quicktime.model')))
  return Uint8Array.from([
    ...box('ftyp', text('qt  '), u32(0)),
    ...box('wide'),
    ...box('mdat', [1, 2, 3, 4, 5, 6]),
    ...box(
      'moov',
      dated('mvhd', 3_700_000_000),
      trak('vide', box('udta', box('name', text('Core Media Video')))),
      trak('soun'),
      trak('meta'),
      box('udta', box('©xyz', text('+48.8584+002.2945/')), box('©mak', text('Apple'))),
      box('meta', hdlr('mdta'), keys),
    ),
  ])
}

test('lists what a MOV carries', () => {
  assert.deepEqual(findMp4Metadata(iphoneMov()), [
    'date de création',
    'informations d’enregistrement',
    'piste de données (capteurs, position…)',
    'position GPS',
    'marque et modèle de l’appareil',
  ])
})

test('cleaning leaves no metadata and keeps the media data and file size', () => {
  const file = iphoneMov()
  const size = file.length
  cleanMp4(file)
  assert.equal(file.length, size)
  // Only the sensor track remains, which the exporter never writes.
  assert.deepEqual(findMp4Metadata(file), ['piste de données (capteurs, position…)'])
  const mdat = file.indexOf(0x6d) // 'm' of the first 'mdat'
  assert.equal(String.fromCharCode(...file.subarray(mdat, mdat + 4)), 'mdat')
  assert.deepEqual([...file.subarray(mdat + 4, mdat + 10)], [1, 2, 3, 4, 5, 6])
  const asText = String.fromCharCode(...file)
  for (const leak of ['48.8584', 'Apple', 'Core Media', 'ISO6709']) assert.ok(!asText.includes(leak), leak)
})

test('a clean export has nothing to report', () => {
  const file = Uint8Array.from([...box('ftyp', text('isom')), ...box('moov', dated('mvhd', 0), trak('vide')), ...box('mdat', [9])])
  cleanMp4(file)
  assert.deepEqual(findMp4Metadata(file), [])
})

test('not an MP4', () => {
  assert.equal(findMp4Metadata(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 1])), null)
})
