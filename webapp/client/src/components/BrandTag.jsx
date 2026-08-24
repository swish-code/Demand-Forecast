import { brandColor, brandLogo, brandZoom } from '../brands.js'

/**
 * The chain code, tinted per brand, with its mark when there is room.
 *
 * The code is always spelled out. Colour and logo help a reader scan a long
 * table; neither is trusted to carry the identity on its own, because nine
 * brands is more than colour can separate and a 16px mark is more than shape
 * can.
 */
export function BrandTag({ code, logo = false }) {
  if (!code) return <span className="tag tag--none">—</span>
  const color = brandColor(code)
  const src = logo ? brandLogo(code) : null

  return (
    <span
      className="tag"
      style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
    >
      {src && (
        <span className="tag__chip" aria-hidden="true">
          <img src={src} alt="" style={{ transform: `scale(${1 + (brandZoom(code) - 1) * 0.35})` }} />
        </span>
      )}
      {code}
    </span>
  )
}

export { brandColor }
