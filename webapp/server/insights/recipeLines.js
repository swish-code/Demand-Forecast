/**
 * The recipe lines that count towards PM theoretical, for the PLUs that sold.
 *
 * Moved here from `branchVariance.js` on 25 Nov 2026, unchanged, so the BBT and
 * Yelo PM figure (`recipeLevel.js`, sales from Snowflake) and the branch tab
 * assemble PM from the same lines by the same rule.
 *
 * Level 1 lines and lines inside PREP sub-recipes, stopping at PAs
 * (`paScope.js`) - 22 Nov 2026, the same rule as the article view. Narrowed to
 * the PLUs in the sales, because the recipe table is company-wide (~300,000
 * rows) and a brand sells a few hundred of its PLUs. Every level is read and
 * placed here. PREP nodes themselves have no article number and are left out.
 *
 * Source: 'RECIPE TABLE' in the brand's Power BI model - the recipe file.
 */
import { executeQuery } from '../powerbi/client.js'
import { cached } from '../cache.js'
import { canonArticle } from '../powerbi/consumption.js'
import { placerFor, countsTowardPm } from './paScope.js'

const TTL = 3600
const NEAR_CAP = 95_000

const val = (r, name) => {
  const want = String(name).toLowerCase()
  for (const key of Object.keys(r)) {
    const bare = key.replace(/^.*\[/, '').replace(/\]$/, '').toLowerCase()
    if (bare === want) return r[key]
  }
  return undefined
}

const lit = (v) => `"${String(v).replace(/"/g, '""')}"`

/** A short, stable fingerprint of a list, for a cache key. */
function fingerprint(list) {
  let h = 5381
  const s = list.join(',')
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return `${list.length}-${h.toString(36)}`
}

/** Power BI drops rows past 100,000 without an error; an answer near it is not trusted. */
function assertComplete(rows, what) {
  if (rows.length >= NEAR_CAP) {
    throw new Error(`${what} returned ${rows.length} rows - at Power BI's row limit, so it may be cut short`)
  }
  return rows
}

/**
 * `[{ plu, article, item, bu, qty }]` for the counting lines of these PLUs.
 * Read in slices of 1,500 PLUs so neither the query text nor its answer grows
 * without bound.
 */
export function level1LinesFor(brand, plus) {
  const list = [...plus].map((p) => String(p).trim()).filter(Boolean).sort()
  return cached(
    // "branchpa", not "branchl1": lines cached under the old rule must not be served for the new one.
    `branchpa:${brand.code}:${fingerprint(list)}`,
    async () => {
      if (!list.length) return []
      const slices = []
      for (let i = 0; i < list.length; i += 1500) slices.push(list.slice(i, i + 1500))
      const [place, ...parts] = await Promise.all([
        placerFor(brand),
        ...slices.map((slice) =>
          executeQuery(
            `EVALUATE
SELECTCOLUMNS(
  FILTER('RECIPE TABLE',
    NOT ISBLANK('RECIPE TABLE'[Item No.])
      && 'RECIPE TABLE'[Product PLU] IN {${slice.map(lit).join(', ')}}),
  "plu", 'RECIPE TABLE'[Product PLU],
  "art", 'RECIPE TABLE'[Item No.],
  "item", 'RECIPE TABLE'[Item],
  "bu", 'RECIPE TABLE'[BU],
  "path", 'RECIPE TABLE'[Recipe Path],
  "qty", 'RECIPE TABLE'[QTY BU]
)`,
            brand.datasetId,
            { bulk: true, workspace: brand.workspaceId || undefined }
          ).then((rows) => assertComplete(rows, `recipe lines ${brand.code}`))
        ),
      ])
      const out = []
      for (const r of parts.flat()) {
        const article = canonArticle(val(r, 'art'))
        const qty = Number(val(r, 'qty')) || 0
        if (!article || !qty) continue
        if (!countsTowardPm(place(val(r, 'path')))) continue
        out.push({
          plu: String(val(r, 'plu') ?? '').trim(),
          article,
          item: String(val(r, 'item') ?? '').trim(),
          bu: String(val(r, 'bu') ?? '').trim(),
          qty,
        })
      }
      return out
    },
    { seconds: TTL }
  )
}
