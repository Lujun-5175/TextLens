import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles.css'
import '../themes.css'
import './ball.css'
import { installTauriBridge } from '../lib/tauriBridge'
import { WindowErrorBoundary } from '../lib/ErrorBoundary'
import { applyTheme, storedTheme } from '../lib/theme'
import { BallApp } from './BallApp'
import { BallMenuApp } from '../ball-menu/BallMenuApp'
import '../ball-menu/ball-menu.css'

installTauriBridge()
applyTheme(storedTheme())

const root = document.getElementById('root')

if (!root) {
  throw new Error('Ball root element is missing')
}

// The same page serves the orb and its right-click panel: the orb window is
// proven to load, and a second HTML entry was not (its WebView stayed blank).
// `?menu=1` only swaps which component renders.
const menuMode = new URLSearchParams(window.location.search).get('menu') === '1'
if (menuMode) document.body.className = 'ball-menu-body'

createRoot(root).render(
  <StrictMode>
    <WindowErrorBoundary>
      {menuMode ? <BallMenuApp /> : <BallApp />}
    </WindowErrorBoundary>
  </StrictMode>
)
