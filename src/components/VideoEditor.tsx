import { useEffect, useMemo, useRef, useState } from 'react'
import { onEngineReady } from '../lib/detector'
import { zonesAbove, type Zone } from '../lib/photo'
import { canShareFiles, downloadFiles, shareFiles } from '../lib/save'
import { scoreThreshold, type Settings } from '../lib/settings'
import { buildTracks, keyframeBox, setKeyframe, zonesAt, type AnalysedFrame, type Keyframe, type Tracking } from '../lib/tracks'
import { ANALYSIS, analyseVideo, closeVideo, exportVideo, openVideo, previewFrame, type AnalysisMode, type Video } from '../lib/video'
import { MaskFields, Segmented } from './Controls'
import { Stage, StageTools } from './Stage'

interface Props {
  file: File
  settings: Settings
  onSettings: (patch: Partial<Settings>) => void
  onClose: () => void
  onError: (message: string) => void
}

/**
 * A zone drawn by hand, masked from `start` to `end` (seconds). Moved on some frames (keyframes), it slides
 * from one position to the next in between: that is how an element the detector misses is followed.
 */
interface ManualZone {
  id: number
  start: number
  end: number
  keys: Keyframe[]
}

interface Frame {
  canvas: HTMLCanvasElement | OffscreenCanvas
  timestamp: number
}

type Analysis = { status: 'analysing'; progress: number; remainingMs: number | null } | { status: 'ready' } | { status: 'error'; message: string }

const AUDIO_CHOICES: { value: 'remove' | 'keep'; label: string }[] = [
  { value: 'remove', label: 'Supprimer le son' },
  { value: 'keep', label: 'Garder le son' },
]
const MODES: { value: AnalysisMode; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'deep', label: 'Approfondie' },
]
/** Playback speeds: slow motion helps checking fast movements, frame by frame is the ‹ › buttons. */
const SPEEDS = [1, 0.5, 0.25, 0.1]
const EMPTY: Tracking = { times: [], tracks: [] }
/** Manual zone ids stay clear of track ids (1, 2, 3…). */
let nextManualId = 1_000_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

