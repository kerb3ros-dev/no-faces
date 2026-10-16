// HEIC photos (iPhone, recent Android phones) outside Safari, which is the only browser that decodes them.
// libheif, compiled to WebAssembly, is loaded on demand in a worker, served by the app like everything else.

import type { HeicResponse } from './heic.worker'

const HEVC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx'])

/** Brands of the file's `ftyp` box: HEIF still images coded in HEVC. AVIF (also HEIF) is left to the browser. */
export function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') return false
  const size = Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset).getUint32(0))
  const brands: string[] = []
  for (let i = 8; i + 4 <= size; i += 4) if (i !== 12) brands.push(String.fromCharCode(...bytes.subarray(i, i + 4)))
  return brands.some((b) => HEVC_BRANDS.has(b)) || (brands.includes('mif1') && !brands.includes('avif'))
}

/** Decodes the primary image, rotation and mirroring applied. */
export function decodeHeic(bytes: Uint8Array): Promise<ImageBitmap> {
  // A worker per photo: WebAssembly memory never shrinks, terminating the worker gives it back.
  const worker = new Worker(new URL('./heic.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<ImageBitmap>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<HeicResponse>) => {
      const message = event.data
      if (message.type === 'error') {
        reject(new Error(`Cette photo HEIC n’a pas pu être lue (${message.message}).`))
        return
      }
      const pixels = new Uint8ClampedArray(message.pixels)
      createImageBitmap(new ImageData(pixels, message.width, message.height)).then(resolve, reject)
    }
    worker.onerror = () => reject(new Error('Le décodeur HEIC n’a pas pu démarrer.'))
    const copy = bytes.slice()
    worker.postMessage(copy, [copy.buffer])
  }).finally(() => worker.terminate())
}
