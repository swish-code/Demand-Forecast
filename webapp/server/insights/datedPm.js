/**
 * PM theoretical, each day costed with the recipe MC posted that day with -
 * 26 Nov 2026, on request: "each day's theoretical consumption uses the exact
 * recipe version MC used when posting that day's sales. Account for MC's
 * posting time and any reposting behaviour."
 *
 *   PM(day) = units sold that day, per PLU and outlet (Power BI, or Snowflake
 *             for BBT, Yelo, MM and TBL - the page's own sales, catering out)
 *           x the MC product for that PLU at that outlet, as it stood at the
 *             day's posting time
 *           x that product's recipe lines (REC_EXPLOSION, REX_MIS = 1: the
 *             stop-at-PA lines MC posts) as they stood at the same moment
 *
 * The posting time is 06:00 Kuwait the next morning, or the time the posting
 * watch saw MC re-post the day (`mc/recipeVersions.js`).
 *
 * ONLY PROVEN DAYS. A day is costed here only when the capture's probe log
 * proves the recipe state at its posting time (`stateKnownAt`) and the posting
 * has happened. Every other day keeps the page's current method - the Recipe
 * File over the same sales - so nothing is guessed. Capture began 26 Nov 2026,
 * so 26 Nov (posted 27 Nov 06:00) is the first day this can cost.
 *
 * Water stays in: MC's explosion carries its water lines and they are counted,
 * as on the rest of the page. The page reports water separately.
 */
import { executeQuery } from '../powerbi/client.js'
import { config } from '../config.js'
import { cached } from '../cache.js'
import { mcSelect } from '../mc/oracle.js'
import { CATERING_BRANCHES, canonArticle } from '../powerbi/consumption.js'
import { kstMap, kstKey } from './theoreticalDrivers.js'
import { salesFromSnowflake, snowflakeSalesDaily, canonPlu } from '../snowflake/foodicsSales.js'
import { versionStore, inForce, stateKnownAt, uncertainIn, unloggedWindows, postingTime, kuwaitNow } from '../mc/recipeVersions.js'

const TTL = 3600
const CATERING = new Set(CATERING_BRANCHES.map((b) => String(b).toUpperCase()))

const val = (r, name) => {
  const want = String(name).toLowerCase()
  for (const key of Object.keys(r)) {
    const bare = key.replace(/^.*\[/, '').replace(/\]$/, '').toLowerCase()
    if (bare === want) return r[key]
  }
  return undefined
}
const daxDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
export function daysOf(from, to) {
  const out = []
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d)
  return out
}

/* ------------------------------------------------------------- pure --- */

/**
 * Which days of [from, to] can be costed from captured versions: posted by
 * `now`, and with the recipe state at their posting time proven by the probes.
 */
export function provenDays({ brand, from, to, probes, reposted, now, uncertainBetween, uncertainAt = () => false }) {
  const out = []
  for (const day of daysOf(from, to)) {
    const t = postingTime(reposted, brand, day)
    if (t <= now && stateKnownAt(probes, t, { uncertainBetween }) && !uncertainAt(t)) out.push({ day, t })
  }
  return out
}

/**
 * The versions that concern one brand: recipes used by, and products defined
 * at, its outlets. An unlogged change elsewhere does not make its days unsure.
 */
export function brandScope(store, brandKsts) {
  const pros = new Set()
  const rezs = new Set()
  for (const p of store.products) {
    if (!brandKsts.has(String(p.kst_id))) continue
    pros.add(p.key)
    if (p.rez_id) rezs.add(String(p.rez_id))
  }
  return { pros, rezs, has: (kind, key) => (kind === 'product' ? pros.has(key) : rezs.has(String(key))) }
}

/**
 * Cost sale lines with the versions in force at each day's posting time.
 *
 *   sales      [{ day, plu, branch, q }]   catering already dropped
 *   days       Map(day -> posting time)
 *   versions   { recipes, products }       rows from the version store
 *   kstsOf     branch -> [kst_id]          the outlet's MC cost centres
 *
 * Returns Map(article -> qty) with `.stats` { units, costed, noProduct, days }.
 * A PLU with no MC product at the outlet falls back to the brand's other
 * outlets, as MC's till does for a product defined elsewhere.
 */