/** Editing a video: same masking as photos, on every frame, with faces followed from frame to frame. */
export function VideoEditor({ file, settings, onSettings, onClose, onError }: Props) {
  const [video, setVideo] = useState<Video | null>(null)
  const [mode, setMode] = useState<AnalysisMode>('standard')
  const [analysis, setAnalysis] = useState<Analysis>({ status: 'analysing', progress: 0, remainingMs: null })
  const [tracking, setTracking] = useState<Tracking>(EMPTY)
  const [removed, setRemoved] = useState<Set<number>>(new Set())
  const [manual, setManual] = useState<ManualZone[]>([])
  const [frame, setFrame] = useState<Frame | null>(null)
  const [playing, setPlaying] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [engineReady, setEngineReady] = useState(false)
  const playingRef = useRef(false)
  const [speed, setSpeed] = useState(1)
  const speedRef = useRef(1)
  /** Wall-clock time at which the frame at `timestamp` was due; reset when the speed changes during playback. */
  const clock = useRef({ wall: 0, timestamp: 0 })

  useEffect(() => onEngineReady(() => setEngineReady(true)), [])

  useEffect(() => {
    let cancelled = false
    let opened: Video | null = null
    openVideo(file)
      .then(async (v) => {
        if (cancelled) return closeVideo(v)
        opened = v
        const first = await previewFrame(v, v.start)
        if (cancelled) return
        setFrame(first)
        setVideo(v)
      })
      .catch((error: Error) => !cancelled && onError(`${file.name} : ${error.message}`))
    return () => {
      cancelled = true
      playingRef.current = false
      if (opened) closeVideo(opened)
    }
  }, [file, onError])

  // Analysis, restarted when the mode changes. Tracks are rebuilt as frames come in, so faces show up early.
  useEffect(() => {
    if (!video) return
    const controller = new AbortController()
    const frames: AnalysedFrame[] = []
    const started = performance.now()
    let lastBuild = 0
    analyseVideo(
      video,
      mode,
      (analysed, progress) => {
        frames.push(analysed)
        const now = performance.now()
        if (now - lastBuild > 500) {
          lastBuild = now
          setTracking(buildTracks(frames))
        }
        setAnalysis({ status: 'analysing', progress, remainingMs: progress > 0.02 ? ((now - started) / progress) * (1 - progress) : null })
      },
      controller.signal,
    )
      .then(() => {
        setTracking(buildTracks(frames))
        setAnalysis({ status: 'ready' })
      })
      .catch((error: Error) => !controller.signal.aborted && setAnalysis({ status: 'error', message: error.message }))
    return () => controller.abort()
  }, [video, mode])

  // Scrubbing: one frame decoded at a time, always the latest one asked for.
  const seekState = useRef<{ wanted: number | null; busy: boolean }>({ wanted: null, busy: false })
  const seek = (t: number) => {
    if (!video) return
    const state = seekState.current
    state.wanted = t
    if (state.busy) return
    state.busy = true
    void (async () => {
      try {
        while (state.wanted !== null) {
          const target = state.wanted
          state.wanted = null
          setFrame(await previewFrame(video, target))
        }
      } catch (error) {
        onError((error as Error).message)
      } finally {
        state.busy = false
      }
    })()
  }

  /** Track ids change with a new analysis: faces removed by hand come back. */
  const changeMode = (next: AnalysisMode) => {
    setMode(next)
    setTracking(EMPTY)
    setRemoved(new Set())
    setAnalysis({ status: 'analysing', progress: 0, remainingMs: null })
  }

  const pause = () => {
    playingRef.current = false
    setPlaying(false)
  }

  /** Plays the masked preview (without sound), dropping frames when masking cannot keep up. */
  const play = async () => {
    if (!video || !frame) return
    playingRef.current = true
    setPlaying(true)
    setDrawing(false)
    const from = frame.timestamp >= video.end - 2 / video.frameRate ? video.start : frame.timestamp
    clock.current = { wall: performance.now(), timestamp: from }
    try {
      for await (const next of video.frames.canvases(from)) {
        if (!playingRef.current) break
        const due = () => clock.current.wall + ((next.timestamp - clock.current.timestamp) * 1000) / speedRef.current
        let wait = due() - performance.now()
        // Short sleeps, so that a speed change applies right away even in slow motion.
        while (wait > 0 && playingRef.current) {
          await sleep(Math.min(wait, 50))
          wait = due() - performance.now()
        }
        if (wait < -60) continue
        if (!playingRef.current) break
        setFrame(next)
      }
    } catch (error) {
      onError((error as Error).message)
    }
    pause()
  }

  const step = (direction: 1 | -1) => {
    if (!video || !frame) return
    pause()
    seek(direction > 0 ? frame.timestamp + 1.5 / video.frameRate : frame.timestamp - 0.5 / video.frameRate)
  }

  const changeSpeed = (next: number) => {
    if (frame) clock.current = { wall: performance.now(), timestamp: frame.timestamp }
    speedRef.current = next
    setSpeed(next)
  }

  // Keyboard: space plays or pauses, ← → step one frame (held down, they scroll slowly).
  const keys = useRef({ toggle: () => {}, step })
  useEffect(() => {
    keys.current = { toggle: () => (playingRef.current ? pause() : void play()), step }
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input, select, textarea, button, [role="dialog"]') || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === ' ') keys.current.toggle()
      else if (event.key === 'ArrowLeft') keys.current.step(-1)
      else if (event.key === 'ArrowRight') keys.current.step(1)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const threshold = scoreThreshold(settings.sensitivity)
  /** Every zone masked on the frame at `t`, as the export will mask it. */
  const zonesFor = useMemo(
    () => (t: number) =>
      zonesAbove(
        [
          ...zonesAt(tracking, t).filter((z) => !removed.has(z.id)),
          ...manual.filter((z) => z.start <= t && t <= z.end).map((z) => ({ id: z.id, ...keyframeBox(z.keys, t), score: null })),
        ],
        threshold,
      ),
    [tracking, removed, manual, threshold],
  )
  const timestamp = frame?.timestamp ?? null
  const zones = useMemo(() => (timestamp === null ? [] : zonesFor(timestamp)), [zonesFor, timestamp])

  if (!video || !frame) {
    return (
      <div className="toast">
        <div className="spinner" />
        Ouverture de la vidéo…
      </div>
    )
  }

  const selectedManual = manual.find((z) => z.id === selectedId) ?? null
  const selectedTrack = selectedId !== null && !selectedManual && zones.some((z) => z.id === selectedId)
  const updateManual = (id: number, patch: Partial<ManualZone>) => setManual((list) => list.map((z) => (z.id === id ? { ...z, ...patch } : z)))
  /** Keyframes closer than half a frame are on the same frame. */
  const sameFrame = 0.5 / video.frameRate
  const frameCount = Math.round((video.end - video.start) * video.frameRate)
  const frameNumber = (t: number) => Math.min(frameCount, Math.round((t - video.start) * video.frameRate) + 1)
  const keyHere = selectedManual?.keys.find((k) => Math.abs(k.t - frame.timestamp) < sameFrame) ?? null
  const previousKey = selectedManual?.keys.findLast((k) => k.t < frame.timestamp - sameFrame) ?? null
  const nextKey = selectedManual?.keys.find((k) => k.t > frame.timestamp + sameFrame) ?? null
  const percent = (t: number) => `${((t - video.start) / (video.end - video.start)) * 100}%`

  return (
    <main className="editor">
      <section className="workspace">
        <Stage
          photo={{ width: video.width, height: video.height, preview: frame.canvas }}
          zones={zones}
          options={settings}
          selectedId={selectedId}
          onSelect={setSelectedId}
          drawing={drawing}
          onDrawn={(rect) => {
            const zone: ManualZone = { id: nextManualId++, start: video.start, end: video.end, keys: [{ t: frame.timestamp, box: rect }] }
            setManual((list) => [...list, zone])
            setSelectedId(zone.id)
            setDrawing(false)
          }}
          // Moving a hand-drawn zone sets its position on this frame; during playback, it follows the pointer.
          onChange={({ id, x, y, w, h }) =>
            setManual((list) => list.map((z) => (z.id === id ? { ...z, keys: setKeyframe(z.keys, frame.timestamp, { x, y, w, h }, sameFrame) } : z)))
          }
          editable={(zone) => zone.score === null}
          showOriginal={showOriginal}
          zoom={zoom}
          onZoom={setZoom}
        />

        {analysis.status === 'analysing' && (
          <div className="busy">
            <div className="spinner" />
            <div className="busy-text">
              <span>
                {analysis.progress === 0
                  ? engineReady
                    ? 'Analyse des visages…'
                    : 'Préparation du moteur d’analyse…'
                  : `Analyse des visages · ${Math.round(analysis.progress * 100)} %`}
                {analysis.remainingMs !== null && ` · encore ~${formatDuration(analysis.remainingMs)}`}
              </span>
              <span className="progress-bar">
                <span style={{ width: `${analysis.progress * 100}%` }} />
              </span>
            </div>
          </div>
        )}
        {analysis.status === 'error' && (
          <div className="busy error">L’analyse a échoué : {analysis.message}. Ajoutez les zones à la main.</div>
        )}

        <div className="timeline">
          <button className="round" onClick={() => step(-1)} aria-label="Image précédente" title="Image précédente (←)">
            ‹
          </button>
          <button
            className="round"
            onClick={() => (playing ? pause() : void play())}
            aria-label={playing ? 'Pause' : 'Lecture'}
            title={playing ? 'Pause (espace)' : 'Lecture (espace)'}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button className="round" onClick={() => step(1)} aria-label="Image suivante" title="Image suivante (→)">
            ›
          </button>
          <select className="speed" value={speed} onChange={(event) => changeSpeed(Number(event.target.value))} aria-label="Vitesse de lecture">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {String(s).replace('.', ',')}×
              </option>
            ))}
          </select>
          <div className="scrubber">
            <input
              type="range"
              min={video.start}
              max={video.end}
              step="any"
              value={frame.timestamp}
              onChange={(event) => {
                pause()
                seek(Number(event.target.value))
              }}
              aria-label="Position dans la vidéo"
            />
            {selectedManual && (
              <div className="scrubber-marks" aria-hidden="true">
                <span className="scrubber-span" style={{ left: percent(selectedManual.start), right: `calc(100% - ${percent(selectedManual.end)})` }} />
                {selectedManual.keys.map((k) => (
                  <span key={k.t} className="scrubber-key" style={{ left: percent(k.t) }} />
                ))}
              </div>
            )}
          </div>
          <span className="time-label">
            {formatTime(frame.timestamp - video.start)} / {formatTime(video.end - video.start)}
            <br />
            image {frameNumber(frame.timestamp)} / {frameCount}
          </span>
        </div>
        <StageTools zoom={zoom} onZoom={setZoom} showOriginal={showOriginal} onShowOriginal={setShowOriginal} />
      </section>

      <aside className="panel">
        <MaskFields
          settings={settings}
          onSettings={onSettings}
          hint={`${zones.length} zone${zones.length > 1 ? 's' : ''} masquée${zones.length > 1 ? 's' : ''} sur cette image`}
        />

        <div className="field">
          <span className="label">Analyse</span>
          <Segmented options={MODES} value={mode} onChange={changeMode} />
          <span className="hint">
            {mode === 'standard'
              ? `${Math.round(1 / ANALYSIS.standard.interval)} images par seconde. Plus rapide, peut rater les très petits visages.`
              : `${Math.round(1 / ANALYSIS.deep.interval)} images par seconde, petits visages compris. Plusieurs fois plus lente.`}
          </span>
        </div>

        <div className="actions">
          <button
            className={`button${drawing ? ' active' : ''}`}
            onClick={() => {
              pause()
              setDrawing((d) => !d)
              setSelectedId(null)
            }}
          >
            {drawing ? 'Tracez la zone sur l’image…' : '+ Ajouter une zone'}
          </button>
          {selectedManual && (
            <div className="zone-range">
              <span className="hint">
                Masquée de l’image {frameNumber(selectedManual.start)} à l’image {frameNumber(selectedManual.end)} (
                {formatTime(selectedManual.start - video.start)} à {formatTime(selectedManual.end - video.start)})
              </span>
              <div className="zone-range-buttons">
                <button className="button" onClick={() => updateManual(selectedManual.id, { start: frame.timestamp, end: Math.max(selectedManual.end, frame.timestamp) })}>
                  Commencer ici
                </button>
                <button className="button" onClick={() => updateManual(selectedManual.id, { end: frame.timestamp, start: Math.min(selectedManual.start, frame.timestamp) })}>
                  Finir ici
                </button>
              </div>
              <span className="hint">
                {selectedManual.keys.length} position{selectedManual.keys.length > 1 ? 's' : ''} clé{selectedManual.keys.length > 1 ? 's' : ''}
                {keyHere ? ' · une sur cette image' : ''}. Pour suivre un élément, allez sur une autre image et déplacez la zone : entre
                deux positions, elle glisse d’elle-même. En lecture ralentie, vous pouvez aussi la tenir et la déplacer en continu.
              </span>
              <div className="zone-range-buttons">
                <button className="button" disabled={!previousKey} onClick={() => previousKey && (pause(), seek(previousKey.t))}>
                  ‹ Position préc.
                </button>
                <button className="button" disabled={!nextKey} onClick={() => nextKey && (pause(), seek(nextKey.t))}>
                  Position suiv. ›
                </button>
              </div>
              {keyHere && selectedManual.keys.length > 1 && (
                <button
                  className="button ghost"
                  onClick={() => updateManual(selectedManual.id, { keys: selectedManual.keys.filter((k) => k !== keyHere) })}
                >
                  Retirer la position de cette image
                </button>
              )}
              <button
                className="button danger"
                onClick={() => {
                  setManual((list) => list.filter((z) => z.id !== selectedManual.id))
                  setSelectedId(null)
                }}
              >
                Supprimer la zone
              </button>
            </div>
          )}
          {selectedTrack && (
            <button
              className="button danger"
              onClick={() => {
                setRemoved((set) => new Set(set).add(selectedId))
                setSelectedId(null)
              }}
            >
              Ne pas masquer ce visage (toute la vidéo)
            </button>
          )}
          {removed.size > 0 && (
            <button className="button ghost" onClick={() => setRemoved(new Set())}>
              Masquer à nouveau les visages retirés ({removed.size})
            </button>
          )}
          <button className="button ghost" onClick={onClose}>
            Fermer la vidéo
          </button>
        </div>

        <button
          className="button primary"
          onClick={() => {
            pause()
            setExporting(true)
          }}
          disabled={analysis.status === 'analysing'}
        >
          Exporter la vidéo
        </button>
      </aside>

      {exporting && <VideoExportDialog video={video} zonesFor={zonesFor} options={settings} onClose={() => setExporting(false)} />}
    </main>
  )
}

