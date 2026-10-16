import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Camera, cameraAvailable } from './components/Camera'
import { Controls, type Tool } from './components/Controls'
import { ExportDialog } from './components/ExportDialog'
import { Emblem, IconClose, IconPlus } from './components/Icons'
import { Stage, StageTools } from './components/Stage'
import { Welcome } from './components/Welcome'
import { analyseImage, onEngineReady, warmUpDetector } from './lib/detector'
import type { AnalysisTasks, FaceModel, ModelId } from './lib/detector-protocol'
import type { Detection } from './lib/scrfd'
import { jitLooksDisabled, videoUnavailableReason } from './lib/environment'
import { decodeForAnalysis, loadPhoto, maskedZones, releaseCanvas, zonesAbove, type Photo, type Zone } from './lib/photo'
import { scoreThreshold, useSettings, type Settings } from './lib/settings'

export const APP_NAME = 'no-faces'

let nextId = 1

const toZones = (detections: Detection[], kind?: Zone['kind']): Zone[] => detections.map((d) => ({ ...d, id: nextId++, kind }))

const isDetectedFace = (z: Zone) => z.score !== null && z.kind !== 'area'
const isDetectedText = (z: Zone) => z.score !== null && z.kind === 'area'

function overlap(a: Zone, b: Zone): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  const inter = w > 0 && h > 0 ? w * h : 0
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/** New face detections, replacing the previous ones; zones drawn by hand and text stay. A face left visible stays visible. */
function withFaces(photo: Photo, faces: Zone[]): Pick<Photo, 'detected' | 'zones'> {
  const kept = photo.zones.filter((z) => z.keep && isDetectedFace(z))
  const marked = faces.map((f) => (kept.some((k) => overlap(k, f) > 0.5) ? { ...f, keep: true } : f))
  return { detected: faces, zones: [...photo.zones.filter((z) => !isDetectedFace(z)), ...marked] }
}

/** Shows or hides the detected text, keeping it aside so the option can be switched back without a new analysis. */
function withText(photo: Photo, show: boolean): Pick<Photo, 'zones'> {
  return { zones: [...photo.zones.filter((z) => !isDetectedText(z)), ...(show ? (photo.textDetected ?? []) : [])] }
}

/** What is still to be found on a photo for the current settings, or null if it is up to date. */
function missingTasks(photo: Photo, settings: Settings): AnalysisTasks | null {
  const model: FaceModel = settings.deep ? 'faces-deep' : 'faces'
  const tasks = { faces: photo.faceModel === model ? null : model, text: settings.text && photo.textDetected === null }
  return tasks.faces || tasks.text ? tasks : null
}

// Loaded on demand: the video code (Mediabunny) does not slow down the start, and never runs on phones.
const VideoEditor = lazy(() => import('./components/VideoEditor').then((m) => ({ default: m.VideoEditor })))

