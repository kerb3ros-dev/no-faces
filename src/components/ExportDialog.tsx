import { useState } from 'react'
import { exportPhoto, maskedZones, zonesAbove, type Photo } from '../lib/photo'
import { canShareFiles, downloadFiles, shareFiles } from '../lib/save'
import type { MaskOptions } from '../lib/anonymize'

interface Props {
  photos: Photo[]
  options: MaskOptions
  threshold: number
  onClose: () => void
}

type Step = { kind: 'confirm' } | { kind: 'rendering'; done: number } | { kind: 'ready'; files: File[] } | { kind: 'error'; message: string }

/**
 * Export happens in two clicks: rendering can take a few seconds, and browsers only open the share sheet
 * from a fresh user gesture.
 */
export function ExportDialog({ photos, options, threshold, onClose }: Props) {
  const [checked, setChecked] = useState(false)
  const [step, setStep] = useState<Step>({ kind: 'confirm' })
  const exportable = photos.filter((p) => p.status !== 'detecting')
  const found = [...new Set(exportable.flatMap((p) => p.metadata ?? []))]
  const kept = exportable.reduce((n, p) => n + zonesAbove(p.zones, threshold).filter((z) => z.keep).length, 0)

  const render = async () => {
    const files: File[] = []
    try {
      for (const photo of exportable) {
        setStep({ kind: 'rendering', done: files.length })
        files.push(await exportPhoto(photo, maskedZones(photo, threshold), options))
      }
      setStep({ kind: 'ready', files })
    } catch (error) {
      setStep({ kind: 'error', message: (error as Error).message })
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        {step.kind === 'confirm' && (
          <>
            <h2>Avant d’exporter</h2>
            <p>
              La détection automatique peut rater un visage : très petit, de profil, caché en partie, dans un reflet, sur une
              affiche ou un écran. <strong>Zoomez et vérifiez chaque photo.</strong>
            </p>
            {kept > 0 && (
              <p className="warning">
                {kept > 1 ? `${kept} zones restent visibles` : 'Une zone reste visible'} à votre demande (« Tout masquer sauf… »).
              </p>
            )}
            <div className="metadata">
              <strong>Métadonnées</strong>
              {found.length > 0 ? (
                <>
                  <p className="muted">Trouvées dans {exportable.length > 1 ? 'vos photos' : 'votre photo'}, toutes supprimées à l’export :</p>
                  <ul className="chips">
                    {found.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">Aucune trouvée. Le fichier exporté n’en contiendra aucune non plus.</p>
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
              <button className="button primary" disabled={!checked} onClick={() => void render()}>
                Générer {exportable.length > 1 ? `les ${exportable.length} photos` : 'la photo'}
              </button>
            </div>
          </>
        )}

        {step.kind === 'rendering' && (
          <div className="busy-inline">
            <div className="spinner" />
            Préparation {step.done + 1} / {exportable.length}…
          </div>
        )}

        {step.kind === 'ready' && (
          <>
            <h2>C’est prêt</h2>
            <p className="verified">✓ Vérifié : aucune métadonnée dans {step.files.length > 1 ? 'les fichiers exportés' : 'le fichier exporté'}.</p>
            <p className="muted">
              {step.files.length > 1 ? `${step.files.length} photos anonymisées.` : 'Photo anonymisée.'} Rien n’est
              enregistré tant que vous ne sauvegardez pas.
            </p>
            <div className="dialog-actions column">
              {canShareFiles(step.files) && (
                <button
                  className="button primary"
                  onClick={() => shareFiles(step.files).catch((error: Error) => setStep({ kind: 'error', message: error.message }))}
                >
                  Enregistrer / Partager
                </button>
              )}
              <button className="button" onClick={() => downloadFiles(step.files)}>
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
