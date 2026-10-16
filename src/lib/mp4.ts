// Metadata in MP4 / QuickTime (MOV) files: what a video carries, and removing it from exported files.
//
// The exported video is a new file written from the masked frames, so it carries none of the original's
// metadata (GPS position, device, date, sensor tracks). What the muxer writes itself (creation date,
// track names) is then neutralised in place, and the result is checked before being offered for saving.

interface Box {
  type: string
  /** Offset of the box header. */
  start: number
  /** Offset of the box content, after the header. */
  body: number
  end: number
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

/** Boxes laid out one after the other between `start` and `end`. */
function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const list: Box[] = []
  let at = start
  while (at + 8 <= end) {
    let size = u32(bytes, at)
    let header = 8
    if (size === 1) {
      if (at + 16 > end) throw new Error('MP4 tronqué')
      size = u32(bytes, at + 8) * 2 ** 32 + u32(bytes, at + 12)
      header = 16
    } else if (size === 0) {
      size = end - at
    }
    if (size < header || at + size > end) throw new Error('MP4 invalide')
    list.push({ type: ascii(bytes, at + 4, 4), start: at, body: at + header, end: at + size })
    at += size
  }
  return list
}

const children = (bytes: Uint8Array, box: Box) => boxes(bytes, box.body, box.end)

/** ISO `meta` boxes have 4 bytes of version and flags before their children; QuickTime ones do not. */
function metaChildren(bytes: Uint8Array, box: Box): Box[] {
  const quickTime = ascii(bytes, box.body + 4, 4) === 'hdlr'
  return boxes(bytes, quickTime ? box.body : box.body + 4, box.end)
}

/** Every key name of a QuickTime `meta` box (`com.apple.quicktime.location.ISO6709`, …). */
function metaKeys(bytes: Uint8Array, meta: Box): string[] {
  const keys = metaChildren(bytes, meta).find((b) => b.type === 'keys')
  if (!keys) return []
  const names: string[] = []
  for (const key of boxes(bytes, keys.body + 8, keys.end)) names.push(ascii(bytes, key.body, key.end - key.body))
  return names
}

function describeKey(name: string): string {
  if (/location|gps/i.test(name)) return 'position GPS'
  if (/make|model/i.test(name)) return 'marque et modèle de l’appareil'
  if (/date/i.test(name)) return 'date de prise de vue'
  if (/software|version/i.test(name)) return 'logiciel ou système de l’appareil'
  return 'informations d’enregistrement'
}

/** Children of a `udta` box (QuickTime user data). */
function describeUserData(type: string): string {
  if (type === '©xyz') return 'position GPS'
  if (type === '©mak' || type === '©mod') return 'marque et modèle de l’appareil'
  if (type === '©day') return 'date de prise de vue'
  if (type === '©swr' || type === '©too') return 'logiciel ou système de l’appareil'
  if (type === 'meta') return 'titre, auteur, commentaires'
  if (type === 'free' || type === 'skip') return ''
  return 'informations d’enregistrement'
}

/** mvhd / tkhd / mdhd: version, flags, then the creation and modification dates (32 or 64 bits each). */
function datesOf(bytes: Uint8Array, box: Box): { at: number; length: number } {
  return { at: box.body + 4, length: bytes[box.body] === 1 ? 16 : 8 }
}

function hasDate(bytes: Uint8Array, box: Box): boolean {
  const { at, length } = datesOf(bytes, box)
  return bytes.subarray(at, at + length).some((b) => b !== 0)
}

/** Handler type of a track (`vide`, `soun`, `meta`…), from mdia/hdlr. */
function handlerOf(bytes: Uint8Array, trak: Box): string {
  const mdia = children(bytes, trak).find((b) => b.type === 'mdia')
  const hdlr = mdia && children(bytes, mdia).find((b) => b.type === 'hdlr')
  return hdlr ? ascii(bytes, hdlr.body + 8, 4) : ''
}

function describeContainer(bytes: Uint8Array, box: Box): string[] {
  if (box.type === 'udta') return children(bytes, box).map((b) => describeUserData(b.type))
  if (box.type === 'meta') {
    const keys = metaKeys(bytes, box)
    return keys.length ? keys.map(describeKey) : ['titre, auteur, commentaires']
  }
  return []
}

