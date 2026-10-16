import type { AnalysisResult, AnalysisTasks, DetectionStats, DetectorRequest, DetectorResponse, EngineConfig, EngineInfo, ModelId } from './detector-protocol'
import { gpuAllowed } from './environment'
import type { Detection } from './scrfd'

export interface DetectionProgress {
  task: 'faces' | 'text'
  done: number
  total: number
  elapsedMs: number
  /** Faces found so far, sent each time a scale is complete. */
  partial?: Detection[]
}

interface Job {
  resolve: (result: AnalysisResult) => void
  reject: (error: Error) => void
  onProgress: (progress: DetectionProgress) => void
}

let worker: Worker | null = null
let nextJobId = 1
const jobs = new Map<number, Job>()
const engines = new Map<ModelId, EngineInfo>()
const engineListeners = new Set<(info: EngineInfo) => void>()

const engineConfig = (): EngineConfig => ({ baseUrl: new URL(import.meta.env.BASE_URL, document.baseURI).href, gpu: gpuAllowed() })

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<DetectorResponse>) => {
      const message = event.data
      if (message.type === 'engine') {
        engines.set(message.info.model, message.info)
        engineListeners.forEach((listener) => listener(message.info))
        return
      }
      const job = jobs.get(message.jobId)
      if (!job) return
      if (message.type === 'progress') {
        const { task, done, total, elapsedMs, detections } = message
        job.onProgress({ task, done, total, elapsedMs, partial: detections })
        return
      }
      jobs.delete(message.jobId)
      if (message.type === 'result') job.resolve({ faces: message.faces, text: message.text, textError: message.textError, stats: message.stats })
      else job.reject(new Error(message.message))
    }
  }
  return worker
}

/** Starts loading the detector so the first photo is analysed without waiting for it. */
export function warmUpDetector(model: ModelId = 'faces'): void {
  const request: DetectorRequest = { type: 'warmup', ...engineConfig(), model }
  getWorker().postMessage(request)
}

/**
 * Calls `listener` each time a model's engine gets ready, starting with those already loaded. Returns an
 * unsubscribe function.
 */
export function onEngineReady(listener: (info: EngineInfo) => void): () => void {
  engines.forEach((info) => listener(info))
  engineListeners.add(listener)
  return () => engineListeners.delete(listener)
}

/**
 * Looks for faces and/or text in `bitmap` (boxes in its pixel coordinates). The bitmap is transferred to the
 * worker and closed there.
 */
export function analyseImage(bitmap: ImageBitmap, tasks: AnalysisTasks, onProgress: (progress: DetectionProgress) => void): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const jobId = nextJobId++
    jobs.set(jobId, { resolve, reject, onProgress })
    const request: DetectorRequest = { type: 'detect', jobId, bitmap, ...engineConfig(), tasks }
    getWorker().postMessage(request, [bitmap])
  })
}

/** Faces only, with the default model. `maxLevel`: see `planPasses`. */
export async function detectFaces(
  bitmap: ImageBitmap,
  onProgress: (progress: DetectionProgress) => void,
  maxLevel?: number,
): Promise<{ detections: Detection[]; stats: DetectionStats }> {
  const { faces, stats } = await analyseImage(bitmap, { faces: 'faces', text: false, maxLevel }, onProgress)
  return { detections: faces!, stats: stats.faces! }
}
