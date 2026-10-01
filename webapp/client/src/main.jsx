import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './Shell.jsx'
import './theme.css'

/**
 * Takes the boot screen down once the app is actually on screen.
 *
 * The screen lives in index.html, outside the React container, so that the
 * browser can paint it before this bundle has even downloaded. That also means
 * React will never remove it — which is the bug this fixes: it was originally
 * placed INSIDE #root on the assumption that `createRoot` clears its
 * container, and `createRoot` does not. The app mounted correctly every time
 * and was simply covered by a `position: fixed` screen that had no way of
 * knowing it was no longer needed.
 *
 * An effect rather than a timer: it runs after React has committed, so the
 * screen goes when there is genuinely something behind it, not after a guessed
 * number of milliseconds. Fading rather than cutting, because the app lands in
 * its loading state and a hard swap between two loading states reads as a
 * flicker.
 *
 * Nothing about what the app loads, or when, changes here.
 */
function BootScreen({ children }) {
  useEffect(() => {
    const boot = document.getElementById('boot')
    if (!boot) return undefined
    boot.classList.add('boot--done')
    // Matches the fade in index.html. Removed rather than left hidden so no
    // stray full-screen element can ever intercept a click.
    const t = setTimeout(() => boot.remove(), 260)
    return () => clearTimeout(t)
  }, [])
  return children
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BootScreen>
      <Shell />
    </BootScreen>
  </StrictMode>
)
