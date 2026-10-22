import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Marks when the bundle has been evaluated and the app starts rendering,
// so the status bar can report first paint from navigation start and
// from app start (engine creation + first React render + first canvas paint).
window.__appStart = performance.now()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
