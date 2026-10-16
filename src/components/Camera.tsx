import { useEffect, useRef, useState } from 'react'

/** Whether the browser can show the camera in the page (secure context required). */
export const cameraAvailable = typeof navigator.mediaDevices?.getUserMedia === 'function'

type Facing = 'environment' | 'user'

interface ImageCaptureLike {
  takePhoto(): Promise<Blob>
}
const ImageCaptureApi = (globalThis as { ImageCapture?: new (track: MediaStreamTrack) => ImageCaptureLike }).ImageCapture

/**
 * Takes a photo inside the app. Unlike the phone's camera app, nothing is written to the camera roll: the
 * photo only exists in memory, until the masked version is exported.
 */
export function Camera({ onCapture, onClose }: { onCapture: (file: File) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [facing, setFacing] = useState<Facing>('environment')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    let opened: MediaStream | null = null
    navigator.mediaDevices
      .getUserMedia({ audio: false, video: { facingMode: facing, width: { ideal: 4096 }, height: { ideal: 3072 } } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        opened = s
        setStream(s)
      })
      .catch((e: DOMException) =>
        setError(
          e.name === 'NotAllowedError'
            ? 'L’accès à la caméra a été refusé. Autorisez-le dans les réglages du navigateur pour ce site.'
            : 'Impossible d’ouvrir la caméra.',
        ),
      )
    return () => {
      cancelled = true
      opened?.getTracks().forEach((t) => t.stop())
    }
  }, [facing])

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream
  }, [stream])

  const capture = async () => {
    const video = videoRef.current
    const track = stream?.getVideoTracks()[0]
    if (!video || !track || !video.videoWidth) return
    setBusy(true)
    try {
      let blob: Blob | null = null
      // Full sensor resolution where the browser offers it (Chrome on Android); otherwise the video frame.
      if (ImageCaptureApi) blob = await new ImageCaptureApi(track).takePhoto().catch(() => null)
      if (!blob) {
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d')!.drawImage(video, 0, 0)
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95))
        canvas.width = canvas.height = 0
      }
      if (!blob) throw new Error()
      onCapture(new File([blob], 'camera.jpg', { type: 'image/jpeg' }))
    } catch {
      setError('La photo n’a pas pu être prise.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="camera" role="dialog" aria-modal="true" aria-label="Appareil photo">
      {/* The front camera is shown as a mirror, as people expect; the photo itself is not mirrored. */}
      <video ref={videoRef} className={facing === 'user' ? 'mirrored' : ''} autoPlay playsInline muted />
      {error && <p className="camera-error">{error}</p>}
      <p className="camera-note">La photo reste dans l’app : elle n’est pas enregistrée dans votre pellicule.</p>
      <div className="camera-bar">
        <button className="button ghost" onClick={onClose}>
          Annuler
        </button>
        <button className="shutter" onClick={() => void capture()} disabled={!stream || busy} aria-label="Prendre la photo" />
        <button
          className="button ghost"
          onClick={() => {
            setStream(null)
            setError(null)
            setFacing((f) => (f === 'user' ? 'environment' : 'user'))
          }}
          aria-label="Changer de caméra"
        >
          ⟲
        </button>
      </div>
    </div>
  )
}
