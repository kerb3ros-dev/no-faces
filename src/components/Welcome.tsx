import { useEffect, useState } from 'react'
import { isAppleMobile, isMobileDevice } from '../lib/environment'
import { Emblem, IconCrosshair, IconDocument, IconEye, IconFolder, IconInfo } from './Icons'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

const isIos = isAppleMobile()
const isMobile = isMobileDevice()
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

/**
 * Public repository of the code. The AGPL (section 13) asks that people using the app online be offered its
 * source: set this before deploying. Left empty, only the licence is linked.
 */
const SOURCE_URL: string = ''

/** `videoReason`: why videos are refused on this device, or null if they are accepted. `onCamera`: null without a camera API. */
export function Welcome({ onPick, onCamera, videoReason }: { onPick: () => void; onCamera: (() => void) | null; videoReason: string | null }) {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)

  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', capture)
    return () => window.removeEventListener('beforeinstallprompt', capture)
  }, [])

  return (
    <main className="welcome">
      <div className="welcome-inner">
        <span className="hero-emblem">
          <Emblem size={88} />
        </span>
        <p className="eyebrow">Anonymisation · 100 % sur l’appareil</p>
        <h1>
          Masquez les visages de vos {videoReason ? 'photos' : 'photos et vidéos'}, <em>pour de bon.</em>
        </h1>
        <p className="lead">
          Les visages sont remplacés, pas simplement floutés : aucune IA ne peut les reconstituer, parce que
          l’information n’existe plus dans l’image.
        </p>
        <button className="button primary big" onClick={onPick}>
          {videoReason ? 'Choisir des photos' : 'Choisir des photos ou une vidéo'}
        </button>
        {onCamera && (
          <button className="button big camera-button" onClick={onCamera}>
            Prendre une photo
          </button>
        )}
        <p className="drop-hint">ou glissez-les ici</p>
        {videoReason && (
          <aside className="video-note">
            <IconInfo size={22} />
            {isMobile ? (
              <p>
                <strong>Et les vidéos ?</strong> Sur ordinateur (Windows, macOS ou Linux), no-faces masque aussi les visages
                de vos vidéos, toujours sans rien envoyer. Le traitement est trop lourd pour un téléphone ou une tablette.
              </p>
            ) : (
              <p>{videoReason}</p>
            )}
          </aside>
        )}

        <ul className="promises">
          <li>
            <IconFolder size={24} />
            <span>
              <strong>Rien ne quitte votre appareil.</strong> Tout le traitement se fait ici, même en mode avion.
            </span>
          </li>
          <li>
            <IconCrosshair size={24} />
            <span>
              <strong>Détection automatique</strong> des visages, puis vérification et retouche à la main.
            </span>
          </li>
          <li>
            <IconEye size={24} />
            <span>
              <strong>Photo prise dans l’app</strong> : l’original n’est jamais enregistré dans la pellicule.
            </span>
          </li>
          <li>
            <IconDocument size={24} />
            <span>
              <strong>Métadonnées supprimées</strong> à l’export : position GPS, appareil, date et miniature cachée.
            </span>
          </li>
        </ul>

        {!isStandalone && (installPrompt || isMobile) && (
          <div className="install">
            {isMobile && <p className="install-title">Pour obtenir l’application sur smartphone :</p>}
            {installPrompt ? (
              <button className="button ghost" onClick={() => void installPrompt.prompt()}>
                Installer l’application
              </button>
            ) : (
              <ol className="install-steps">{isIos ? <IosSteps /> : <AndroidSteps />}</ol>
            )}
          </div>
        )}

        <footer className="welcome-footer">
          <a className="link" href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">
            Logiciel libre · AGPL-3.0
          </a>
          {SOURCE_URL && (
            <a className="link" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
              Code source
            </a>
          )}
        </footer>
      </div>
    </main>
  )
}

/** Adding the site to the home screen by hand: iOS has no install prompt, nor do some Android browsers. */
function IosSteps() {
  return (
    <>
      <li>
        Ouvrez ce site dans <strong>Safari</strong>.
      </li>
      <li>
        Touchez le bouton <strong>Partager</strong> (le carré avec une flèche vers le haut ; sur les iOS récents, il est
        dans le menu <strong>⋯</strong>).
      </li>
      <li>
        Touchez <strong>« Sur l’écran d’accueil »</strong>, plus bas dans la liste.
      </li>
      <li>
        Touchez <strong>Ajouter</strong> : no-faces apparaît sur l’écran d’accueil, comme une application.
      </li>
    </>
  )
}

function AndroidSteps() {
  return (
    <>
      <li>
        Ouvrez le menu <strong>⋮</strong> du navigateur, en haut à droite.
      </li>
      <li>
        Touchez <strong>« Installer l’application »</strong> ou <strong>« Ajouter à l’écran d’accueil »</strong>.
      </li>
      <li>Confirmez : no-faces apparaît sur l’écran d’accueil, comme une application.</li>
    </>
  )
}
