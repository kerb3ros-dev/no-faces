import type { ReactNode } from 'react'
import type { Method, Shape } from '../lib/anonymize'
import { advancedSettingsAvailable } from '../lib/environment'
import type { Photo } from '../lib/photo'
import type { Settings } from '../lib/settings'

/** What touching the photo does, besides selecting zones. */
export type Tool = 'face' | 'area' | 'keep' | null

interface Props {
  settings: Settings
  onSettings: (patch: Partial<Settings>) => void
  photo: Photo
  zoneCount: number
  keptCount: number
  hiddenCount: number
  tool: Tool
  onTool: (tool: Tool) => void
  selected: boolean
  onDelete: () => void
  onReset: () => void
  onExport: () => void
  photoCount: number
  canExport: boolean
}

const METHODS: { value: Method; label: string }[] = [
  { value: 'blur', label: 'Flou' },
  { value: 'solid', label: 'Aplat' },
]
const SHAPES: { value: Shape; label: string }[] = [
  { value: 'ellipse', label: 'Ovale' },
  { value: 'rect', label: 'Rectangle' },
]
const COLORS = ['#000000', '#ffffff', '#6b7280', '#e11d48', '#2563eb']
const DEPTHS: { value: 'standard' | 'deep'; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'deep', label: 'Approfondie' },
]

/** Computers only: see `advancedSettingsAvailable`. */
const advanced = advancedSettingsAvailable()

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`

export function Controls(props: Props) {
  const { settings, onSettings, photo, tool, onTool } = props
  const toggle = (next: Tool) => onTool(tool === next ? null : next)
  return (
    <aside className="panel">
      <MaskFields
        settings={settings}
        onSettings={onSettings}
        hint={
          <>
            {photo.status === 'detecting' ? 'Analyse en cours…' : `${plural(props.zoneCount, 'zone')} masquée${props.zoneCount > 1 ? 's' : ''}`}
            {props.keptCount > 0 && ` · ${props.keptCount} laissée${props.keptCount > 1 ? 's' : ''} visible${props.keptCount > 1 ? 's' : ''}`}
            {props.hiddenCount > 0 && ` · ${plural(props.hiddenCount, 'détection')} incertaine${props.hiddenCount > 1 ? 's' : ''} ignorée${props.hiddenCount > 1 ? 's' : ''}`}
          </>
        }
      />

      {advanced && (
        <div className="field">
          <span className="label">Analyse des visages</span>
          <Segmented options={DEPTHS} value={settings.deep ? 'deep' : 'standard'} onChange={(depth) => onSettings({ deep: depth === 'deep' })} />
          <span className="hint">
            {settings.deep
              ? 'Modèle plus précis : trouve plus de visages petits, flous ou de profil. 2 à 3 fois plus lent ; 17 Mo téléchargés une fois, puis disponible hors ligne.'
              : 'Rapide. Passez en approfondie si un visage a été manqué.'}
          </span>
        </div>
      )}

      {advanced && (
        <label className="check toggle">
          <input type="checkbox" checked={settings.text} onChange={(event) => onSettings({ text: event.target.checked })} />
          <span>
            Masquer aussi le texte
            <span className="hint">
              Plaques d’immatriculation, noms de rue, badges, écrans… Le texte n’est pas lu, seulement repéré. Pour un tatouage,
              tracez une zone libre.
            </span>
          </span>
        </label>
      )}

      <div className="actions">
        <button className={`button${tool === 'face' ? ' active' : ''}`} onClick={() => toggle('face')}>
          {tool === 'face' ? 'Tracez le visage…' : '+ Visage'}
        </button>
        <button className={`button${tool === 'area' ? ' active' : ''}`} onClick={() => toggle('area')} title="Rectangle masqué tel que tracé : texte, plaque, tatouage…">
          {tool === 'area' ? 'Tracez la zone…' : '+ Zone libre'}
        </button>
        <button className={`button${tool === 'keep' ? ' active' : ''}`} onClick={() => toggle('keep')}>
          {tool === 'keep' ? 'Terminé' : 'Tout masquer sauf…'}
        </button>
        {tool === 'keep' && <span className="hint full">Touchez un visage pour le laisser visible, touchez-le à nouveau pour le masquer.</span>}
        {props.selected && (
          <button className="button danger" onClick={props.onDelete}>
            Supprimer la zone
          </button>
        )}
        {photo.status === 'ready' && (
          <button className="button ghost" onClick={props.onReset}>
            Réinitialiser les zones
          </button>
        )}
      </div>

      <button className="button primary" onClick={props.onExport} disabled={!props.canExport}>
        {props.photoCount > 1 ? `Exporter les ${props.photoCount} photos` : 'Exporter la photo'}
      </button>
      <span className="hint">Rien n’est enregistré : si la page se recharge ou se ferme, le travail en cours est perdu. Exportez avant de quitter.</span>
    </aside>
  )
}

/** Masking method, shape, margin and detection sensitivity: shared by photos and videos. Phones and tablets get the method only. */
export function MaskFields({ settings, onSettings, hint }: { settings: Settings; onSettings: (patch: Partial<Settings>) => void; hint: ReactNode }) {
  return (
    <>
      <div className="field">
        <span className="label">Masquage</span>
        <Segmented options={METHODS} value={settings.method} onChange={(method) => onSettings({ method })} />
        {settings.method === 'solid' && (
          <div className="swatches">
            {COLORS.map((color) => (
              <button
                key={color}
                className={`swatch${settings.color === color ? ' active' : ''}`}
                style={{ background: color }}
                onClick={() => onSettings({ color })}
                aria-label={`Couleur ${color}`}
              />
            ))}
          </div>
        )}
        {!advanced && (
          <span className="hint">
            {hint}
            <br />
            Forme, marge, sensibilité et analyse approfondie : sur ordinateur.
          </span>
        )}
      </div>

      {advanced && (
        <>
          <div className="field">
            <span className="label">Forme</span>
            <Segmented options={SHAPES} value={settings.shape} onChange={(shape) => onSettings({ shape })} />
          </div>

          <label className="field">
            <span className="label">
              Marge autour du visage <output>{Math.round(settings.margin * 100)} %</output>
            </span>
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.05}
              value={settings.margin}
              onChange={(event) => onSettings({ margin: Number(event.target.value) })}
            />
          </label>

          <label className="field">
            <span className="label">
              Sensibilité de la détection <output>{settings.sensitivity}</output>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.sensitivity}
              onChange={(event) => onSettings({ sensitivity: Number(event.target.value) })}
            />
            <span className="hint">{hint}</span>
          </label>
        </>
      )}
    </>
  )
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T | null; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
