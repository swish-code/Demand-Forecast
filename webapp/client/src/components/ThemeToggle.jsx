import { useCallback, useEffect, useState } from 'react'
import { IconMoon, IconSun } from './Icons.jsx'

/**
 * Light / dark, chosen by the reader - 20 Nov 2026.
 *
 * The app has always had both themes and no way to ask for one: it followed
 * the operating system and that was that. Which is wrong often enough to
 * matter - a machine set to dark at six in the evening, a screen in a bright
 * kitchen, a projector.
 *
 * THREE STATES, NOT TWO, and the third is the important one:
 *
 *   nothing stored   follow the system, and KEEP following it. No
 *                    `data-theme` attribute is set at all, so the
 *                    `prefers-color-scheme` rules in reference.css decide,
 *                    and a reader whose machine switches at sunset switches
 *                    with it.
 *   'light'/'dark'   an explicit choice. `data-theme` is stamped on <html>,
 *                    which every stylesheet guards against, so the choice
 *                    wins over the system in both directions.
 *
 * Writing an explicit value on first load instead would have silently frozen
 * everyone to whatever their machine happened to be at that moment.
 */

const KEY = 'theme'

/** What the OS is asking for right now. */
const systemDark = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches

/** The stored choice, or null for "follow the system". */
function stored() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    // Private browsing, or storage blocked. Following the system is a fine
    // answer and is what the app did before this control existed.
    return null
  }
}

/**
 * Put the choice on <html>, or take it off again.
 *
 * Removing the attribute is what hands control back to the media query, so
 * "follow the system" is the ABSENCE of a value rather than a third value the
 * stylesheets would have to know about.
 */
function apply(choice) {
  const root = document.documentElement
  if (choice) root.dataset.theme = choice
  else delete root.dataset.theme
}

export function ThemeToggle() {
  const [choice, setChoice] = useState(stored)
  const [isDark, setIsDark] = useState(() => stored() === 'dark' || (!stored() && systemDark()))

  // Apply on mount and whenever the choice changes.
  useEffect(() => {
    apply(choice)
    setIsDark(choice ? choice === 'dark' : systemDark())
  }, [choice])

  /*
   * Follow the system while no explicit choice is stored.
   *
   * Bound only in that state: once someone has chosen, the OS flipping at
   * sunset must not quietly undo their choice.
   */
  useEffect(() => {
    if (choice) return undefined
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return undefined
    const onChange = () => setIsDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [choice])

  const toggle = useCallback(() => {
    const next = isDark ? 'light' : 'dark'
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // Not storable, but the page can still change for this session.
    }
    setChoice(next)
  }, [isDark])

  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode'

  return (
    <button
      type="button"
      className="themetoggle"
      onClick={toggle}
      title={label}
      aria-label={label}
      aria-pressed={isDark}
    >
      {/* Keyed so React mounts a NEW icon on each flip rather than reusing the
          old one, which is what lets the pop-in animation play at all. */}
      <span key={isDark ? 'moon' : 'sun'} className="themetoggle__icon">
        {isDark ? <IconMoon size={16} /> : <IconSun size={16} />}
      </span>
    </button>
  )
}
