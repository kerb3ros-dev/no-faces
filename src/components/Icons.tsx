import type { ReactNode } from 'react'

/** Icons of the UI kit (site_ui_vector_kit), drawn in the current text colour. */
function Icon({ size = 20, children }: { size?: number; children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 128 128" width={size} height={size} fill="none" stroke="currentColor" aria-hidden="true">
      {children}
    </svg>
  )
}

type Size = { size?: number }

export const IconPlus = (p: Size) => (
  <Icon {...p}>
    <path d="M64 20 V108 M20 64 H108" strokeWidth="12" />
  </Icon>
)

export const IconClose = (p: Size) => (
  <Icon {...p}>
    <path d="M28 28 L100 100 M100 28 L28 100" strokeWidth="12" />
  </Icon>
)

export const IconAlert = (p: Size) => (
  <Icon {...p}>
    <path d="M64 12 L118 108 H10 Z" fill="currentColor" stroke="none" />
    <path d="M64 42 V72" stroke="var(--black)" strokeWidth="8" />
    <circle cx="64" cy="88" r="4" fill="var(--black)" stroke="none" />
  </Icon>
)

export const IconInfo = (p: Size) => (
  <Icon {...p}>
    <circle cx="64" cy="64" r="44" strokeWidth="8" />
    <circle cx="64" cy="39" r="6" fill="currentColor" stroke="none" />
    <path d="M64 56 V89" strokeWidth="10" />
  </Icon>
)

export const IconCrosshair = (p: Size) => (
  <Icon {...p}>
    <circle cx="64" cy="64" r="34" strokeWidth="6" />
    <path d="M64 8 V48 M64 80 V120 M8 64 H48 M80 64 H120" strokeWidth="6" />
  </Icon>
)

export const IconEye = (p: Size) => (
  <Icon {...p}>
    <path d="M12 64 Q64 15 116 64 Q64 113 12 64Z" strokeWidth="7" />
    <circle cx="64" cy="64" r="16" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconFolder = (p: Size) => (
  <Icon {...p}>
    <path d="M12 32 H48 L59 44 H116 V105 H12 Z" strokeWidth="7" strokeLinejoin="miter" />
  </Icon>
)

export const IconDocument = (p: Size) => (
  <Icon {...p}>
    <path d="M28 12 H75 L100 37 V116 H28 Z" strokeWidth="7" />
    <path d="M75 12 V38 H100 M41 58 H86 M41 73 H86 M41 88 H76" strokeWidth="6" />
  </Icon>
)

/** The logo: a face inside the kit's target frame, its eyes covered by the mask. */
export function Emblem({ size = 28 }: Size) {
  return (
    <svg className="emblem" viewBox="0 0 128 128" width={size} height={size} aria-hidden="true">
      <path d="M18 46 V18 H46 M82 18 H110 V46 M110 82 V110 H82 M46 110 H18 V82" fill="none" stroke="#57E298" strokeWidth="9" />
      <ellipse cx="64" cy="62" rx="27" ry="33" fill="#E1EFF8" />
      <rect x="28" y="48" width="72" height="18" fill="#FF5321" />
    </svg>
  )
}
