import { useEffect, useState } from 'react'
import type { MaskOptions } from './anonymize'
import { advancedSettingsAvailable } from './environment'

export interface Settings extends MaskOptions {
  /** 0–100; higher keeps less confident detections. */
  sensitivity: number
  /** Photos: the larger face model (SCRFD 10G), slower and more accurate. */
  deep: boolean
  /** Photos: also mask text (licence plates, signs, badges…). */
  text: boolean
}

/** Steps of the zoom buttons; pinching and Ctrl + scroll zoom continuously between the ends. */
export const ZOOMS = [1, 1.5, 2, 3, 4, 6]
export const MAX_ZOOM = ZOOMS[ZOOMS.length - 1]

// v2: smaller default margin and no more mosaic; older saved settings are ignored.
const KEY = 'no-faces.settings.v2'
const DEFAULTS: Settings = {
  method: 'blur',
  shape: 'ellipse',
  margin: 0.1,
  color: '#000000',
  sensitivity: 70,
  deep: false,
  text: false,
}

/** Detector score a zone needs to be masked. Default sensitivity 70 → 0.40, below the usual 0.5: missing a face is worse than masking a false positive. */
export function scoreThreshold(sensitivity: number): number {
  return 0.75 - (sensitivity / 100) * 0.5
}

function load(): Settings {
  try {
    const saved: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
    // Phones and tablets: only the method and its colour can be changed, whatever was saved before.
    return advancedSettingsAvailable() ? saved : { ...DEFAULTS, method: saved.method, color: saved.color }
  } catch {
    return DEFAULTS
  }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState(load)
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {
      // Private browsing: settings simply won't persist.
    }
  }, [settings])
  return [settings, (patch) => setSettings((s) => ({ ...s, ...patch }))]
}
