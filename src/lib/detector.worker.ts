// Runs face and text detection off the main thread. Images never leave the device: the models and the
// WebAssembly runtime are loaded from the app's own origin.
import * as ort from 'onnxruntime-web/webgpu'
import type { AnalysisResult, DetectionStats, DetectorRequest, DetectorResponse, EngineConfig, EngineInfo, ModelId } from './detector-protocol'
import { INPUT_SIZE, decodeOutputs, planPasses, suppress, toTensorData, type Detection } from './scrfd'
import { TEXT_INPUT, decodeTextMap, mergeTextBoxes, planTextPasses, toTextTensor } from './text'

interface ModelSpec {
  file: string
  inputSize: number
  /** Outputs compared between GPU and CPU: the scores, not the box offsets (larger values, larger rounding). */
  checked: (outputNames: readonly string[]) => readonly string[]
}

// Both SCRFD exports list their outputs as score 8/16/32, bbox 8/16/32, kps 8/16/32; only the 2.5G one names them.
const MODELS: Record<ModelId, ModelSpec> = {
  faces: { file: 'models/scrfd_2.5g_bnkps.onnx', inputSize: INPUT_SIZE, checked: (names) => names.slice(0, 3) },
  'faces-deep': { file: 'models/scrfd_10g_bnkps.onnx', inputSize: INPUT_SIZE, checked: (names) => names.slice(0, 3) },
  text: { file: 'models/ppocrv4_det.onnx', inputSize: TEXT_INPUT, checked: (names) => names.slice(0, 1) },
}
const STRIDES = [8, 16, 32]
const OTHER_FACE_MODEL: Record<ModelId, ModelId | null> = { faces: 'faces-deep', 'faces-deep': 'faces', text: null }

/** Kept low on purpose: the UI filters by the user's sensitivity setting without re-running the model. */
const MIN_SCORE = 0.25
/** WebGPU is only trusted if its scores match the CPU's this closely on the check input. */
const GPU_TOLERANCE = 0.02

interface Engine {
  session: ort.InferenceSession
  info: EngineInfo
}

const engines = new Map<ModelId, Promise<Engine>>()

async function getEngine(model: ModelId, config: EngineConfig): Promise<Engine> {
  // A single face model in memory at a time: the 10G one alone weighs 17 MB.
  const other = OTHER_FACE_MODEL[model]
  const loaded = other && engines.get(other)
  if (other && loaded) {
    engines.delete(other)
    await loaded.then((e) => e.session.release()).catch(() => {})
  }
  let engine = engines.get(model)
  if (!engine) {
    engine = createEngine(model, config)
    engines.set(model, engine)
    engine.then((e) => post({ type: 'engine', info: e.info })).catch(() => engines.delete(model))
  }
  return engine
}

/** Deterministic noise in [-1, 1]: exercises every layer of the network for the WebGPU check. */
function checkInput(size: number): ort.Tensor {
  const data = new Float32Array(3 * size * size)
  let seed = 12345
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    data[i] = (seed / 0x7fffffff) * 2 - 1
  }
  return new ort.Tensor('float32', data, [1, 3, size, size])
}

async function scores(session: ort.InferenceSession, spec: ModelSpec, input: ort.Tensor): Promise<Float32Array[]> {
  const outputs = await session.run({ [session.inputNames[0]]: input })
  return spec.checked(session.outputNames).map((n) => outputs[n].data as Float32Array)
}

/**
 * The GPU (WebGPU) is much faster than the CPU on phones, but a buggy driver could silently return wrong
 * scores — i.e. missed faces. It is used only if it gives the same results as the CPU on a check input.
 */