export function costDays({ sales, days, versions, kstsOf, brandKsts }) {
  const out = new Map()
  const stats = { units: 0, costed: 0, noProduct: 0, days: days.size }
  const atTime = new Map() // posting time -> { byPluKst, byPlu, recipes }
  const indexAt = (t) => {
    let ix = atTime.get(t)
    if (ix) return ix
    const products = inForce(versions.products, t)
    const recipes = inForce(versions.recipes, t)
    const byPluKst = new Map()
    const byPlu = new Map()
    const ids = [...products.keys()].sort((a, b) => Number(a) - Number(b))
    for (const id of ids) {
      const p = products.get(id)
      const plu = canonPlu(p.plu)
      if (!plu) continue
      const k = `${plu}|${p.kst_id}`
      if (!byPluKst.has(k)) byPluKst.set(k, p)
      if (brandKsts.has(String(p.kst_id)) && !byPlu.has(plu)) byPlu.set(plu, p)
    }
    ix = { byPluKst, byPlu, recipes }
    atTime.set(t, ix)
    return ix
  }
  for (const s of sales) {
    const t = days.get(s.day)
    if (!t) continue
    stats.units += s.q
    const ix = indexAt(t)
    const plu = canonPlu(s.plu)
    let p = null
    for (const k of kstsOf(s.branch)) if ((p = ix.byPluKst.get(`${plu}|${k}`))) break
    if (!p) p = ix.byPlu.get(plu) ?? null
    if (!p) {
      stats.noProduct += s.q
      continue
    }
    // A product on a recipe MC explodes to nothing (a "Dummy" choice line, or one whose lines carry
    // 0 base units) is costed at nothing - that is what MC posts for it - not reported as unmapped.
    const lines = p.rez_id
      ? ix.recipes.get(String(p.rez_id))?.lines ?? new Map()
      : p.art
        ? new Map([[canonArticle(p.art), Number(p.qty) || 1]])
        : new Map()
    stats.costed += s.q
    for (const [a, x] of lines) out.set(a, (out.get(a) ?? 0) + x * s.q)
  }
  for (const [a, v] of out) if (!v) out.delete(a)
  out.stats = stats
  return out
}

/* ------------------------------------------------------------- reads --- */

/** branch -> [kst_id] per brand, from the KST MAP and MC's cost-centre names. */
function outletKsts() {
  return cached(
    'datedpm:ksts',
    async () => {
      const [map, rows] = await Promise.all([kstMap(), mcSelect('SELECT kst_id, kst_name FROM kostst')])
      const out = new Map() // brand -> Map(branch -> [kst])
      for (const r of rows) {
        const p = map.get(kstKey(r.KST_NAME))
        if (!p) continue
        const b = out.get(p.brand) ?? new Map()
        const l = b.get(p.branch) ?? []
        l.push(String(r.KST_ID))
        b.set(p.branch, l)
        out.set(p.brand, b)
      }
      return out
    },
    { seconds: TTL }
  )
}

const chainFilter = (brand) => (brand?.chain ? `\n  TREATAS({"${brand.chain}"}, Forecast_Product_Table[CHAINID]),` : '')

/** Power BI sales a day at a time, a week per query so no answer nears the row cap. */
function powerBiSalesDaily(brand, from, to) {
  return cached(
    `pbisalesday:${brand.code}:${from}:${to}`,
    async () => {
      const out = []
      for (let f = from; f <= to; f = addDays(f, 7)) {
        const t = addDays(f, 6) < to ? addDays(f, 6) : to
        const rows = await executeQuery(
          `EVALUATE
SUMMARIZECOLUMNS(
  Forecast_Product_Table[Clean_ItemID],
  Forecast_Product_Table[LocationID],
  DateTable[Date],${chainFilter(brand)}
  TREATAS(CALENDAR(${daxDate(f)}, ${daxDate(t)}), DateTable[Date]),
  "q", SUM(Forecast_Product_Table[Actual_Qty])
)`,
          brand.datasetId,
          { bulk: true, workspace: brand.workspaceId || undefined }
        )
        if (rows.length >= 95_000) throw new Error(`daily sales ${brand.code} ${f}: ${rows.length} rows, at the row cap`)
        for (const r of rows) {
          const q = Number(val(r, 'q')) || 0
          const plu = String(val(r, 'Clean_ItemID') ?? '').trim()
          if (!q || !plu) continue
          out.push({ day: String(val(r, 'Date') ?? '').slice(0, 10), plu, branch: String(val(r, 'LocationID') ?? '').trim().toUpperCase(), q })
        }
      }
      return out
    },
    { seconds: TTL }
  )
}

function salesDaily(brand, from, to) {
  return salesFromSnowflake(brand.code) ? snowflakeSalesDaily(brand.code, from, to) : powerBiSalesDaily(brand, from, to)
}

