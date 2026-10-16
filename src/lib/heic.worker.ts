// Decodes one HEIC photo with libheif (WebAssembly, embedded in the script: no extra request). Synchronous
// WebAssembly compilation of a large module is only allowed in workers, which also keeps the page responsive.
import libheif from 'libheif-js/libheif-wasm/libheif-bundle.mjs'

export type HeicResponse = { type: 'image'; width: number; height: number; pixels: ArrayBuffer } | { type: 'error'; message: string }

self.onmessage = async (event: MessageEvent<Uint8Array>) => {
  const post = (message: HeicResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer })
  try {
    const lib = await libheif()
    const images = new lib.HeifDecoder().decode(event.data)
    try {
      const image = images.find((i) => i.is_primary()) ?? images[0]
      if (!image) throw new Error('aucune image dans le fichier')
      const width = image.get_width()
      const height = image.get_height()
      const target = { data: new Uint8ClampedArray(width * height * 4), width, height }
      const decoded = await new Promise<typeof target>((resolve, reject) =>
        image.display(target, (result) => (result ? resolve(result as typeof target) : reject(new Error('décodage impossible')))),
      )
      post({ type: 'image', width, height, pixels: decoded.data.buffer as ArrayBuffer }, [decoded.data.buffer])
    } finally {
      images.forEach((i) => i.free())
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