async function createEngine(model: ModelId, { baseUrl, gpu: gpuOk }: EngineConfig): Promise<Engine> {
  const spec = MODELS[model]
  const timings: Record<string, number> = {}
  const time = async <T,>(label: string, work: () => Promise<T>): Promise<T> => {
    const start = performance.now()
    try {
      return await work()
    } finally {
      timings[label] = Math.round(performance.now() - start)
    }
  }

  if (typeof WebAssembly !== 'object') {
    // Hardened browsers (e.g. GrapheneOS's Vanadium) can disable it along with the JavaScript JIT.
    throw new Error('ce navigateur bloque WebAssembly. Autorisez les optimisations JavaScript (JIT) pour ce site dans ses paramètres')
  }
  ort.env.wasm.wasmPaths = baseUrl + 'ort/'
  // Threads need SharedArrayBuffer, only available when the page is cross-origin isolated (see public/_headers).
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
  const response = await time('modelDownloadMs', () => fetch(baseUrl + spec.file))
  // Offline before the model was ever used: the optional models are only cached on first use.
  if (!response.ok) throw new Error(`modèle indisponible (${response.status}) : connectez-vous une fois à Internet pour le télécharger`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const cpu = await time('cpuSessionMs', () => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }))

  const info: EngineInfo = {
    model,
    backend: 'wasm',
    threads: ort.env.wasm.numThreads,
    crossOriginIsolated: self.crossOriginIsolated,
    gpu: null,
    fallback: null,
    gpuCheckDiff: null,
    timings,
  }

  const gpuApi = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ info?: { vendor?: string; architecture?: string } } | null> } }).gpu
  if (!gpuOk || !gpuApi) {
    info.fallback = gpuOk ? 'WebGPU non disponible dans ce navigateur' : 'WebGPU désactivé sur iPhone et iPad : trop gourmand en mémoire'
    return { session: cpu, info }
  }
  try {
    const adapter = await gpuApi.requestAdapter()
    if (!adapter) throw new Error('aucun adaptateur WebGPU')
    info.gpu = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || 'inconnu'
    const gpu = await time('gpuSessionMs', () => ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] }))
    const input = checkInput(spec.inputSize)
    const expected = await time('cpuCheckRunMs', () => scores(cpu, spec, input))
    await time('gpuFirstRunMs', () => scores(gpu, spec, input)) // includes shader compilation
    const actual = await time('gpuCheckRunMs', () => scores(gpu, spec, input))
    let diff = 0
    expected.forEach((a, k) => a.forEach((v, i) => (diff = Math.max(diff, Math.abs(v - actual[k][i])))))
    info.gpuCheckDiff = diff
    if (diff > GPU_TOLERANCE) {
      await gpu.release()
      info.fallback = `résultats WebGPU différents du CPU (écart ${diff.toFixed(3)})`
      return { session: cpu, info }
    }
    await cpu.release()
    info.backend = 'webgpu'
    return { session: gpu, info }
  } catch (error) {
    info.fallback = `WebGPU en échec : ${error instanceof Error ? error.message : String(error)}`
    return { session: cpu, info }
  }
}

/** Draws a crop of the bitmap into the top-left corner of the input canvas, on black, and returns its pixels. */
function drawPass(ctx: OffscreenCanvasRenderingContext2D, bitmap: ImageBitmap, p: { sx: number; sy: number; sw: number; sh: number; scale: number }) {
  const size = ctx.canvas.width
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  ctx.drawImage(bitmap, p.sx, p.sy, p.sw, p.sh, 0, 0, p.sw * p.scale, p.sh * p.scale)
  return ctx.getImageData(0, 0, size, size).data
}

