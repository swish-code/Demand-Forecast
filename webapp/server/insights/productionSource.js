import { config } from '../config.js'
import { cached } from '../cache.js'
import { executeQuery } from '../powerbi/client.js'

/**
 * Where a PA article is actually produced: Bakery, Central Kitchen / CPU, or
 * the Yelo Factory.
 *
 * ESTABLISHED BY AUDIT, 27-28 SEP 2026
 *
 * `'RECIPE TABLE'` says what an article IS, and nothing in it says where the
 * article is MADE. The movement facts do: `fact_outbound_line` records the cost
 * centre every line was issued from, and the production sites appear there by
 * name. So an article is classified by where it has actually come out of,
 * rather than by anybody's recollection.
 *
 * WHAT THE AUDIT SETTLED, AND WHAT IT DID NOT
 *
 * Only seven of the 172 raw cost-centre names are production sites, and there
 * are no spelling variants - every one of the 172 was checked.
 *
 * Bakery is read from the MAPPED field, which folds from exactly one raw name.
 * The Factory has to be read from the RAW field, because the mapping buries
 * "Yelo Factory" inside `YP` along with every Yelo shop and staff-meal centre.
 *
 * Central Kitchen and Central Production Unit are held TOGETHER, deliberately
 * and temporarily. The evidence says they are one cost centre renamed in
 * January-February 2026 - `Central Production Unit` stops booking as
 * `Centeral Kitchen` (the source's spelling) starts, with the monthly line
 * count unbroken at ~100-110k throughout, and the hand-maintained `FROM`
 * column has no CPU value at all. That has not been confirmed by the business,
 * so they stay combined rather than being declared the same site. Separating
 * them later is a change to `CATEGORY` below and nothing else.
 *
 * Three names map into `CKU/CPU` and are NOT production sources: `Staff Meal`
 * is a canteen, `FM- CPU` belongs to a separate company, and `ERMG CK` is a
 * dormant separate entity. Confirmed 28 Sep 2026: excluding all three changes
 * no article's category today, so this is a guard rather than a correction.
 *
 * WHY THE LATEST MOVEMENT, AND WHY ONLY FROM A SITE
 *
 * Warehouse and shop lines are ignored outright. They describe distribution,
 * not manufacture: `106400059 BBT Wet Batter` was issued from Swish Bakery on
 * 30 Aug and from a warehouse on 31 Aug, and reading the later line would file
 * a bakery product under the warehouse. Restricting to production sites moved
 * 47 articles to the right page.
 *
 * Among the site lines, the LATEST wins rather than the largest, so an article
 * whose production has moved follows it. Measured: no article is issued from
 * two sites on the same timestamp, so the tie-break below never fires.
 */

const SIX_MONTHS = 6

/** Raw cost-centre names that are production sites, and what to call them. */
const CATEGORY = new Map([
  ['CENTERAL KITCHEN', 'Central Kitchen / CPU'],
  ['CENTRAL PRODUCTION UNIT', 'Central Kitchen / CPU'],
  ['YELO FACTORY', 'YELO Factory'],
])

/** Mapped values that decide a category on their own. */
const BY_MAPPED = new Map([['SWISH BAKERY', 'Bakery']])

/*
 * Not production sites, despite mapping into CKU/CPU. Named rather than
 * inferred, so adding one is a decision somebody makes on purpose.
 */
const NOT_A_SITE = new Set(['STAFF MEAL', 'FM- CPU', 'ERMG CK'])

export const UNCLASSIFIED = 'Unclassified'
export const SOURCES = ['Central Kitchen / CPU', 'Bakery', 'YELO Factory', UNCLASSIFIED]

/** What your hand-entered `FROM` column means, used only where movements are silent. */
const FROM_MEANS = new Map([
  ['CK', 'Central Kitchen / CPU'],
  ['BK', 'Bakery'],
  ['FCT', 'YELO Factory'],
])

const norm = (s) => String(s ?? '').trim().toUpperCase()

function categoryOf(raw, mapped) {
  const r = norm(raw)
  if (CATEGORY.has(r)) return CATEGORY.get(r)
  if (NOT_A_SITE.has(r)) return null
  return BY_MAPPED.get(norm(mapped)) ?? null
}

