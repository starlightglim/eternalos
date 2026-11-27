import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/global.css'
import './styles/wallpapers.css'
import { registerBuiltinVariants } from './variants/registerBuiltins'
import { registerServiceWorker } from './utils/registerServiceWorker'
import { loadGoogleFonts } from './utils/googleFonts'
import App from './App.tsx'

// Non-blocking Google Fonts stylesheet (was a render-blocking CSS @import).
loadGoogleFonts()

// Register all built-in variant components before rendering
registerBuiltinVariants()

// Register the service worker for offline shell + R2 asset caching. No-op on
// unsupported browsers and when loaded with ?no-sw=1.
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
