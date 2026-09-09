/**
 * Which articles a brand's menu still needs, from tomorrow onwards.
 *
 * The six-month rate answers "how much of this does the warehouse ship per unit
 * sold?" and answers it just as confidently for a product that has been taken
 * off the menu. History alone cannot tell those apart — that is what forward
 * demand is for.
 *
 * A product with no forecast from tomorrow is not being planned for, so the
 * articles it uses have no requirement coming, whatever they shipped in March.
 *
 * The join is the one the rest of the app uses: `Forecast_Product_Table` is the
 * brand-scoped side and its Clean_ItemID is the recipe's Product PLU. Read the
 * recipe master without it and every brand appears to make every product — the
 * fault that had one Shawarma Station combo showing up under four brands.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { cached } from '../cache.js'

/** How far ahead counts as "still planned". */
const HORIZON_DAYS = 400

const iso = (d) => new Date(d).toISOString().slice(0, 10)
const dax = (d) => {
  const [y, m, day] = d.split('-')
  return `DATE(${Number(y)},${Number(m)},${Number(day)})`
}

/**
 * Every article reached by a product this brand is still forecasting.
 *
 * Returns a Set of article numbers, or null when the question cannot be
 * answered — a null means "no opinion" and callers leave the forecast alone
 * rather than deleting it, because a failed query must not look like a menu
 * that has emptied.
 */
/**
 * Every article any brand's menu still wants.
 *
 * The per-brand answer above decides whether *this* brand's menu drives an
 * article. This one answers a different question: is the article menu-driven at
 * all?
 *
 * It exists because being named in a recipe does not make something menu-driven.
 * Gloves, napkins, paper bags and face masks are all in the recipe master —
 * somebody added them to a recipe — and no menu forecast will ever reach them,
 * because nothing on a menu is measured in gloves. Treating them as menu-driven
 * meant demanding a signal that cannot arrive, and blanking the forecast for
 * 1.75 million units of consumables that ship every week.
 *
 * Null when nothing could be determined, which callers read as "no opinion"
 * rather than "no menu wants anything".
 */
let anyCache = null
let anyCacheKey = ''

export async function articlesWithAnyFutureDemand({ today = new Date() } = {}) {
  const key = iso(today)
  if (anyCache && anyCacheKey === key) return anyCache

  const work = (async () => {
    const sets = await Promise.all(
      config.brands.map((b) => articlesWithFutureDemand(b.code, { today }))
    )
    const known = sets.filter(Boolean)
    // Every brand failed or answered nothing: no opinion, not an empty menu.
    if (!known.length) return null
    const out = new Set()
    for (const s of known) for (const a of s) out.add(a)
    return out
  })()

  anyCacheKey = key
  anyCache = work
  work.catch(() => {
    if (anyCacheKey === key) anyCache = null
  })
  return work
}

export async function articlesWithFutureDemand(brandCode, { today = new Date() } = {}) {
  const brand = config.brands.find((b) => b.code === brandCode)
  if (!brand) return null

  const from = iso(new Date(today).getTime() + 86_400_000)
  const to = iso(new Date(today).getTime() + HORIZON_DAYS * 86_400_000)

  return cached(`${brand.datasetId}:future-demand:${brand.chainId ?? brand.code}:${from}`, async () => {
    /*
     * Products with a forecast ahead, then the articles their recipes name.
     *
     * `> 0` rather than "has a row": the forecast table carries a row per
     * product per day whether or not anything is expected, so a product taken
     * off the menu still has rows — with nothing in them. Filtering on the
     * measure is what separates "planned for" from "present in the calendar".
     */
    const chain = brand.chainId ?? brand.code
    const query = `EVALUATE
VAR Future =
  FILTER(
    CALCULATETABLE(
      VALUES(Forecast_Product_Table[Clean_ItemID]),
      TREATAS({"${chain}"}, Forecast_Product_Table[CHAINID]),
      DATESBETWEEN(DateTable[Date], ${dax(from)}, ${dax(to)})
    ),
    CALCULATE([Total_Forecast_Qty], DATESBETWEEN(DateTable[Date], ${dax(from)}, ${dax(to)})) > 0
  )
RETURN
SUMMARIZECOLUMNS(
  'RECIPE TABLE'[Item No.],
  FILTER(ALL('RECIPE TABLE'[Product PLU]), 'RECIPE TABLE'[Product PLU] IN Future)
)`

    const rows = await executeQuery(query, brand.datasetId, { bulk: true })
    const out = new Set()
    for (const r of rows) {
      const a = String(r['Item No.'] ?? '').trim()
      if (a) out.add(a)
    }
    // An empty answer is almost certainly a query that matched nothing rather
    // than a brand that has stopped selling, and acting on it would blank the
    // whole page. Treated as no opinion.
    return out.size ? out : null
  }).catch((err) => {
    console.warn(`  [future-demand] ${brandCode}: ${err.message}`)
    return null
  })
}
