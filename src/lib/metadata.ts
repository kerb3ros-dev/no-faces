// Metadata in image files: what a photo carries, and removing all of it from exported files.
//
// Re-encoding through a canvas already leaves EXIF, XMP and IPTC behind, but browsers still write a few
// blocks of their own (colour profile, PNG chunks). Exports keep the image data and nothing else, and are
// re-checked before being offered for saving.

/** Human-readable list of the metadata found, or null when the format is not JPEG, PNG or HEIF. */
export function findMetadata(bytes: Uint8Array): string[] | null {
  if (isJpeg(bytes)) return unique(jpegSegments(bytes).flatMap((s) => describeJpegSegment(bytes, s)))
  if (isPng(bytes)) return unique(pngChunks(bytes).flatMap((c) => describePngChunk(c.type)))
  if (isHeif(bytes)) return unique(heifMetadata(bytes))
  return null
}

/** Copy of the file with only the image data. Throws on anything but JPEG/PNG. */
export function stripMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (isJpeg(bytes)) {
    const kept = jpegSegments(bytes).filter((s) => !isJpegMetadata(s.marker))
    return concat([bytes.subarray(0, 2), ...kept.map((s) => bytes.subarray(s.start, s.end))])
  }
  if (isPng(bytes)) {
    const kept = pngChunks(bytes).filter((c) => PNG_IMAGE_CHUNKS.has(c.type))
    return concat([bytes.subarray(0, 8), ...kept.map((c) => bytes.subarray(c.start, c.end))])
  }
  throw new Error('Format d’image inattendu')
}

function unique(labels: string[]): string[] {
  return [...new Set(labels)]
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

// --- JPEG ---------------------------------------------------------------------------------------------

const EOI = 0xd9
const SOS = 0xda
/** Pseudo-marker for bytes after the end of the image (Samsung / Google "motion photo" videos, etc.). */
const TRAILER = -1

interface JpegSegment {
  marker: number
  start: number
  end: number
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8
}

/** APPn blocks (EXIF, XMP, ICC, MPF…), comments and anything after the image. */
function isJpegMetadata(marker: number): boolean {
  return (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe || marker === TRAILER
}

/** Every segment after SOI. Entropy-coded data is attached to the SOS segment before it. */
function jpegSegments(bytes: Uint8Array): JpegSegment[] {
  const segments: JpegSegment[] = []
  let i = 2
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('JPEG invalide')
    const marker = bytes[i + 1]
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === EOI) {
      segments.push({ marker, start: i, end: i + 2 })
      if (i + 2 < bytes.length) segments.push({ marker: TRAILER, start: i + 2, end: bytes.length })
      return segments
    }
    const start = i
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3])
    if (marker === SOS) {
      // Skip the compressed data: inside it 0xFF is only ever followed by 0x00 (stuffing) or a restart marker.
      while (i + 1 < bytes.length && !(bytes[i] === 0xff && bytes[i + 1] !== 0 && (bytes[i + 1] < 0xd0 || bytes[i + 1] > 0xd7))) i++
    }
    segments.push({ marker, start, end: Math.min(i, bytes.length) })
  }
  throw new Error('JPEG tronqué')
}

function describeJpegSegment(bytes: Uint8Array, segment: JpegSegment): string[] {
  const { marker, start, end } = segment
  if (marker === TRAILER) return ['données cachées après l’image (vidéo « Live » ou autre)']
  if (marker === 0xfe) return ['commentaire']
  if (marker < 0xe0 || marker > 0xef) return []
  const body = start + 4
  if (marker === 0xe0 && ascii(bytes, body, 5) === 'JFIF\0') return []
  if (marker === 0xe1 && ascii(bytes, body, 6) === 'Exif\0\0') return ['EXIF', ...exifDetails(bytes.subarray(body + 6, end))]
  if (marker === 0xe1 && ascii(bytes, body, 4) === 'http') return ['XMP (informations d’édition, auteur…)']
  if (marker === 0xe2 && ascii(bytes, body, 11) === 'ICC_PROFILE') return ['profil couleur']
  if (marker === 0xe2 && ascii(bytes, body, 3) === 'MPF') return ['images secondaires intégrées']
  if (marker === 0xed) return ['IPTC (légende, auteur, lieu…)']
  if (marker === 0xee && ascii(bytes, body, 5) === 'Adobe') return [] // colour-transform flag, nothing personal
  return ['données d’application']
}

