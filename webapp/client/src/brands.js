/**
 * What each brand looks like: its mark, its colour, its name.
 *
 * One place, because the same nine brands appear on the sign-in page, in the
 * brand picker, on every table row and in the model review. Three copies of
 * this list would drift, and a brand showing one colour in a table and another
 * in a chart is worse than no colour at all.
 *
 * Colours are pinned to codes, never assigned by position, so filtering a table
 * down to three brands never repaints them.
 *
 * A caveat worth stating plainly: nine brands is more than colour can carry.
 * Even an evenly spaced set leaves the closest pair below the separation a
 * reader needs, and no hand-picked set does better — measured, not guessed. So
 * colour here is an aid for scanning, never the identity. The code is always
 * spelled out beside it, and every step clears 3:1 against both surfaces so the
 * text stays legible either way.
 *
 * `zoom` crops the supplied artwork. Several files are a small mark on a large
 * white field — Yelo, Shakir and BBT are roughly half padding — so at their
 * natural size the chip shows mostly nothing. Others already fill their canvas
 * and any zoom at all cuts the mark. The factor is therefore per brand and set
 * by looking at each one, not by a rule.
 */
export const BRANDS = [
  { code: 'BBT', label: 'BBT', logo: '/brands/bbt.jpg', color: '#479c4d', zoom: 1.85 },
  { code: 'CHP', label: 'Chilli Pepper', logo: '/brands/chp.jpg', color: '#00a091', zoom: 1.0 },
  { code: 'PAT', label: 'Pattie Pattie', logo: '/brands/pat.png', color: '#0096c5', zoom: 1.12 },
  { code: 'SS', label: 'Shawarma Shakir', logo: '/brands/ss.png', color: '#5c82da', zoom: 1.25 },
  // Yellow by request. It cost the yellows that Mishmash and Tabel held, so
  // those moved to red and sienna; the palette measured better on colour-vision
  // separation after the swap than before it, not worse.
  { code: 'YP', label: 'Yelo Pizza', logo: '/brands/yp.png', color: '#b58900', zoom: 2.2 },
  { code: 'SLC', label: 'Slice', logo: '/brands/slc.jpg', color: '#c06099', zoom: 1.08 },
  { code: 'BUR', label: 'Just C', logo: '/brands/bur.jpg', color: '#9a6ec9', zoom: 1.0 },
  { code: 'MM', label: 'Mishmash', logo: '/brands/mm.png', color: '#d1483f', zoom: 1.05 },
  // A wide image in a square chip leaves bands above and below when it is
  // fitted by width, so this one is filled instead and cropped at the sides —
  // the ground is a solid colour and the mark sits in the middle, so nothing is
  // lost.
  { code: 'TBL', label: 'Tabel', logo: '/brands/tbl.png', color: '#a0522d', zoom: 1.0, fit: 'cover' },
  // Forevermore has no forecast model of its own, so it never appears in the
  // brand picker. It is here because it belongs on the sign-in page with the
  // rest of the group.
  { code: 'FM', label: 'Forevermore', logo: '/brands/fm.jpg', color: '#2f5d3a', zoom: 1.35 },
]

const BY_CODE = new Map(BRANDS.map((b) => [b.code, b]))

export const brandOf = (code) => BY_CODE.get(String(code ?? '').toUpperCase()) ?? null

const FALLBACK = BRANDS.map((b) => b.color)

/** A brand not in the list still gets a stable colour rather than a grey one. */
export function brandColor(code) {
  const key = String(code ?? '').toUpperCase()
  const known = BY_CODE.get(key)
  if (known) return known.color
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return FALLBACK[h % FALLBACK.length]
}

export const brandLogo = (code) => brandOf(code)?.logo ?? null
export const brandZoom = (code) => brandOf(code)?.zoom ?? 1
export const brandFit = (code) => brandOf(code)?.fit ?? 'contain'
