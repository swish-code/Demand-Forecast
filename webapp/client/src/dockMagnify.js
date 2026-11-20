import { useEffect } from 'react'

/**
 * Dock magnification for the navigation rail - 20 Nov 2026.
 *
 * The icon under the pointer grows, and its neighbours grow less the further
 * they are from it, on a cosine falloff. The effect is the reason the rail
 * can be icons-only and still feel aimable: the thing you are about to click
 * tells you so before you click it.
 *
 * IT NEVER RE-RENDERS REACT. The pointer moves hundreds of times a second and
 * state would mean a render tree per move. Instead each item gets a `--mag`
 * custom property written straight onto its style, once per animation frame,
 * and the CSS does the rest. React is not told anything.
 *
 * Mouse and desktop only. A touch screen has no hovering pointer to magnify
 * toward, and somebody who has asked for reduced motion should not have the
 * rail breathing at them - both are checked on every move rather than once,
 * because a laptop can gain a mouse and a system preference can change
 * mid-session.
 */

/** Distance from an item's centre at which it stops growing. */
const RANGE = 120
/** Extra scale at the pointer: a 19px icon reaches about 31px. */
const GROW = 0.62

/**
 * @param {Element|null} nav  the container to watch
 * @param {object} [opts]
 * @param {string} [opts.selector]  which children magnify
 * @param {number} [opts.range]     falloff distance in px
 * @param {number} [opts.grow]      extra scale directly under the pointer
 */
export function useDockMagnify(nav, opts = {}) {
  const { selector = '.rail-item', range = RANGE, grow = GROW } = opts

  useEffect(() => {
    if (!nav || typeof window === 'undefined' || !window.matchMedia) return undefined

    const ok = () =>
      window.matchMedia('(min-width: 821px) and (hover: hover) and (pointer: fine)').matches &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let frame = 0
    let y = null
    const items = () => nav.querySelectorAll(selector)

    const paint = () => {
      frame = 0
      for (const el of items()) {
        let mag = 1
        if (y != null) {
          const r = el.getBoundingClientRect()
          const d = Math.abs(y - (r.top + r.height / 2))
          // Cosine falloff: full growth under the pointer, nothing at RANGE,
          // and a smooth curve between - a linear ramp reads as a corner.
          if (d < range) mag = 1 + grow * ((Math.cos((Math.PI * d) / range) + 1) / 2)
        }
        el.style.setProperty('--mag', mag.toFixed(3))
      }
    }

    const move = (e) => {
      if (!ok()) return
      y = e.clientY
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const leave = () => {
      y = null
      if (!frame) frame = requestAnimationFrame(paint)
    }

    nav.addEventListener('pointermove', move)
    nav.addEventListener('pointerleave', leave)
    return () => {
      nav.removeEventListener('pointermove', move)
      nav.removeEventListener('pointerleave', leave)
      if (frame) cancelAnimationFrame(frame)
      // Leave no inline styles behind: a rail that unmounts mid-magnify would
      // otherwise come back with one icon stuck large.
      for (const el of items()) el.style.removeProperty('--mag')
    }
  }, [nav, selector, range, grow])
}
