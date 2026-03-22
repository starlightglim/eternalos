import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/global.css'
import './styles/wallpapers.css'
import { registerBuiltinVariants } from './variants/registerBuiltins'
import App from './App.tsx'

// Register all built-in variant components before rendering
registerBuiltinVariants()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
