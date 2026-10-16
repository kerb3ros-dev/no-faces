/** The share sheet is the way to put a file in the Photos app on iOS / Android. */
export function canShareFiles(files: File[]): boolean {
  return typeof navigator.canShare === 'function' && navigator.canShare({ files })
}

/** Must be called directly from a click handler: browsers require a fresh user gesture to share. */
export async function shareFiles(files: File[]): Promise<void> {
  try {
    await navigator.share({ files })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    throw error
  }
}

export function downloadFiles(files: File[]): void {
  files.forEach((file, i) => {
    // Browsers drop rapid successive downloads; space them out.
    setTimeout(() => {
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }, i * 300)
  })
}