/** The latest six WHOLE months, which is the window the warehouse constant uses. */
function window(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (SIX_MONTHS - 1), 1))
  const iso = (d) => d.toISOString().slice(0, 10)
  return { from: iso(start), to: iso(end) }
}

const daxDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `DATE(${y},${m},${d})`
}

/**
 * The hand-maintained `FROM` column, as a fallback only.
 *
 * It closes 3 of 110 gaps - it mostly covers articles that are already moving
 * and therefore already classified - but it costs one cached query and it is
 * right where it speaks, so it is worth having. It never overrides a movement.
 */
async function fromColumn() {
  const fm = (config.salesOnly ?? []).find((brand) => brand.code === 'FM')
  if (!fm?.datasetId) return new Map()
  return cached('production-source:from-column', async () => {
    const rows = await executeQuery(
      `EVALUATE SUMMARIZECOLUMNS('STD PKG'[Article No.], 'STD PKG'[FROM])`,
      fm.datasetId,
      { bulk: true, workspace: fm.workspaceId || undefined }
    ).catch((err) => {
      console.warn(`  [production-source] FROM column unavailable (${err.message})`)
      return null
    })
    const out = new Map()
    for (const r of rows ?? []) {
      const article = String(r['Article No.'] ?? r['[Article No.]'] ?? '').trim()
      const value = norm(r.FROM ?? r['[FROM]'])
      const cat = FROM_MEANS.get(value)
      if (article && cat) out.set(article, cat)
    }
    return out
  })
}

/**
 * article number -> production source, for every article that has one.
 *
 * Cached for the process: it is a description of where things are made, which
 * changes when the business changes, not per request.
 */
export async function productionSourceByArticle({ now = new Date() } = {}) {
  const w = config.warehouse
  if (!w?.datasetId) return new Map()
  const { from, to } = window(now)

  return cached(`production-source:${from}:${to}`, async () => {
    const statuses = (w.statuses ?? []).map((s) => `"${s}"`).join(', ')
    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
  fact_outbound_line[Cost Center/Store],
  fact_outbound_line[Mapped Cost Center/Store],
  FILTER(ALL(fact_outbound_line[Status Group]), fact_outbound_line[Status Group] IN {${statuses}}),
  FILTER(
    ALL(fact_outbound_line[Request Created Date]),
    fact_outbound_line[Request Created Date] >= ${daxDate(from)}
      && fact_outbound_line[Request Created Date] <= ${daxDate(to)}
  ),
  "lastTs", MAX(fact_outbound_line[Request Created DateTime]),
  "qty", SUM(fact_outbound_line[Action Base Qty])
)`,
      w.datasetId,
      { bulk: true, workspace: w.workspaceId }
    ).catch((err) => {
      console.warn(`  [production-source] movements unavailable (${err.message})`)
      return null
    })

    const best = new Map()
    for (const r of rows ?? []) {
      const article = String(r['Article No.'] ?? r['[Article No.]'] ?? '').trim()
      if (!article) continue
      // A line that moved nothing is not evidence of production.
      if (!(Number(r.qty ?? r['[qty]']) > 0)) continue
      const cat = categoryOf(
        r['Cost Center/Store'] ?? r['[Cost Center/Store]'],
        r['Mapped Cost Center/Store'] ?? r['[Mapped Cost Center/Store]']
      )
      if (!cat) continue
      const ts = String(r.lastTs ?? r['[lastTs]'] ?? '')
      const qty = Number(r.qty ?? r['[qty]']) || 0
      const held = best.get(article)
      // Latest wins; on the same timestamp the larger quantity, then the name,
      // so two runs over the same data cannot disagree.
      if (!held || ts > held.ts || (ts === held.ts && (qty > held.qty || (qty === held.qty && cat < held.cat)))) {
        best.set(article, { cat, ts, qty })
      }
    }

    const out = new Map()
    for (const [article, held] of best) out.set(article, held.cat)

    // Only where the movements said nothing at all.
    for (const [article, cat] of await fromColumn()) {
      if (!out.has(article)) out.set(article, cat)
    }

    const counts = new Map()
    for (const cat of out.values()) counts.set(cat, (counts.get(cat) ?? 0) + 1)
    console.log(
      `  [production-source] ${from}..${to}: ` +
        [...counts].map(([k, v]) => `${k} ${v}`).join(', ')
    )
    return out
  })
}