/** Null on computers; on phones and tablets, why videos are refused. */
const videoReason = videoUnavailableReason()
const isVideo = (file: File) => file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name)
const isImage = (file: File) => file.type.startsWith('image/') || /\.hei[cf]$/i.test(file.name)

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [settings, updateSettings] = useSettings()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [tool, setTool] = useState<Tool>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const [opening, setOpening] = useState(false)
  const [readyModels, setReadyModels] = useState<ReadonlySet<ModelId>>(new Set())
  const [slowBrowser, setSlowBrowser] = useState(jitLooksDisabled)
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const showError = useCallback((message: string) => {
    setErrors((list) => [...list, message])
    setVideoFile(null)
  }, [])

  useEffect(() => {
    warmUpDetector(settings.deep ? 'faces-deep' : 'faces')
    return onEngineReady((info) => setReadyModels((set) => new Set(set).add(info.model)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, with the model of the saved settings
  }, [])

  const updatePhoto = useCallback((id: number, patch: Partial<Photo> | ((p: Photo) => Partial<Photo>)) => {
    setPhotos((list) => list.map((p) => (p.id === id ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p)))
  }, [])

  // --- Analysis -----------------------------------------------------------------------------------------

  /** Photos being analysed. Settings changes re-analyse photos one at a time, to keep a single full-size image in memory. */
  const busy = useRef(new Set<number>())
  const [analysesDone, setAnalysesDone] = useState(0)
  const settingsRef = useRef(settings)
  const photosRef = useRef(photos)
  useEffect(() => {
    settingsRef.current = settings
    photosRef.current = photos
  })

  const runAnalysis = (id: number, bitmap: ImageBitmap, tasks: AnalysisTasks) => {
    busy.current.add(id)
    updatePhoto(id, { status: 'detecting', task: tasks.faces ? 'faces' : 'text', progress: 0, remainingMs: null })
    analyseImage(bitmap, tasks, ({ task, done, total, elapsedMs, partial }) => {
      const patch: Partial<Photo> = { task, progress: done / total, remainingMs: (elapsedMs / done) * (total - done) }
      updatePhoto(id, (p) => (partial ? { ...patch, ...withFaces(p, toZones(partial)) } : patch))
    })
      .then(({ faces, text, textError }) => {
        updatePhoto(id, (p) => {
          let next: Photo = { ...p, status: 'ready', remainingMs: null }
          if (faces) next = { ...next, ...withFaces(next, toZones(faces)), faceModel: tasks.faces }
          if (text) next = { ...next, textDetected: toZones(text, 'area') }
          if (tasks.text) next = { ...next, ...withText(next, settingsRef.current.text) }
          return next
        })
        if (textError) {
          // Offline before the text detector was ever downloaded, for instance: the option goes back off.
          updateSettings({ text: false })
          setErrors((list) => [...list, `Recherche de texte impossible : ${textError}.`])
        }
      })
      .catch((error: Error) => {
        if (!photosRef.current.find((p) => p.id === id)?.faceModel) {
          updatePhoto(id, { status: 'error', error: error.message })
          return
        }
        // A new analysis failed (offline, larger model never downloaded…): the previous results stay, the setting goes back.
        updatePhoto(id, { status: 'ready', remainingMs: null })
        if (tasks.faces === 'faces-deep') updateSettings({ deep: false })
        if (tasks.text) updateSettings({ text: false })
        setErrors((list) => [...list, `Nouvelle analyse impossible : ${error.message}.`])
      })
      .finally(() => {
        busy.current.delete(id)
        setAnalysesDone((n) => n + 1)
      })
  }

  // Brings photos up to date with the analysis settings (larger model, text), one at a time.
  useEffect(() => {
    if (busy.current.size) return
    const photo = photos.find((p) => p.status !== 'error' && missingTasks(p, settings))
    if (!photo) return
    const tasks = missingTasks(photo, settings)!
    busy.current.add(photo.id)
    decodeForAnalysis(photo.file)
      .then((bitmap) => runAnalysis(photo.id, bitmap, tasks))
      .catch((error: Error) => {
        busy.current.delete(photo.id)
        updatePhoto(photo.id, { status: 'error', error: error.message })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runAnalysis only uses stable setters and refs
  }, [photos, settings.deep, settings.text, analysesDone])

  // Turning the text option off hides the text found, without forgetting it.
  useEffect(() => {
    setPhotos((list) => list.map((p) => (p.textDetected ? { ...p, ...withText(p, settings.text) } : p)))
  }, [settings.text])

  const addFiles = async (picked: File[]) => {
    setErrors([])
    const videos = picked.filter(isVideo)
    const files = picked.filter((f) => !isVideo(f))
    if (videos.length > 0) {
      if (videoReason) setErrors([videoReason])
      else if (videos.length > 1 || files.length > 0) setErrors(['Une seule vidéo à la fois, et sans photos : choisissez-la seule.'])
      else setVideoFile(videos[0])
      return
    }
    // One at a time: decoding several 12+ MP photos at once can exhaust a phone's memory.
    for (const file of files) {
      setOpening(true)
      try {
        const { bitmap, ...loaded } = await loadPhoto(file)
        const id = nextId++
        const photo: Photo = {
          id,
          file,
          ...loaded,
          detected: [],
          faceModel: null,
          textDetected: null,
          zones: [],
          status: 'detecting',
          task: 'faces',
          progress: 0,
          remainingMs: null,
        }
        setPhotos((list) => [...list, photo])
        setCurrentId((current) => current ?? id)
        runAnalysis(id, bitmap, missingTasks(photo, settingsRef.current)!)
      } catch (error) {
        setErrors((list) => [...list, `${file.name} : ${(error as Error).message}`])
      } finally {
        setOpening(false)
      }
    }
  }

  const pickFiles = () => fileInput.current?.click()

  // --- Editing ------------------------------------------------------------------------------------------

  const current = photos.find((p) => p.id === currentId) ?? null
  const threshold = scoreThreshold(settings.sensitivity)
  // Memoised so that progress updates (which re-render the app) do not re-mask the preview.
  const currentZones = current?.zones
  const zones = useMemo(() => (currentZones ? zonesAbove(currentZones, threshold) : []), [currentZones, threshold])
  const keptCount = zones.filter((z) => z.keep).length

  const selectPhoto = (id: number | null) => {
    setCurrentId(id)
    setSelectedId(null)
    setTool(null)
    setZoom(1)
  }

  const setZones = (update: (zones: Zone[]) => Zone[]) => {
    if (current) updatePhoto(current.id, (p) => ({ zones: update(p.zones) }))
  }

  const removePhoto = (id: number) => {
    const photo = photos.find((p) => p.id === id)
    if (photo) releaseCanvas(photo.preview)
    const rest = photos.filter((p) => p.id !== id)
    setPhotos(rest)
    if (currentId === id) selectPhoto(rest[0]?.id ?? null)
  }

  // Nothing is saved: ask before leaving or reloading the page while there is work in progress. Browsers show
  // their own message; iOS Safari ignores the request, and nothing can stop a reload after a crash.
  const hasWork = photos.length > 0 || videoFile !== null
  useEffect(() => {
    if (!hasWork) return
    const confirmLeave = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', confirmLeave)
    return () => window.removeEventListener('beforeunload', confirmLeave)
  }, [hasWork])

  // Drag & drop anywhere on desktop.
  useEffect(() => {
    const over = (event: DragEvent) => event.preventDefault()
    const drop = (event: DragEvent) => {
      event.preventDefault()
      const files = [...(event.dataTransfer?.files ?? [])].filter((f) => isImage(f) || isVideo(f))
      if (files.length) void addFiles(files)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  })

  const busyLabel = (photo: Photo) => {
    const faceModel: ModelId = settings.deep ? 'faces-deep' : 'faces'
    const model = photo.task === 'text' ? 'text' : faceModel
    const label = photo.task === 'text' ? 'Recherche de texte' : 'Analyse des visages'
    if (photo.progress > 0) return `${label} · ${Math.round(photo.progress * 100)} %`
    if (readyModels.has(model)) return `${label}…`
    if (model === 'faces') return 'Préparation du moteur d’analyse…'
    return model === 'text' ? 'Chargement du détecteur de texte…' : 'Chargement du modèle approfondi…'
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <Emblem size={30} />
          <span>{APP_NAME}</span>
        </div>
        <span className="local-badge" title="Aucune photo n’est envoyée sur Internet">
          100 % local
        </span>
        {photos.length > 0 && !videoFile && (
          <>
            {cameraAvailable && (
              <button className="button ghost icon-button" onClick={() => setCameraOpen(true)} aria-label="Prendre une photo" title="Prendre une photo">
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                  <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="miter" />
                  <circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
              </button>
            )}
            <button className="button ghost" onClick={pickFiles} aria-label="Ajouter des photos">
              <IconPlus size={14} />
              <span className="button-label">Photos</span>
            </button>
          </>
        )}
      </header>

      <input
        ref={fileInput}
        type="file"
        accept={videoReason ? 'image/*,.heic,.heif' : 'image/*,.heic,.heif,video/*,.mp4,.m4v,.mov,.webm,.mkv'}
        multiple
        hidden
        onChange={(event) => {
          void addFiles([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />

      {slowBrowser && (
        <div className="errors" role="alert">
          <p>
            <strong>Votre navigateur a désactivé les optimisations JavaScript (JIT) pour ce site.</strong> L’analyse peut
            prendre plusieurs minutes au lieu de quelques secondes.
          </p>
          <p>
            Pour l’accélérer, autorisez-les pour ce site dans les paramètres du navigateur. Dans Vanadium (GrapheneOS) :
            icône à gauche de l’adresse → Paramètres du site → optimisation JavaScript (JIT) → Autoriser, puis rechargez.
          </p>
          <button className="link" onClick={() => setSlowBrowser(false)}>
            Fermer
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <div className="errors" role="alert">
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
          <button className="link" onClick={() => setErrors([])}>
            Fermer
          </button>
        </div>
      )}

      {videoFile ? (
        <Suspense fallback={null}>
          <VideoEditor
            key={`${videoFile.name}-${videoFile.lastModified}`}
            file={videoFile}
            settings={settings}
            onSettings={updateSettings}
            onClose={() => setVideoFile(null)}
            onError={showError}
          />
        </Suspense>
      ) : !current ? (
        <Welcome onPick={pickFiles} onCamera={cameraAvailable ? () => setCameraOpen(true) : null} videoReason={videoReason} />
      ) : (
        <main className="editor">
          {photos.length > 1 && (
            <nav className="strip">
              {photos.map((p) => (
                <div key={p.id} className={`thumb${p.id === currentId ? ' active' : ''}`}>
                  <button onClick={() => selectPhoto(p.id)} aria-label="Afficher cette photo">
                    <img src={p.thumb} alt="" />
                    <span className="thumb-badge">
                      {p.status === 'detecting' ? '…' : p.status === 'error' ? '!' : maskedZones(p, threshold).length}
                    </span>
                  </button>
                  <button className="thumb-remove" onClick={() => removePhoto(p.id)} aria-label="Retirer cette photo">
                    <IconClose size={10} />
                  </button>
                </div>
              ))}
            </nav>
          )}

          <section className="workspace">
            <Stage
              photo={current}
              zones={zones}
              options={settings}
              selectedId={selectedId}
              onSelect={setSelectedId}
              drawing={tool === 'face' || tool === 'area'}
              onDrawn={(rect) => {
                const zone: Zone = { ...rect, id: nextId++, score: null, kind: tool === 'area' ? 'area' : undefined }
                setZones((list) => [...list, zone])
                setSelectedId(zone.id)
                setTool(null)
              }}
              onChange={(zone) => setZones((list) => list.map((z) => (z.id === zone.id ? zone : z)))}
              onPick={tool === 'keep' ? (zone) => setZones((list) => list.map((z) => (z.id === zone.id ? { ...z, keep: !z.keep } : z))) : undefined}
              showOriginal={showOriginal}
              zoom={zoom}
              onZoom={setZoom}
            />

            {current.status === 'detecting' && (
              <div className="busy">
                <div className="spinner" />
                <div className="busy-text">
                  <span>
                    {busyLabel(current)}
                    {current.progress > 0 && current.remainingMs !== null && ` · encore ~${Math.ceil(current.remainingMs / 1000)} s`}
                  </span>
                  <span className="progress-bar">
                    <span style={{ width: `${current.progress * 100}%` }} />
                  </span>
                </div>
              </div>
            )}
            {current.status === 'error' && (
              <div className="busy error">La détection a échoué : {current.error}. Ajoutez les zones à la main.</div>
            )}

            <StageTools zoom={zoom} onZoom={setZoom} showOriginal={showOriginal} onShowOriginal={setShowOriginal} />
          </section>

          <Controls
            settings={settings}
            onSettings={updateSettings}
            photo={current}
            zoneCount={zones.length - keptCount}
            keptCount={keptCount}
            hiddenCount={current.zones.length - zones.length}
            tool={tool}
            onTool={(next) => {
              setTool(next)
              setSelectedId(null)
            }}
            selected={selectedId !== null}
            onDelete={() => {
              setZones((list) => list.filter((z) => z.id !== selectedId))
              setSelectedId(null)
            }}
            onReset={() => {
              updatePhoto(current.id, (p) => ({ zones: [...p.detected, ...(settings.text ? (p.textDetected ?? []) : [])] }))
              setSelectedId(null)
            }}
            onExport={() => setExporting(true)}
            photoCount={photos.length}
            canExport={photos.every((p) => p.status !== 'detecting')}
          />
        </main>
      )}

      {opening && (
        <div className="toast">
          <div className="spinner" />
          Ouverture de la photo…
        </div>
      )}

      {cameraOpen && (
        <Camera
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => {
            setCameraOpen(false)
            void addFiles([file])
          }}
        />
      )}

      {exporting && (
        <ExportDialog photos={photos} options={settings} threshold={threshold} onClose={() => setExporting(false)} />
      )}
    </div>
  )
}
