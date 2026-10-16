import type { Detection } from './scrfd'

/** SCRFD 2.5G (fast, default), SCRFD 10G (more accurate, "analyse approfondie") and the text detector. */
export type ModelId = 'faces' | 'faces-deep' | 'text'
export type FaceModel = Extract<ModelId, 'faces' | 'faces-deep'>

/** What to look for in an image: faces with the given model (or not at all), text. */
export interface AnalysisTasks {
  faces: FaceModel | null
  text: boolean
  /** Caps the resolution scanned for faces, see `planPasses`. */
  maxLevel?: number
}

/** Where the models are, and whether the GPU may be used (decided by the page, which knows the device better). */
export interface EngineConfig {
  baseUrl: string
  gpu: boolean
}

export type DetectorRequest =
  | ({ type: 'warmup'; model: ModelId } & EngineConfig)
  | ({ type: 'detect'; jobId: number; bitmap: ImageBitmap; tasks: AnalysisTasks } & EngineConfig)

/** How a model runs on this device, reported once its engine is ready. */
export interface EngineInfo {
  model: ModelId
  backend: 'webgpu' | 'wasm'
  threads: number
  crossOriginIsolated: boolean
  /** GPU adapter, when WebGPU is available. */
  gpu: string | null
  /** Why WebGPU is not used, when it is not. */
  fallback: string | null
  /** Largest score difference between WebGPU and CPU on the check input. */
  gpuCheckDiff: number | null
  timings: Record<string, number>
}

export interface DetectionStats {
  totalMs: number
  passes: number
  /** Time per scale, in the order they run. */
  levels: { scale: number; passes: number; ms: number }[]
}

export interface AnalysisResult {
  /** Null when not asked for. */
  faces: Detection[] | null
  text: Detection[] | null
  /** Why text could not be looked for: the faces found are still returned. */
  textError?: string
  stats: { faces?: DetectionStats; text?: DetectionStats }
}

export type DetectorResponse =
  | { type: 'engine'; info: EngineInfo }
  /** `detections` is sent each time a scale is complete, so faces show up before the end. */
  | { type: 'progress'; jobId: number; task: 'faces' | 'text'; done: number; total: number; elapsedMs: number; detections?: Detection[] }
  | ({ type: 'result'; jobId: number } & AnalysisResult)
  | { type: 'error'; jobId: number; message: string }