/**
 * Human-readable list of the metadata found in an MP4 / MOV file (or in its non-media boxes only, see
 * `readMetadataBoxes`). Null when the bytes are not a readable MP4.
 */
export function findMp4Metadata(bytes: Uint8Array): string[] | null {
  let top: Box[]
  try {
    top = boxes(bytes, 0, bytes.length)
  } catch {
    return null
  }
  if (!top.some((b) => b.type === 'moov')) return null
  const found: string[] = []
  for (const box of top) {
    if (box.type === 'uuid') found.push('XMP ou données propriétaires')
    else if (box.type === 'udta' || box.type === 'meta') found.push(...describeContainer(bytes, box))
    if (box.type !== 'moov') continue
    for (const child of children(bytes, box)) {
      if (child.type === 'mvhd' && hasDate(bytes, child)) found.push('date de création')
      found.push(...describeContainer(bytes, child))
      if (child.type !== 'trak') continue
      const handler = handlerOf(bytes, child)
      if (handler !== 'vide' && handler !== 'soun') found.push('piste de données (capteurs, position…)')
      for (const part of children(bytes, child)) {
        if (part.type === 'tkhd' && hasDate(bytes, part)) found.push('date de création')
        found.push(...describeContainer(bytes, part))
        if (part.type === 'mdia') {
          const mdhd = children(bytes, part).find((b) => b.type === 'mdhd')
          if (mdhd && hasDate(bytes, mdhd)) found.push('date de création')
        }
      }
    }
  }
  return [...new Set(found.filter(Boolean))]
}

/**
 * Neutralises, in place, what the muxer writes about the export itself: dates set to zero, and user data
 * (`udta`, `meta`: track names, tags) turned into `free` padding. Sizes and offsets are unchanged, so the
 * media data stays valid.
 */
export function cleanMp4(bytes: Uint8Array): void {
  const erase = (box: Box) => {
    bytes.set([0x66, 0x72, 0x65, 0x65], box.start + 4) // 'free'
    bytes.fill(0, box.body, box.end)
  }
  const clearDates = (box: Box) => {
    const { at, length } = datesOf(bytes, box)
    bytes.fill(0, at, at + length)
  }
  for (const box of boxes(bytes, 0, bytes.length)) {
    if (box.type === 'udta' || box.type === 'meta' || box.type === 'uuid') erase(box)
    if (box.type !== 'moov') continue
    for (const child of children(bytes, box)) {
      if (child.type === 'mvhd') clearDates(child)
      if (child.type === 'udta' || child.type === 'meta') erase(child)
      if (child.type !== 'trak') continue
      for (const part of children(bytes, child)) {
        if (part.type === 'tkhd') clearDates(part)
        if (part.type === 'udta' || part.type === 'meta') erase(part)
        if (part.type === 'mdia') children(bytes, part).filter((b) => b.type === 'mdhd').forEach(clearDates)
      }
    }
  }
}

/** Top-level boxes holding the media itself, skipped when looking for metadata (they can be gigabytes). */
const MEDIA_BOXES = new Set(['mdat', 'free', 'skip', 'wide'])
const MAX_METADATA_BOX = 64 * 1024 * 1024

/**
 * Reads the non-media top-level boxes of a large file (`moov`, `udta`, `uuid`…) without loading the video
 * data, as a small MP4 for `findMp4Metadata`. Null when the file is not MP4 / MOV.
 */
export async function readMetadataBoxes(file: Blob): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = []
  let at = 0
  while (at + 8 <= file.size) {
    const head = new Uint8Array(await file.slice(at, at + 16).arrayBuffer())
    const type = ascii(head, 4, 4)
    if (!/^[\x20-\x7e©]{4}$/.test(type)) return null
    let size = u32(head, 0)
    if (size === 1) size = u32(head, 8) * 2 ** 32 + u32(head, 12)
    else if (size === 0) size = file.size - at
    if (size < 8) return null
    if (!MEDIA_BOXES.has(type)) {
      if (size > MAX_METADATA_BOX) return null
      parts.push(new Uint8Array(await file.slice(at, at + size).arrayBuffer()))
    }
    at += size
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
