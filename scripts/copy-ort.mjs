// Copies the ONNX Runtime WebAssembly files next to the app. They are loaded from there rather than
// bundled so that ORT can start its thread workers from its own script (see detector.worker.ts).
import { cpSync, mkdirSync } from 'node:fs'

const src = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url)
const dest = new URL('../public/ort/', import.meta.url)

mkdirSync(dest, { recursive: true })
// The WebGPU build of ORT runs on this "asyncify" variant, which also has the CPU (wasm) backend.
for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(new URL(file, src), new URL(file, dest))
}
