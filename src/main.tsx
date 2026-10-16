import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fonts of the brand guide, served with the app (latin subset): no request to another site.
import '@fontsource/vt323/latin-400.css'
import '@fontsource/press-start-2p/latin-400.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-700.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
