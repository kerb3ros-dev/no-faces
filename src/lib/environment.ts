/**
 * Tight numeric loop: a few ms with an optimising JavaScript compiler (JIT), 100+ without. Hardened browsers
 * such as GrapheneOS's Vanadium disable the JIT by default, which also makes WebAssembly — the face
 * detector — run in a very slow interpreter.
 */
export function jsBenchmarkMs(): number {
  const data = new Float32Array(1 << 16)
  const start = performance.now()
  let sum = 0
  for (let round = 0; round < 40; round++) {
    for (let i = 0; i < data.length; i++) {
      data[i] = data[i] * 0.5 + i * 0.25
      sum += data[i]
    }
  }
  if (sum === -1) console.log(sum) // keeps the loop from being optimised away
  return performance.now() - start
}

/** About 5 ms with a JIT on a phone; jitless browsers take 20× longer. */
export function jitLooksDisabled(): boolean {
  return jsBenchmarkMs() > 40
}

/** iPhone and iPad, including iPadOS (which presents itself as a Mac). */
export function isAppleMobile(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/**
 * Whether the detector may use the GPU. Not on iPhone and iPad: in Safari, a WebGPU session keeps about 1.3 GB
 * (WebAssembly alone: about 350 MB), and iOS then kills the tab — Safari reloads it, losing the photos.
 */
export function gpuAllowed(): boolean {
  return !isAppleMobile()
}

/**
 * Shape, margin, sensitivity, deep analysis and text: computers only. On phones and tablets, the larger model
 * and the text detector take Safari past 1.3 GB and iOS kills the tab; the masking method alone is offered.
 */
export function advancedSettingsAvailable(): boolean {
  return !isMobileDevice()
}

/** Phones and tablets, including iPadOS (which presents itself as a Mac) and Android in "desktop site" mode. */
export function isMobileDevice(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { mobile: boolean } }).userAgentData
  if (uaData?.mobile) return true
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true
  // Touch screen as the main pointer: tablets, including those asking for the desktop version of sites.
  return !matchMedia('(pointer: fine)').matches
}

/**
 * Why videos cannot be processed here, or null if they can. Video is reserved for computers: analysing and
 * re-encoding every frame takes minutes of full CPU/GPU load and a lot of memory, too much for a phone.
 */
export function videoUnavailableReason(): string | null {
  if (isMobileDevice()) return 'La vidéo est disponible sur ordinateur uniquement : elle demande trop de ressources pour un téléphone ou une tablette.'
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
    return 'Ce navigateur ne sait pas traiter la vidéo (WebCodecs absent). Utilisez une version récente de Chrome, Edge, Firefox ou Safari.'
  }
  return null
}
