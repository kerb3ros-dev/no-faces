import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { applyMask, coreOf, type MaskOptions } from '../lib/anonymize'
import { releaseCanvas, type Zone } from '../lib/photo'
import { MAX_ZOOM, ZOOMS } from '../lib/settings'

/** What is edited: a photo, or the current frame of a video. Zones are in `width` × `height` pixels. */
export interface StageImage {
  width: number
  height: number
  preview: HTMLCanvasElement | OffscreenCanvas
}

interface Props {
  photo: StageImage
  zones: Zone[]
  options: MaskOptions
  selectedId: number | null
  onSelect: (id: number | null) => void
  drawing: boolean
  onDrawn: (zone: Omit<Zone, 'id' | 'score'>) => void
  onChange: (zone: Zone) => void
  showOriginal: boolean
  zoom: number
  onZoom: (zoom: number) => void
  /** Zones that can be moved and resized; the others can only be selected. All of them by default. */
  editable?: (zone: Zone) => boolean
  /** "Tout masquer sauf…": touching a zone calls this instead of selecting it. */
  onPick?: (zone: Zone) => void
}

type Drag =
  | { kind: 'move'; zone: Zone; startX: number; startY: number }
  | { kind: 'resize'; zone: Zone; corner: [number, number] }
  | { kind: 'draw'; startX: number; startY: number }
  /** Moving around a zoomed photo, with a finger or the mouse. A tap without moving deselects. */
  | { kind: 'pan'; clientX: number; clientY: number; scrollLeft: number; scrollTop: number; moved: boolean }

/** A point of the photo (as a fraction of its size) that must end up under a point of the screen. */
interface Anchor {
  fx: number
  fy: number
  clientX: number
  clientY: number
}

const HANDLE_PX = 11
const MIN_ZONE_PX = 12
/** Below this, a press on the background is a tap, not a pan. */
const TAP_SLOP_PX = 6

const clampZoom = (zoom: number) => clamp(zoom, 1, MAX_ZOOM)

