import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isHeic } from '../src/lib/heic.ts'
import { findMetadata } from '../src/lib/metadata.ts'

const bytes = (...parts: (number[] | string | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : [...p])))
const u16 = (n: number) => [n >> 8, n & 0xff]
const u32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const box = (type: string, ...content: (number[] | string | Uint8Array)[]) => {
  const body = bytes(...content)
  return bytes(u32(body.length + 8), type, body)
}
const fullBox = (type: string, version: number, ...content: (number[] | string | Uint8Array)[]) => box(type, [version, 0, 0, 0], ...content)
const ftyp = (major: string, ...compatible: string[]) => box('ftyp', major, u32(0), ...compatible)

/** Little-endian TIFF with an IFD0 holding Make, DateTime and a GPS pointer. */
function tiff(): Uint8Array {
  const entry = (tag: number) => [tag & 0xff, tag >> 8, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0]
  return bytes('II', [42, 0, 8, 0, 0, 0], [3, 0], entry(0x010f), entry(0x0132), entry(0x8825), [0, 0, 0, 0])
}

/** An iPhone-like HEIC: image, EXIF and XMP items, a thumbnail and an auxiliary (depth) image. */
function heic(): Uint8Array {
  // EXIF item: offset to the TIFF header, then "Exif\0\0" and the TIFF data.
  const exif = bytes(u32(6), 'Exif\0\0', tiff())
  const head = ftyp('heic', 'mif1', 'heic')
  const meta = (exifOffset: number) =>
    fullBox(
      'meta',
      0,
      fullBox('iinf', 0, u16(3), fullBox('infe', 2, u16(1), u16(0), 'hvc1', [0]), fullBox('infe', 2, u16(2), u16(0), 'Exif', [0]), fullBox('infe', 2, u16(3), u16(0), 'mime', [0], 'application/rdf+xml', [0])),
      fullBox('iref', 0, box('thmb', u16(4), u16(1), u16(1)), box('auxl', u16(5), u16(1), u16(1))),
      // Version 1, 4-byte offsets and lengths, one item.
      fullBox('iloc', 1, [0x44, 0x00], u16(1), u16(2), u16(0), u16(0), u16(1), u32(exifOffset), u32(exif.length)),
    )
  const offset = head.length + meta(0).length + 8
  return bytes(head, meta(offset), box('mdat', exif))
}

test('recognises HEIC files, leaves AVIF and JPEG to the browser', () => {
  assert.equal(isHeic(heic()), true)
  assert.equal(isHeic(ftyp('mif1', 'mif1', 'heic')), true)
  assert.equal(isHeic(ftyp('avif', 'mif1', 'avif', 'miaf')), false)
  assert.equal(isHeic(bytes([0xff, 0xd8, 0xff, 0xe0], new Array(20).fill(0))), false)
})

test('lists what a HEIC carries', () => {
  assert.deepEqual(findMetadata(heic()), [
    'miniature de la photo d’origine',
    'images secondaires intégrées',
    'EXIF',
    'position GPS',
    'marque et modèle de l’appareil',
    'date et réglages de prise de vue',
    'XMP (informations d’édition, auteur…)',
  ])
})

test('a HEIC without metadata lists nothing', () => {
  const head = ftyp('heic', 'mif1', 'heic')
  assert.deepEqual(findMetadata(bytes(head, fullBox('meta', 0, fullBox('iinf', 0, u16(1), fullBox('infe', 2, u16(1), u16(0), 'hvc1', [0]))), box('mdat', [1, 2, 3]))), [])
})
