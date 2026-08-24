import { useEffect, useState } from 'react'

const TOKENS = {
  actual: '--series-1',
  forecast: '--series-2',
  grid: '--grid',
  line: '--line',
  muted: '--text-muted',
  surface: '--surface',
  red: '--red',
  amber: '--amber',
  neutral: '--neutral',
  plain: '--plain',
  bar1: '--bar-1',
  bar2: '--bar-2',
}

function read() {
  const styles = getComputedStyle(document.documentElement)
  const out = {}
  for (const [name, token] of Object.entries(TOKENS)) {
    out[name] = styles.getPropertyValue(token).trim()
  }
  return out
}

/**
 * Recharts sets colours as SVG presentation attributes, which do not resolve
 * var(). Read the tokens from CSS instead and re-read whenever the theme
 * changes, so charts stay driven by the same source of truth as everything else.
 */
export function useChartTheme() {
  const [colors, setColors] = useState(read)

  useEffect(() => {
    const refresh = () => setColors(read())

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', refresh)

    const observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      mq.removeEventListener('change', refresh)
      observer.disconnect()
    }
  }, [])

  return colors
}
