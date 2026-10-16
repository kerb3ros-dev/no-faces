import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Same policy as public/_headers, as a <meta> so it also applies on hosts that cannot set headers.
// connect-src 'self' is the technical guarantee that photos cannot leave the device.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

/** Production only: the dev server injects inline scripts that the policy would block. */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  }
}

// Cross-origin isolation unlocks SharedArrayBuffer, hence multi-threaded detection.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig(({ mode }) => ({
  // Relative paths so the app works from any sub-folder (GitHub Pages, etc.).
  base: './',
  plugins: [
    // `npm run phone`: HTTPS with a self-signed certificate, so a phone on the same Wi-Fi gets a secure
    // context (needed for multi-threaded detection).
    mode === 'phone' && basicSsl(),
    react(),
    contentSecurityPolicy(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      manifest: {
        name: 'no-faces',
        short_name: 'no-faces',
        description: 'Masquez les visages de vos photos de façon irréversible, 100 % sur votre appareil.',
        lang: 'fr',
        start_url: './',
        scope: './',
        display: 'standalone',
        theme_color: '#0b1c1e',
        background_color: '#0b1c1e',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Everything, default model and WebAssembly included, is cached at install so the app works offline.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,wasm,onnx}'],
        // Optional models (deep face analysis 17 MB, text 5 MB) are not imposed on every install: they are
        // cached the first time they are used, and work offline from then on.
        globIgnores: ['**/models/scrfd_10g_bnkps.onnx', '**/models/ppocrv4_det.onnx'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/models\/(scrfd_10g_bnkps|ppocrv4_det)\.onnx$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'optional-models', cacheableResponse: { statuses: [200] } },
          },
        ],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
      },
    }),
  ],
  // ONNX Runtime without its WebAssembly inlined: the files are copied to public/ort/ by scripts/copy-ort.mjs.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  worker: { format: 'es' },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
}))