/** What an EXIF block reveals, from the tags of its first directory (IFD0) and whether a thumbnail follows. */
function exifDetails(tiff: Uint8Array): string[] {
  const labels: string[] = []
  try {
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
    const little = view.getUint16(0) === 0x4949
    const ifd0 = view.getUint32(4, little)
    const count = view.getUint16(ifd0, little)
    const tags = new Set<number>()
    for (let k = 0; k < count; k++) tags.add(view.getUint16(ifd0 + 2 + k * 12, little))
    if (tags.has(0x8825)) labels.push('position GPS')
    if (tags.has(0x010f) || tags.has(0x0110)) labels.push('marque et modèle de l’appareil')
    if (tags.has(0x0132) || tags.has(0x8769)) labels.push('date et réglages de prise de vue')
    if (view.getUint32(ifd0 + 2 + count * 12, little) !== 0) labels.push('miniature de la photo d’origine')
  } catch {
    // Truncated EXIF: "EXIF" alone is still reported.
  }
  return labels
}

// --- PNG ----------------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Chunks needed to display the image; everything else (text, dates, EXIF, colour profile…) is dropped. */
const PNG_IMAGE_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'])

interface PngChunk {
  type: string
  start: number
  end: number
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

function pngChunks(bytes: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let i = 8
  while (i + 8 <= bytes.length) {
    const type = ascii(bytes, i + 4, 4)
    const end = i + 12 + view.getUint32(i)
    chunks.push({ type, start: i, end })
    i = end
    if (type === 'IEND') break
  }
  if (i < bytes.length) chunks.push({ type: 'trailer', start: i, end: bytes.length })
  return chunks
}

function describePngChunk(type: string): string[] {
  if (PNG_IMAGE_CHUNKS.has(type)) return []
  if (type === 'eXIf') return ['EXIF']
  if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') return ['texte (auteur, logiciel, commentaire…)']
  if (type === 'tIME') return ['date de modification']
  if (type === 'iCCP' || type === 'sRGB' || type === 'gAMA' || type === 'cHRM') return ['profil couleur']
  if (type === 'trailer') return ['données cachées après l’image']
  return ['données annexes']
}

// --- HEIF / HEIC (read only: exports are JPEG or PNG) ---------------------------------------------------

interface Box {
  type: string
  /** Content, after the size and type (and after version and flags for the "full" boxes listed below). */
  start: number
  end: number
  version: number
}

const FULL_BOXES = new Set(['meta', 'iinf', 'infe', 'iloc', 'iref', 'pitm'])

function isHeif(bytes: Uint8Array): boolean {
  return bytes.length > 12 && ascii(bytes, 4, 4) === 'ftyp'
}

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const list: Box[] = []
  let i = start
  while (i + 8 <= end) {
    let size = view.getUint32(i)
    const type = ascii(bytes, i + 4, 4)
    let header = 8
    if (size === 1) {
      size = Number(view.getBigUint64(i + 8))
      header = 16
    } else if (size === 0) {
      size = end - i
    }
    if (size < header || i + size > end) break
    const full = FULL_BOXES.has(type)
    list.push({ type, start: i + header + (full ? 4 : 0), end: i + size, version: full ? bytes[i + header] : 0 })
    i += size
  }
  return list
}