/** The masked preview, with the zones drawn on top and editable by mouse or touch. */
export function Stage({ photo, zones, options, selectedId, onSelect, drawing, onDrawn, onChange, showOriginal, zoom, onZoom, editable = () => true, onPick }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [fit, setFit] = useState({ width: 0, height: 0 })
  const [drag, setDrag] = useState<Drag | null>(null)
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // Fit the photo in the available space; zoom multiplies that size and the container scrolls.
  useLayoutEffect(() => {
    const el = scrollRef.current!
    const update = () => {
      const scale = Math.min(el.clientWidth / photo.width, el.clientHeight / photo.height)
      setFit({ width: photo.width * scale, height: photo.height * scale })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [photo.width, photo.height])

  // --- Zoom ---------------------------------------------------------------------------------------------

  const zoomRef = useRef(zoom)
  const onZoomRef = useRef(onZoom)
  useLayoutEffect(() => {
    onZoomRef.current = onZoom
  })
  const anchor = useRef<Anchor | null>(null)

  const anchorAt = (clientX: number, clientY: number): Anchor => {
    const rect = contentRef.current!.getBoundingClientRect()
    return { fx: (clientX - rect.left) / rect.width, fy: (clientY - rect.top) / rect.height, clientX, clientY }
  }

  /** Scrolls so that the anchor's point of the photo is under its point of the screen. */
  const applyAnchor = (a: Anchor) => {
    const el = scrollRef.current!
    const rect = contentRef.current!.getBoundingClientRect()
    el.scrollLeft += rect.left + a.fx * rect.width - a.clientX
    el.scrollTop += rect.top + a.fy * rect.height - a.clientY
  }

  /** Zooms keeping `a` in place (pinch, Ctrl + scroll); buttons keep the centre of the view in place. */
  const zoomTo = (next: number, a: Anchor) => {
    if (next === zoomRef.current) {
      applyAnchor(a)
      return
    }
    anchor.current = a
    onZoomRef.current(next)
  }

  useLayoutEffect(() => {
    const el = scrollRef.current!
    const ratio = zoom / zoomRef.current
    zoomRef.current = zoom
    if (ratio === 1) return
    if (anchor.current) {
      applyAnchor(anchor.current)
      anchor.current = null
      return
    }
    el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2
    el.scrollTop = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2
  }, [zoom])

  // Ctrl + scroll (also what a laptop's trackpad pinch sends): zoom under the pointer instead of the whole page.
  useEffect(() => {
    const el = scrollRef.current!
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      zoomTo(clampZoom(zoomRef.current * Math.exp(-event.deltaY * 0.01)), anchorAt(event.clientX, event.clientY))
    }
    // iOS Safari: no page zoom when pinching the photo; the pinch is handled below.
    const gesture = (event: Event) => event.preventDefault()
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('gesturestart', gesture)
    return () => {
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('gesturestart', gesture)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reads refs
  }, [])

  // Two fingers: pinch to zoom, and move together to pan. Tracked on the whole stage, before the zones see them.
  const touches = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number; zoom: number; fx: number; fy: number } | null>(null)

  const pinchPoints = () => {
    const [a, b] = [...touches.current.values()]
    return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  const onTouchDown = (event: ReactPointerEvent) => {
    if (event.pointerType === 'mouse') return
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (touches.current.size < 2) return
    event.stopPropagation()
    if (pinch.current) return
    // The first finger may have started moving a zone: put it back.
    if (drag?.kind === 'move' || drag?.kind === 'resize') onChange(drag.zone)
    setDrag(null)
    setDraft(null)
    const p = pinchPoints()
    const a = anchorAt(p.x, p.y)
    pinch.current = { distance: p.distance, zoom: zoomRef.current, fx: a.fx, fy: a.fy }
  }

  const onTouchMove = (event: ReactPointerEvent) => {
    if (!touches.current.has(event.pointerId)) return
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const start = pinch.current
    if (!start || touches.current.size < 2) return
    event.stopPropagation()
    const p = pinchPoints()
    zoomTo(clampZoom((start.zoom * p.distance) / start.distance), { fx: start.fx, fy: start.fy, clientX: p.x, clientY: p.y })
  }

  const onTouchUp = (event: ReactPointerEvent) => {
    if (!touches.current.delete(event.pointerId)) return
    if (pinch.current) event.stopPropagation()
    // The finger left on the screen does nothing until lifted.
    if (touches.current.size < 2) pinch.current = null
  }

  // --- Rendering ----------------------------------------------------------------------------------------

  // Zones left visible on purpose are shown, not masked.
  const masked = useMemo(() => zones.filter((z) => !z.keep), [zones])

  // While a zone is dragged, the other zones are masked once into this cache and only the dragged one is
  // redrawn at each move: on a phone, re-masking every face at every frame makes dragging stutter.
  const dragCache = useRef<{ others: Zone[]; canvas: HTMLCanvasElement } | null>(null)
  const draggedId = drag && (drag.kind === 'move' || drag.kind === 'resize') ? drag.zone.id : null

  // Only what the drawing depends on: `photo` itself changes with every progress update.
  const { preview, width: photoWidth } = photo

  useEffect(() => {
    const frame = requestAnimationFrame(() => render())
    const render = () => {
      const canvas = canvasRef.current!
      if (canvas.width !== preview.width || canvas.height !== preview.height) {
        canvas.width = preview.width
        canvas.height = preview.height
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      const k = preview.width / photoWidth
      const mask = (target: CanvasRenderingContext2D, list: Zone[]) =>
        applyMask(target, list.map((z) => ({ x: z.x * k, y: z.y * k, w: z.w * k, h: z.h * k, seed: z.id, kind: z.kind })), options)

      const others = masked.filter((z) => z.id !== draggedId)
      const cache = dragCache.current
      const cacheValid = cache && cache.others.length === others.length && cache.others.every((z, i) => z === others[i])
      if (cache && (draggedId === null || !cacheValid)) {
        releaseCanvas(cache.canvas)
        dragCache.current = null
      }
      if (showOriginal || draggedId === null) {
        ctx.drawImage(preview, 0, 0)
        if (!showOriginal) mask(ctx, masked)
        return
      }
      if (!dragCache.current) {
        const cached = document.createElement('canvas')
        cached.width = preview.width
        cached.height = preview.height
        const cachedCtx = cached.getContext('2d', { willReadFrequently: true })!
        cachedCtx.drawImage(preview, 0, 0)
        mask(cachedCtx, others)
        dragCache.current = { others, canvas: cached }
      }
      ctx.drawImage(dragCache.current.canvas, 0, 0)
      mask(ctx, masked.filter((z) => z.id === draggedId))
    }
    return () => cancelAnimationFrame(frame)
  }, [preview, photoWidth, masked, options, showOriginal, draggedId])

  // --- Editing ------------------------------------------------------------------------------------------

  const width = fit.width * zoom
  const height = fit.height * zoom
  const unit = width ? photo.width / width : 1 // image pixels per screen pixel

  const toImage = (event: { clientX: number; clientY: number }) => {
    const ctm = svgRef.current!.getScreenCTM()!.inverse()
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm)
    return { x: Math.min(photo.width, Math.max(0, p.x)), y: Math.min(photo.height, Math.max(0, p.y)) }
  }

  const begin = (event: ReactPointerEvent, next: Drag) => {
    event.stopPropagation()
    svgRef.current!.setPointerCapture(event.pointerId)
    setDrag(next)
  }

  const onBackgroundDown = (event: ReactPointerEvent) => {
    if (!drawing) {
      const el = scrollRef.current!
      begin(event, { kind: 'pan', clientX: event.clientX, clientY: event.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, moved: false })
      return
    }
    const p = toImage(event)
    begin(event, { kind: 'draw', startX: p.x, startY: p.y })
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onMove = (event: ReactPointerEvent) => {
    if (!drag) return
    if (drag.kind === 'pan') {
      const dx = event.clientX - drag.clientX
      const dy = event.clientY - drag.clientY
      if (!drag.moved && Math.hypot(dx, dy) < TAP_SLOP_PX) return
      if (!drag.moved) setDrag({ ...drag, moved: true })
      const el = scrollRef.current!
      el.scrollLeft = drag.scrollLeft - dx
      el.scrollTop = drag.scrollTop - dy
      return
    }
    const p = toImage(event)
    if (drag.kind === 'draw') {
      setDraft(rectFrom(drag.startX, drag.startY, p.x, p.y))
    } else if (drag.kind === 'move') {
      const { zone } = drag
      onChange({
        ...zone,
        x: clamp(zone.x + p.x - drag.startX, 0, photo.width - zone.w),
        y: clamp(zone.y + p.y - drag.startY, 0, photo.height - zone.h),
      })
    } else {
      const { zone, corner } = drag
      // The opposite corner stays fixed.
      const fixedX = corner[0] ? zone.x : zone.x + zone.w
      const fixedY = corner[1] ? zone.y : zone.y + zone.h
      onChange({ ...zone, ...rectFrom(fixedX, fixedY, p.x, p.y, MIN_ZONE_PX * unit) })
    }
  }

  const onUp = () => {
    if (drag?.kind === 'draw' && draft && draft.w >= MIN_ZONE_PX * unit && draft.h >= MIN_ZONE_PX * unit) onDrawn(draft)
    if (drag?.kind === 'pan' && !drag.moved) onSelect(null)
    setDrag(null)
    setDraft(null)
  }

  return (
    <div
      className="stage"
      ref={scrollRef}
      onPointerDownCapture={onTouchDown}
      onPointerMoveCapture={onTouchMove}
      onPointerUpCapture={onTouchUp}
      onPointerCancelCapture={onTouchUp}
    >
      <div className="stage-content" ref={contentRef} style={{ width, height }}>
        <canvas ref={canvasRef} className="stage-canvas" />
        <svg
          ref={svgRef}
          className={`stage-overlay${drawing ? ' drawing' : ''}${onPick ? ' picking' : ''}${drag?.kind === 'pan' && drag.moved ? ' panning' : ''}`}
          viewBox={`0 0 ${photo.width} ${photo.height}`}
          onPointerDown={onBackgroundDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {!showOriginal &&
            zones.map((zone) => {
              const selected = zone.id === selectedId
              const core = coreOf({ ...zone, seed: 0 }, options)
              const classes = ['zone', selected && 'selected', zone.score === null && 'manual', zone.kind === 'area' && 'area', zone.keep && 'kept']
              return (
                <g key={zone.id} className={classes.filter(Boolean).join(' ')}>
                  {selected &&
                    !zone.keep &&
                    (core.ellipse ? (
                      <ellipse className="zone-core" cx={core.cx} cy={core.cy} rx={core.rx} ry={core.ry} />
                    ) : (
                      <rect className="zone-core" x={core.cx - core.rx} y={core.cy - core.ry} width={core.rx * 2} height={core.ry * 2} />
                    ))}
                  <rect
                    className="zone-box"
                    x={zone.x}
                    y={zone.y}
                    width={zone.w}
                    height={zone.h}
                    onPointerDown={(event) => {
                      if (onPick) {
                        event.stopPropagation()
                        onPick(zone)
                        return
                      }
                      onSelect(zone.id)
                      if (!editable(zone)) {
                        event.stopPropagation()
                        return
                      }
                      const p = toImage(event)
                      begin(event, { kind: 'move', zone, startX: p.x, startY: p.y })
                    }}
                  />
                  {zone.keep && (
                    <text className="zone-label" x={zone.x + zone.w / 2} y={zone.y - 4 * unit} fontSize={12 * unit}>
                      visible
                    </text>
                  )}
                  {selected &&
                    !onPick &&
                    editable(zone) &&
                    ([[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]).map((corner) => (
                      <circle
                        key={corner.join()}
                        className="zone-handle"
                        cx={zone.x + corner[0] * zone.w}
                        cy={zone.y + corner[1] * zone.h}
                        r={HANDLE_PX * unit}
                        onPointerDown={(event) => begin(event, { kind: 'resize', zone, corner })}
                      />
                    ))}
                </g>
              )
            })}
          {draft && <rect className="zone-draft" x={draft.x} y={draft.y} width={draft.w} height={draft.h} />}
        </svg>
      </div>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function rectFrom(ax: number, ay: number, bx: number, by: number, minSize = 0) {
  const w = Math.max(minSize, Math.abs(bx - ax))
  const h = Math.max(minSize, Math.abs(by - ay))
  return { x: bx < ax ? ax - w : ax, y: by < ay ? ay - h : ay, w, h }
}

const formatZoom = (zoom: number) => `${String(Math.round(zoom * 10) / 10).replace('.', ',')}×`

/** Zoom buttons and the "hold to see the original" button, under the stage. */
export function StageTools({ zoom, onZoom, showOriginal, onShowOriginal }: { zoom: number; onZoom: (zoom: number) => void; showOriginal: boolean; onShowOriginal: (show: boolean) => void }) {
  // Buttons go to the next step of ZOOMS, wherever pinching left the zoom.
  const smaller = ZOOMS.findLast((z) => z < zoom - 0.01) ?? 1
  const larger = ZOOMS.find((z) => z > zoom + 0.01) ?? MAX_ZOOM
  return (
    <div className="stage-tools">
      <button className="round" onClick={() => onZoom(smaller)} disabled={zoom <= 1} aria-label="Dézoomer">
        −
      </button>
      <span className="zoom-label">{formatZoom(zoom)}</span>
      <button className="round" onClick={() => onZoom(larger)} disabled={zoom >= MAX_ZOOM} aria-label="Zoomer">
        +
      </button>
      <button
        className={`round wide${showOriginal ? ' on' : ''}`}
        onPointerDown={() => onShowOriginal(true)}
        onPointerUp={() => onShowOriginal(false)}
        onPointerLeave={() => onShowOriginal(false)}
        onContextMenu={(event) => event.preventDefault()}
      >
        Maintenir : original
      </button>
    </div>
  )
}