function formatDuration(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`
}

type Step =
  | { kind: 'confirm' }
  | { kind: 'rendering'; progress: number; remainingMs: number | null }
  | { kind: 'ready'; file: File }
  | { kind: 'error'; message: string }

function VideoExportDialog({ video, zonesFor, options, onClose }: { video: Video; zonesFor: (t: number) => Zone[]; options: Settings; onClose: () => void }) {
  const [checked, setChecked] = useState(false)
  const hasAudio = video.audio !== null && video.audioCopyable
  /** No default: whoever exports decides, knowingly, whether the sound goes into the file. */
  const [audio, setAudio] = useState<'remove' | 'keep' | null>(hasAudio ? null : 'remove')
  const keepAudio = audio === 'keep'
  const [step, setStep] = useState<Step>({ kind: 'confirm' })
  const controller = useRef<AbortController | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const render = async () => {
    controller.current = new AbortController()
    const started = performance.now()
    setStep({ kind: 'rendering', progress: 0, remainingMs: null })
    try {
      const file = await exportVideo(
        video,
        zonesFor,
        options,
        keepAudio,
        (progress) => {
          const elapsed = performance.now() - started
          setStep({ kind: 'rendering', progress, remainingMs: progress > 0.02 ? (elapsed / progress) * (1 - progress) : null })
        },
        controller.current.signal,
      )
      setStep({ kind: 'ready', file })
    } catch (error) {
      if (controller.current.signal.aborted) return
      setStep({ kind: 'error', message: (error as Error).message })
    }
  }

  const cancel = () => {
    controller.current?.abort()
    onClose()
  }

  return (
    <div className="dialog-backdrop" onClick={step.kind === 'rendering' ? undefined : onClose}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        {step.kind === 'confirm' && (
          <>
            <h2>Avant d’exporter</h2>
            <p>
              La détection automatique peut rater un visage : très petit, de profil, caché en partie, flou de mouvement,
              apparu un court instant. <strong>Regardez la vidéo en entier</strong> et ajoutez des zones si besoin.
            </p>
            <div className="metadata">
              <strong>Métadonnées</strong>
              {video.metadata === null ? (
                <p className="muted">Format non analysé. La vidéo exportée est un nouveau fichier : elle n’en contiendra aucune.</p>
              ) : video.metadata.length > 0 ? (
                <>
                  <p className="muted">Trouvées dans votre vidéo, toutes supprimées à l’export :</p>
                  <ul className="chips">
                    {video.metadata.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">Aucune trouvée. Le fichier exporté n’en contiendra aucune non plus.</p>
              )}
            </div>
            <div className="field sound">
              <span className="label">Son</span>
              {hasAudio ? (
                <>
                  <Segmented options={AUDIO_CHOICES} value={audio} onChange={setAudio} />
                  <span className="hint">
                    {audio === 'keep'
                      ? 'Le son est copié tel quel : une voix, un prénom prononcé ou un bruit de fond peuvent identifier quelqu’un.'
                      : audio === 'remove'
                        ? 'La vidéo exportée n’aura aucune piste son.'
                        : 'Choisissez : une voix, un prénom prononcé ou un bruit de fond peuvent identifier quelqu’un.'}
                  </span>
                </>
              ) : (
                <span className="hint">
                  {video.audio ? 'Format de son non conservable : la vidéo exportée sera muette.' : 'Cette vidéo n’a pas de son.'}
                </span>
              )}
            </div>
            <label className="check">
              <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
              J’ai vérifié que tous les visages sont masqués
            </label>
            <div className="dialog-actions">
              <button className="button ghost" onClick={onClose}>
                Retour
              </button>
              <button className="button primary" disabled={!checked || audio === null} onClick={() => void render()}>
                Générer la vidéo
              </button>
            </div>
          </>
        )}

        {step.kind === 'rendering' && (
          <>
            <div className="busy-inline">
              <div className="spinner" />
              <div className="busy-text">
                <span>
                  Encodage · {Math.round(step.progress * 100)} %{step.remainingMs !== null && ` · encore ~${formatDuration(step.remainingMs)}`}
                </span>
                <span className="progress-bar">
                  <span style={{ width: `${step.progress * 100}%` }} />
                </span>
              </div>
            </div>
            <div className="dialog-actions">
              <button className="button ghost" onClick={cancel}>
                Annuler
              </button>
            </div>
          </>
        )}

        {step.kind === 'ready' && (
          <>
            <h2>C’est prêt</h2>
            <p className="verified">✓ Vérifié : aucune métadonnée dans le fichier exporté.</p>
            <p className="muted">
              Vidéo anonymisée ({Math.round(step.file.size / 1024 / 1024)} Mo){keepAudio ? ', avec le son' : ', sans le son'}. Rien
              n’est enregistré tant que vous ne sauvegardez pas.
            </p>
            <div className="dialog-actions column">
              {canShareFiles([step.file]) && (
                <button
                  className="button primary"
                  onClick={() => shareFiles([step.file]).catch((error: Error) => setStep({ kind: 'error', message: error.message }))}
                >
                  Enregistrer / Partager
                </button>
              )}
              <button className="button" onClick={() => downloadFiles([step.file])}>
                Télécharger
              </button>
              <button className="button ghost" onClick={onClose}>
                Fermer
              </button>
            </div>
          </>
        )}

        {step.kind === 'error' && (
          <>
            <h2>Échec de l’export</h2>
            <p>{step.message}</p>
            <div className="dialog-actions">
              <button className="button ghost" onClick={onClose}>
                Fermer
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
