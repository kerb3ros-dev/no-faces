// The part of libheif-js's JavaScript API used by heic.worker.ts (the package only types the raw C API).
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  interface HeifImage {
    get_width(): number
    get_height(): number
    is_primary(): boolean
    /** Fills `target.data` with RGBA pixels, rotation and mirroring applied; calls back with null on failure. */
    display(target: { data: Uint8ClampedArray; width: number; height: number }, callback: (result: unknown) => void): void
    free(): void
  }
  interface LibHeif {
    HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] }
  }
  export default function libheif(): LibHeif | Promise<LibHeif>
}
