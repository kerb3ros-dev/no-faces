// Downloads the optional models next to the app (they are too large for the repository) and checks
// their SHA-256, so a build can only ever ship these exact files. Already present and valid: nothing to do.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const MODELS = [
  {
    // SCRFD 10G (InsightFace), ONNX export by RuteNL: "analyse approfondie" of photos.
    file: 'scrfd_10g_bnkps.onnx',
    url: 'https://huggingface.co/RuteNL/SCRFD-face-detection-ONNX/resolve/main/10g_bnkps.onnx',
    sha256: '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
  },
  {
    // PP-OCRv4 text detection (PaddleOCR, Apache 2.0), ONNX export by RapidOCR: text and licence plates.
    file: 'ppocrv4_det.onnx',
    url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
    sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
  },
]

const dir = new URL('../public/models/', import.meta.url)
mkdirSync(dir, { recursive: true })
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

for (const { file, url, sha256: expected } of MODELS) {
  const path = new URL(file, dir)
  if (existsSync(path) && sha256(readFileSync(path)) === expected) continue
  console.log(`Téléchargement de ${file}…`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${file} : téléchargement impossible (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== expected) throw new Error(`${file} : empreinte SHA-256 inattendue (${actual}), fichier refusé`)
  writeFileSync(path, bytes)
}
