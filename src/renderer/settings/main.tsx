import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles.css'
import '../themes.css'
import './settings.css'
import { installTauriBridge } from '../lib/tauriBridge'
import { WindowErrorBoundary } from '../lib/ErrorBoundary'
import { applyTheme, storedTheme } from '../lib/theme'
import { SettingsApp } from './SettingsApp'

installTauriBridge()
applyTheme(storedTheme())

// WebView2 zooms the whole page on Ctrl+wheel. In a settings window that is
// never wanted, and the result (everything oversized, right-hand controls cut
// off by the window edge) reads as a layout bug rather than a zoom level.
window.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey) event.preventDefault()
  },
  { passive: false }
)

const root = document.getElementById('root')

if (!root) {
  throw new Error('Settings root element is missing')
}

createRoot(root).render(
  <StrictMode>
    <WindowErrorBoundary>
      <SettingsApp />
    </WindowErrorBoundary>
  </StrictMode>
)
