import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findMetadata, stripMetadata } from '../src/lib/metadata.ts'

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))

const segment = (marker: number, body: Uint8Array) => bytes([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff], [...body])

/** Little-endian TIFF with an IFD0 holding Make, DateTime and a GPS pointer, followed by a thumbnail IFD. */
function exif(): Uint8Array {
  const entry = (tag: number) => [tag & 0xff, tag >> 8, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0]
  return bytes('Exif\0\0', 'II', [42, 0, 8, 0, 0, 0], [3, 0], entry(0x010f), entry(0x0132), entry(0x8825), [60, 0, 0, 0], [0, 0, 0, 0, 0, 0])
}

function jpeg(): Uint8Array {
  return bytes(
    [0xff, 0xd8],
    [...segment(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]))],
    [...segment(0xe1, exif())],
    [...segment(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0<x/>'))],
    [...segment(0xe2, bytes('ICC_PROFILE\0', [1, 1]))],
    [...segment(0xe2, bytes('MPF\0', [0]))],
    [...segment(0xed, bytes('Photoshop 3.0\0'))],
    [...segment(0xfe, bytes('hello'))],
    [...segment(0xdb, bytes([0, ...new Array(64).fill(1)]))],
    [...segment(0xc0, bytes([8, 0, 1, 0, 1, 1, 1, 0x11, 0]))],
    [...segment(0xda, bytes([1, 1, 0, 0, 63, 0]))],
    [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56], // entropy data with stuffing and a restart marker
    [0xff, 0xd9],
    'motion-photo-video',
  )
}

test('lists what a JPEG carries', () => {
  assert.deepEqual(findMetadata(jpeg()), [
    'EXIF',
    'position GPS',
    'marque et modèle de l’appareil',
    'date et réglages de prise de vue',
    'miniature de la photo d’origine',
    'XMP (informations d’édition, auteur…)',
    'profil couleur',
    'images secondaires intégrées',
    'IPTC (légende, auteur, lieu…)',
    'commentaire',
    'données cachées après l’image (vidéo « Live » ou autre)',
  ])
})

test('a stripped JPEG keeps the image data and nothing else', () => {
  const stripped = stripMetadata(jpeg())
  assert.deepEqual(findMetadata(stripped), [])
  const text = String.fromCharCode(...stripped)
  for (const needle of ['JFIF', 'Exif', 'http', 'ICC_PROFILE', 'MPF', 'Photoshop', 'hello', 'motion']) assert.ok(!text.includes(needle), needle)
  // SOI, DQT, SOF0, SOS + entropy data, EOI
  assert.equal(stripped.length, 2 + 69 + 13 + 10 + 7 + 2)
  assert.deepEqual([...stripped.subarray(-9)], [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9])
})

function png(): Uint8Array {
  const chunk = (type: string, data: number[] | string) => {
    const body = bytes(data)
    return bytes([0, 0, body.length >> 8, body.length & 0xff], type, [...body], [0, 0, 0, 0])
  }
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    [...chunk('IHDR', new Array(13).fill(1))],
    [...chunk('iCCP', 'icc')],
    [...chunk('tEXt', 'Author\0me')],
    [...chunk('eXIf', 'MM')],
    [...chunk('tIME', [7, 0xe9, 1, 1, 0, 0, 0])],
    [...chunk('IDAT', [1, 2, 3])],
    [...chunk('IEND', [])],
  )
}

test('PNG: lists and strips everything but the image chunks', () => {
  assert.deepEqual(findMetadata(png()), ['profil couleur', 'texte (auteur, logiciel, commentaire…)', 'EXIF', 'date de modification'])
  const stripped = stripMetadata(png())
  assert.deepEqual(findMetadata(stripped), [])
  assert.equal(stripped.length, 8 + 25 + 15 + 12)
})

test('other formats are reported as unknown and never "stripped" blindly', () => {
  const webp = bytes('RIFF', [0, 0, 0, 0], 'WEBP')
  assert.equal(findMetadata(webp), null)
  assert.throws(() => stripMetadata(webp))
})