function inputContext(size: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

async function detectFaces(jobId: number, bitmap: ImageBitmap, model: ModelId, config: EngineConfig, maxLevel?: number): Promise<{ detections: Detection[]; stats: DetectionStats }> {
  const { session } = await getEngine(model, config)
  const names = session.outputNames
  const ctx = inputContext(INPUT_SIZE)
  const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE)
  const passes = planPasses(bitmap.width, bitmap.height, maxLevel)
  const found: Detection[] = []
  const levels: DetectionStats['levels'] = []
  const start = performance.now()
  let levelStart = start

  for (const [i, p] of passes.entries()) {
    toTensorData(drawPass(ctx, bitmap, p), input)
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]) })
    const output = (name: string) => {
      const [kind, stride] = name.split('_')
      return outputs[names[(kind === 'score' ? 0 : 3) + STRIDES.indexOf(Number(stride))]].data as Float32Array
    }
    for (const d of decodeOutputs(output, MIN_SCORE)) {
      found.push({ x: p.sx + d.x / p.scale, y: p.sy + d.y / p.scale, w: d.w / p.scale, h: d.h / p.scale, score: d.score })
    }
    const now = performance.now()
    const scaleDone = passes[i + 1]?.scale !== p.scale
    if (scaleDone) {
      levels.push({ scale: Math.round(p.scale * 1000) / 1000, passes: passes.filter((q) => q.scale === p.scale).length, ms: Math.round(now - levelStart) })
      levelStart = now
    }
    post({ type: 'progress', jobId, task: 'faces', done: i + 1, total: passes.length, elapsedMs: now - start, detections: scaleDone ? suppress(found) : undefined })
  }
  return { detections: suppress(found), stats: { totalMs: Math.round(performance.now() - start), passes: passes.length, levels } }
}

async function detectText(jobId: number, bitmap: ImageBitmap, config: EngineConfig): Promise<{ detections: Detection[]; stats: DetectionStats }> {
  const { session } = await getEngine('text', config)
  const ctx = inputContext(TEXT_INPUT)
  const input = new Float32Array(3 * TEXT_INPUT * TEXT_INPUT)
  const passes = planTextPasses(bitmap.width, bitmap.height)
  const found: Detection[] = []
  const start = performance.now()
  for (const [i, p] of passes.entries()) {
    toTextTensor(drawPass(ctx, bitmap, p), input)
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, TEXT_INPUT, TEXT_INPUT]) })
    const map = outputs[session.outputNames[0]].data as Float32Array
    for (const d of decodeTextMap(map, TEXT_INPUT, p.sw * p.scale, p.sh * p.scale)) {
      found.push({ x: p.sx + d.x / p.scale, y: p.sy + d.y / p.scale, w: d.w / p.scale, h: d.h / p.scale, score: d.score })
    }
    post({ type: 'progress', jobId, task: 'text', done: i + 1, total: passes.length, elapsedMs: performance.now() - start })
  }
  const totalMs = Math.round(performance.now() - start)
  return { detections: mergeTextBoxes(found), stats: { totalMs, passes: passes.length, levels: [] } }
}

async function analyse({ jobId, bitmap, baseUrl, gpu, tasks }: Extract<DetectorRequest, { type: 'detect' }>): Promise<AnalysisResult> {
  const result: AnalysisResult = { faces: null, text: null, stats: {} }
  if (tasks.faces) {
    const { detections, stats } = await detectFaces(jobId, bitmap, tasks.faces, { baseUrl, gpu }, tasks.maxLevel)
    result.faces = detections
    result.stats.faces = stats
  }
  if (tasks.text) {
    try {
      const { detections, stats } = await detectText(jobId, bitmap, { baseUrl, gpu })
      result.text = detections
      result.stats.text = stats
    } catch (error) {
      result.textError = error instanceof Error ? error.message : String(error)
    }
  }
  return result
}

function post(message: DetectorResponse) {
  self.postMessage(message)
}

// Jobs run one at a time so a batch of photos does not hold several full-size images in memory.
let queue = Promise.resolve()
self.onmessage = (event: MessageEvent<DetectorRequest>) => {
  const request = event.data
  queue = queue.then(async () => {
    if (request.type === 'warmup') {
      // Loads the runtime and the model ahead of the first photo; a failure resurfaces on the first detection.
      await getEngine(request.model, request).catch(() => {})
      return
    }
    try {
      post({ type: 'result', jobId: request.jobId, ...(await analyse(request)) })
    } catch (error) {
      post({ type: 'error', jobId: request.jobId, message: error instanceof Error ? error.message : String(error) })
    } finally {
      request.bitmap.close()
    }
  })
}