/** What a HEIF file carries besides the image: EXIF and XMP items, thumbnail and auxiliary images, extra boxes. */
function heifMetadata(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const labels: string[] = []
  const top = boxes(bytes, 0, bytes.length)
  for (const box of top) {
    if (box.type === 'mpvd') labels.push('données cachées après l’image (vidéo « Live » ou autre)')
    else if (!['ftyp', 'meta', 'mdat', 'free', 'skip', 'wide'].includes(box.type)) labels.push('données annexes')
  }
  const meta = top.find((b) => b.type === 'meta')
  if (!meta) return labels
  const children = boxes(bytes, meta.start, meta.end)

  const types = new Map<number, string>()
  const iinf = children.find((b) => b.type === 'iinf')
  if (iinf) {
    for (const infe of boxes(bytes, iinf.start + (iinf.version === 0 ? 2 : 4), iinf.end)) {
      if (infe.type !== 'infe' || infe.version < 2) continue
      const id = infe.version === 2 ? view.getUint16(infe.start) : view.getUint32(infe.start)
      types.set(id, ascii(bytes, infe.start + (infe.version === 2 ? 4 : 6), 4))
    }
  }
  const iref = children.find((b) => b.type === 'iref')
  for (const ref of iref ? boxes(bytes, iref.start, iref.end) : []) {
    if (ref.type === 'thmb') labels.push('miniature de la photo d’origine')
    if (ref.type === 'auxl') labels.push('images secondaires intégrées')
  }
  const locations = itemLocations(bytes, children.find((b) => b.type === 'iloc'))
  for (const [id, type] of types) {
    if (type === 'Exif') {
      labels.push('EXIF')
      const at = locations.get(id)
      if (at && at.offset + 4 <= bytes.length) {
        const tiffStart = at.offset + 4 + view.getUint32(at.offset)
        const tiff = bytes.subarray(tiffStart, at.offset + at.length)
        // The TIFF header can be preceded by "Exif\0\0", as in JPEG.
        labels.push(...exifDetails(ascii(tiff, 0, 4) === 'Exif' ? tiff.subarray(6) : tiff))
      }
    }
    if (type === 'mime') labels.push('XMP (informations d’édition, auteur…)')
  }
  return labels
}

/** File offset and length of the items stored in the file itself (single extent, construction method 0). */
function itemLocations(bytes: Uint8Array, iloc: Box | undefined): Map<number, { offset: number; length: number }> {
  const locations = new Map<number, { offset: number; length: number }>()
  if (!iloc) return locations
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const v = iloc.version
    const read = (at: number, size: number) => (size === 0 ? 0 : size === 4 ? view.getUint32(at) : size === 8 ? Number(view.getBigUint64(at)) : view.getUint16(at))
    const offsetSize = bytes[iloc.start] >> 4
    const lengthSize = bytes[iloc.start] & 15
    const baseSize = bytes[iloc.start + 1] >> 4
    const indexSize = v > 0 ? bytes[iloc.start + 1] & 15 : 0
    let i = iloc.start + 2
    const count = v < 2 ? view.getUint16(i) : view.getUint32(i)
    i += v < 2 ? 2 : 4
    for (let k = 0; k < count; k++) {
      const id = v < 2 ? view.getUint16(i) : view.getUint32(i)
      i += v < 2 ? 2 : 4
      const method = v > 0 ? view.getUint16(i) & 15 : 0
      if (v > 0) i += 2
      i += 2 // data reference index
      const base = read(i, baseSize)
      i += baseSize
      const extents = view.getUint16(i)
      i += 2
      for (let e = 0; e < extents; e++) {
        i += indexSize
        const offset = read(i, offsetSize)
        const length = read(i + offsetSize, lengthSize)
        i += offsetSize + lengthSize
        if (method === 0 && extents === 1) locations.set(id, { offset: base + offset, length })
      }
    }
  } catch {
    // Malformed table: EXIF is still reported, without its details.
  }
  return locations
}