/**
 * PM for the proven days of one brand's window, or null when nothing is
 * captured yet. `{ map, days }`: `map` is article -> qty over the proven days
 * (with `.stats`), `days` the list of { day, t } it covers.
 */
export async function datedPm(brand, from, to) {
  const store = await versionStore()
  if (!store || !store.recipes.length) return null
  const ksts = await outletKsts()
  const outlets = ksts.get(brand.code) ?? new Map()
  const brandKsts = new Set([...outlets.values()].flat())
  // Only this brand's recipes and products decide whether its posting moments are known.
  const scope = brandScope(store, brandKsts)
  const mine = {
    recipes: store.recipes.filter((r) => scope.has('recipe', r.key)),
    products: store.products.filter((p) => scope.has('product', p.key)),
  }
  const windows = unloggedWindows({ ...mine, probes: store.probes })
  const days = provenDays({
    brand: brand.code,
    from,
    to,
    probes: store.probes,
    reposted: store.reposted,
    now: kuwaitNow(),
    uncertainBetween: (a, b) => uncertainIn(mine, a, b),
    uncertainAt: (t) => windows.some((w) => w.from < t && t <= w.to),
  })
  if (!days.length) return { map: null, days }
  const first = days[0].day
  const last = days[days.length - 1].day
  const all = await salesDaily(brand, first, last)
  const dayMap = new Map(days.map((d) => [d.day, d.t]))
  const sales = all.filter((s) => dayMap.has(s.day) && !CATERING.has(String(s.branch).toUpperCase()))
  const map = costDays({ sales, days: dayMap, versions: store, kstsOf: (b) => outlets.get(String(b).toUpperCase()) ?? [], brandKsts })
  console.log(
    `  [dated-pm] ${brand.code} ${first}..${last}: ${days.length} days from captured MC recipes, ` +
      `${Math.round(map.stats.costed)} of ${Math.round(map.stats.units)} units costed`
  )
  return { map, days }
}

/* ------------------------------------------------- the posting watch --- */

/**
 * MC's sold total per brand per posted day, this month and last, for the
 * posting watch. Catering left out; today (not yet posted) left out.
 * Reads DAILYTOTALS the way the open-month read does: by the outlet-article
 * pairs MC counts, four outlet groups at once.
 */
export async function readDailyTotals() {
  const now = kuwaitNow().slice(0, 10)
  const firstPrev = `${addDays(`${now.slice(0, 7)}-01`, -1).slice(0, 7)}-01`
  const [ksts, ...parts] = await Promise.all([
    outletKsts(),
    ...[0, 1, 2, 3].map((part) =>
      mcSelect(
        `WITH pairs AS (
           SELECT DISTINCT i.kst_id, w.art_id
             FROM invposwes w JOIN inventur i ON i.inv_id = w.inv_id
            WHERE i.inv_typ = 1 AND i.inv_status = 8 AND i.inv_datum >= ADD_MONTHS(TO_DATE(:f, 'YYYY-MM-DD'), -3)
              AND NVL(w.inp_sales, 0) <> 0 AND MOD(i.kst_id, 4) = :part)
         SELECT /*+ LEADING(p) USE_NL(d) INDEX(d) */ p.kst_id, TO_CHAR(d.day_date, 'YYYY-MM-DD') AS d, -SUM(d.day_qtysold) AS q
           FROM pairs p JOIN dailytotals d ON d.kst_id = p.kst_id AND d.art_id = p.art_id
          WHERE d.day_date >= TO_DATE(:f, 'YYYY-MM-DD') AND d.day_date < TO_DATE(:t, 'YYYY-MM-DD')
          GROUP BY p.kst_id, TO_CHAR(d.day_date, 'YYYY-MM-DD')`,
        { f: firstPrev, t: now, part }
      )
    ),
  ])
  const brandOf = new Map()
  for (const [brand, outlets] of ksts) for (const [branch, list] of outlets) for (const k of list) brandOf.set(k, { brand, branch })
  const totals = new Map()
  for (const r of parts.flat()) {
    const p = brandOf.get(String(r.KST_ID))
    if (!p || CATERING.has(p.branch)) continue
    const k = `${p.brand}|${r.D}`
    totals.set(k, (totals.get(k) ?? 0) + (Number(r.Q) || 0))
  }
  return totals
}

export const brandFor = (code) => config.brands.find((b) => b.code.toUpperCase() === String(code).toUpperCase()) ?? null
