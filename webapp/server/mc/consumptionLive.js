/**
 * MC's theoretical AND actual consumption, read live from MC - 25 Nov 2026.
 *
 * Asked for: "In the MC Reconciliation tab as well, query the data directly
 * from MC instead of using Power BI, following the same approach we
 * implemented in PM Historical Reconciliation. This will also allow us to
 * retrieve the November data."
 *
 * It replaces `'Consumption Qty'` (the Power BI table loaded by the owner's
 * Power Query) for the Variance Analysis page only - `oracleConsumptionByArticle`
 * and `oracleConsumptionTrend` in powerbi/consumption.js stay for Stock Article
 * and Procurement. The return shapes are those two functions', so nothing
 * downstream changes.
 *
 * THE DEFINITION IS THE POWER QUERY'S, column for column, over monthly counts
 * (INV_TYP = 1) that are closed (INV_STATUS = 8), dated inside the month:
 *
 *   Opening      SUM(INVPOSWES.INP_ACT1)
 *   Transfer In  SUM(INVPOSWES.INP_TRSFIN)
 *   Transfer Out SUM(INVPOSWES.INP_TRSFOUT)
 *   Usage        SUM(INVPOSWES.INP_USAGE)
 *   Purchase     SUM(INVPOSWES.INP_PURCH)
 *   Closing      SUM(INVPOSART.INP_IST)
 *   Potential    SUM(INVPOSWES.INP_SALES)                 (booked negative)
 *   CONSUMPTION  Opening + Transfer In + Transfer Out + Usage + Purchase - Closing
 *
 * with the same inner joins to ARTIKEL -> WARENGRUPPE -> SPARTE -> SPARTEGR,
 * so an article the Power Query left out is left out here too.
 *
 * THE MONTH IN PROGRESS. Its theoretical exists, day by day, and comes from
 * `potentialCos.js` (DAILYTOTALS, month to date) exactly as on the PM tab. Its
 * ACTUAL consumption does not exist yet: it needs the closing count, and MC
 * has none until the month-end count closes - DAILYTOTALS carries movements
 * and book stock, never a count. So that month's consumption is NULL - not
 * zero - and the page says it is not counted yet. It fills in on its own once
 * MC closes the count.
 *
 * Brand and branch from the KST MAP by outlet name, as `potentialCos.js` does
 * (which matched Power BI's Potential COS exactly, brand by brand, month by
 * month); catering's THEORETICAL left out when asked, its consumption kept.
 */
import { cached } from '../cache.js'
import { mcSelect, mcOracleConfigured } from './oracle.js'
import { mcPotentialCos, mcPotentialCosSettled } from './potentialCos.js'
import { canonArticle, UNMAPPED_BRAND } from '../powerbi/consumption.js'
import { kstMap, kstKey } from '../insights/theoreticalDrivers.js'

const MONTHS_BACK = 9
const TTL = 3600

const firstOfMonthsAgo = (n, now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)).toISOString().slice(0, 10)

export const monthStart = (iso) => `${String(iso).slice(0, 7)}-01`

const JOINS = `JOIN inventur i     ON i.inv_id = X.inv_id
  JOIN kostst k       ON k.kst_id = i.kst_id
  JOIN artikel a      ON a.art_id = X.art_id
  JOIN warengruppe g  ON g.wgr_id = a.wgr_id
  JOIN sparte s       ON s.spa_id = g.spa_id
  JOIN spartegr o     ON o.sgr_id = s.sgr_id`

const CLOSED = `i.inv_typ = 1 AND i.inv_status = 8 AND i.inv_datum >= TO_DATE(:f, 'YYYY-MM-DD')`

/**
 * Fold MC's rows into one record per month, outlet name and article. Pure.
 *
 *   wes  [{ M, KST_NAME, ART_NUMMER, ART_NAME, OPENING, TRIN, TROUT, USG, PURCH, POT }]
 *   art  [{ M, KST_NAME, ART_NUMMER, ART_NAME, CLOSING }]
 *
 * -> Map('<month>|<KST_NAME>|<article>' -> { month, kst, article, name, consumption, potential })
 *    `potential` is negated once here (MC books it negative), as the Power BI read did.
 */
export function foldCounts(wes, art) {
  const out = new Map()
  const at = (r) => {
    const month = String(r.M ?? '').slice(0, 10)
    const article = canonArticle(r.ART_NUMMER)
    const kst = String(r.KST_NAME ?? '')
    const k = `${month}|${kst}|${article}`
    let h = out.get(k)
    if (!h) {
      h = { month, kst, article, name: String(r.ART_NAME ?? '').trim(), consumption: 0, potential: 0 }
      out.set(k, h)
    }
    if (!h.name && r.ART_NAME) h.name = String(r.ART_NAME).trim()
    return h
  }
  const n = (v) => Number(v) || 0
  for (const r of wes ?? []) {
    const h = at(r)
    h.consumption += n(r.OPENING) + n(r.TRIN) + n(r.TROUT) + n(r.USG) + n(r.PURCH)
    h.potential += -n(r.POT)
  }
  for (const r of art ?? []) at(r).consumption -= n(r.CLOSING)
  return out
}

/** Every closed month in the last nine, at month x outlet x article. Cached an hour. */
function closedCounts() {
  const f = firstOfMonthsAgo(MONTHS_BACK)
  return cached(
    `mc-consumption:${f}`,
    async () => {
      const started = Date.now()
      const [wes, art] = await Promise.all([
        mcSelect(
          `SELECT TO_CHAR(TRUNC(i.inv_datum, 'MM'), 'YYYY-MM-DD') AS m, k.kst_name, a.art_nummer,
                  MAX(a.art_name) AS art_name,
                  SUM(X.inp_act1) AS opening, SUM(X.inp_trsfin) AS trin, SUM(X.inp_trsfout) AS trout,
                  SUM(X.inp_usage) AS usg, SUM(X.inp_purch) AS purch, SUM(X.inp_sales) AS pot
             FROM invposwes X
             ${JOINS}
            WHERE ${CLOSED}
            GROUP BY TRUNC(i.inv_datum, 'MM'), k.kst_name, a.art_nummer`,
          { f }
        ),
        mcSelect(
          `SELECT TO_CHAR(TRUNC(i.inv_datum, 'MM'), 'YYYY-MM-DD') AS m, k.kst_name, a.art_nummer,
                  MAX(a.art_name) AS art_name, SUM(X.inp_ist) AS closing
             FROM invposart X
             ${JOINS}
            WHERE ${CLOSED}
            GROUP BY TRUNC(i.inv_datum, 'MM'), k.kst_name, a.art_nummer`,
          { f }
        ),
      ])
      const records = foldCounts(wes, art)
      /*
       * A month counts as closed when its counts carry a THEORETICAL - the rule
       * potentialCos.js uses. Stock figures alone are not enough: on 25 Nov
       * 2026 one count dated 1 Nov was closed with opening and closing stock
       * and no INP_SALES, and taking it as "November closed" hid November's
       * month-to-date theoretical and claimed a consumption for it.
       */
      const months = new Set()
      for (const h of records.values()) if (h.potential) months.add(h.month)
      console.log(
        `  [mc-consumption] ${records.size} month-outlet-articles, ${[...months].sort().join(',')} ` +
          `in ${((Date.now() - started) / 1000).toFixed(1)}s`
      )
      return { records, months: [...months].sort() }
    },
    { seconds: TTL }
  )
}

/**
 * Everything both page reads need, placed on brands and branches, for the
 * closed months plus the month in progress (theoretical only).
 *
 *   rows   [{ month, brand, branch, kstName, article, name, consumption|null, potential }]
 *   closed months with a closed count;  open: potentialCos's open-month state
 */
async function placedRows({ settled = false } = {}) {
  const [counts, map, live] = await Promise.all([closedCounts(), kstMap(), settled ? mcPotentialCosSettled() : mcPotentialCos()])
  const rows = []
  const closedSet = new Set(counts.months)
  for (const h of counts.records.values()) {
    // Counts in a month MC has not closed (stock only, no theoretical) say
    // nothing about that month's consumption yet; they are left out.
    if (!closedSet.has(h.month)) continue
    const placed = map.get(kstKey(h.kst))
    rows.push({
      month: h.month,
      brand: placed?.brand ?? null,
      branch: placed?.branch ?? null,
      kstName: h.kst,
      article: h.article,
      name: h.name,
      consumption: h.consumption,
      potential: h.potential,
    })
  }
  // The month in progress: theoretical from DAILYTOTALS, consumption not counted yet.
  const open = live?.open?.status === 'ready' ? live.open.month : null
  if (open && !counts.months.includes(open)) {
    for (const [k, inner] of live.byBranch) {
      const q = inner.get(open)
      if (!q) continue
      const [brand, branch, article] = k.split('|')
      rows.push({
        month: open,
        brand,
        branch,
        kstName: live.branchNames.get(`${brand}|${branch}`) ?? branch,
        article,
        name: live.names.get(article) ?? '',
        consumption: null,
        potential: q,
      })
    }
  }
  return {
    rows,
    closed: counts.months,
    open: live?.open ?? null,
    openMonth: open && !counts.months.includes(open) ? open : null,
  }
}

const sumOrNull = (a, b) => (a === null || b === null ? null : a + b)

/**
 * Same contract as `oracleConsumptionByArticle`, from MC. `consumption` is null
 * for an article whose window includes a month MC has not counted.
 */
export async function mcConsumptionByArticle({ from, to, brands = null, includeUnmapped = false, noTheoreticalFrom = [] } = {}) {
  if (!mcOracleConfigured() || !from || !to) return null
  const firstMonth = monthStart(from)
  const lastMonth = monthStart(to)
  const endsMonth = (() => {
    const [y, m, d] = String(to).slice(0, 10).split('-').map(Number)
    return d === new Date(Date.UTC(y, m, 0)).getUTCDate()
  })()
  const partial = !(String(from).slice(8, 10) === '01' && endsMonth)
  const wanted = new Set((brands ?? []).map((b) => String(b).trim().toUpperCase()).filter(Boolean))
  const noTheo = new Set((noTheoreticalFrom ?? []).map((b) => String(b).trim().toUpperCase()))

  const placed = await placedRows()
  const months = []
  for (let d = new Date(`${firstMonth}T00:00:00Z`); ; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const iso = d.toISOString().slice(0, 10)
    if (iso > lastMonth) break
    months.push(iso)
  }
  const inWindow = new Set(months)
  const uncounted = months.filter((m) => !placed.closed.includes(m))

  const byKey = new Map()
  const byArticle = new Map()
  const byBranch = new Map()
  const names = new Map()
  const nameVariants = new Map()
  const branchNames = new Map()
  const unplaced = { consumption: 0, potential: 0, rows: 0 }
  const unidentified = { consumption: 0, potential: 0, rows: 0 }
  const add = (map, k, cons, pot) => {
    const h = map.get(k) ?? { consumption: 0, potential: 0 }
    h.consumption = sumOrNull(h.consumption, cons)
    h.potential += pot
    map.set(k, h)
  }

  for (const r of placed.rows) {
    if (!inWindow.has(r.month)) continue
    const cons = r.consumption
    if (!r.article) {
      unidentified.consumption += cons ?? 0
      unidentified.potential += r.potential
      unidentified.rows += 1
      continue
    }
    if (!r.brand && !includeUnmapped) continue
    const brand = r.brand ?? UNMAPPED_BRAND
    if (wanted.size && r.brand && !wanted.has(brand)) continue
    const pot = r.branch && noTheo.has(r.branch) ? 0 : r.potential
    add(byKey, `${r.article}|${brand}`, cons, pot)
    add(byArticle, r.article, cons, pot)
    if (r.name) {
      if (!names.has(r.article)) names.set(r.article, r.name)
      const v = nameVariants.get(r.article)
      if (v) v.add(r.name)
      else nameVariants.set(r.article, new Set([r.name]))
    }
    if (r.branch) {
      add(byBranch, `${r.article}|${brand}|${r.branch}`, cons, pot)
      if (!branchNames.has(`${brand}|${r.branch}`)) branchNames.set(`${brand}|${r.branch}`, r.kstName)
    } else {
      unplaced.consumption += cons ?? 0
      unplaced.potential += pot
      unplaced.rows += 1
    }
  }
  /*
   * A window that includes the uncounted month: every article's consumption
   * is unknown for it, so it is null across the board - including articles
   * that happened to have no row in the open month's theoretical.
   */
  if (uncounted.length) {
    for (const map of [byKey, byArticle, byBranch]) for (const h of map.values()) h.consumption = null
  }
  const ambiguous = new Set()
  for (const [a, v] of nameVariants) if (v.size > 1) ambiguous.add(a)
  return {
    byKey,
    byArticle,
    names,
    months,
    partial,
    byBranch,
    branchNames,
    unplaced,
    unidentified,
    ambiguous,
    source: 'mc',
    uncountedMonths: uncounted,
    openMonth: placed.openMonth ? { month: placed.openMonth, through: placed.open?.through ?? null } : null,
  }
}

/**
 * Same contract as `oracleConsumptionTrend`, from MC: every closed month in
 * the last nine. The month in progress is left out of the trend - a month with
 * no consumption has no variance to draw - and shown on the table instead.
 *
 * `includeOpen` (28 Nov 2026, for Monthly MC Analysis) adds the month in
 * progress too, with its theoretical (MC's daily postings to date) and its
 * consumption NULL - not zero - because consumption needs the closing count.
 */
export async function mcConsumptionTrend({ brands = null, includeUnmapped = false, noTheoreticalFrom = [], includeOpen = false } = {}) {
  if (!mcOracleConfigured()) return null
  const wanted = new Set((brands ?? []).map((b) => String(b).trim().toUpperCase()).filter(Boolean))
  const noTheo = new Set((noTheoreticalFrom ?? []).map((b) => String(b).trim().toUpperCase()))
  // A caller that shows the month in progress waits for its read rather than drop it.
  const placed = await placedRows({ settled: includeOpen })
  const closed = new Set(placed.closed)
  const series = new Map()
  const byMonth = new Map()
  const add = (map, k, month, cons, pot) => {
    let inner = map.get(k)
    if (!inner) {
      inner = new Map()
      map.set(k, inner)
    }
    const h = inner.get(month) ?? { consumption: 0, potential: 0 }
    // Uncounted stays uncounted: one null consumption makes the month's null.
    h.consumption = cons === null || h.consumption === null ? null : h.consumption + cons
    h.potential += pot
    inner.set(month, h)
  }
  const open = includeOpen ? placed.openMonth : null
  const names = new Map()
  for (const r of placed.rows) {
    if (r.article && r.name && !names.has(r.article)) names.set(r.article, String(r.name).trim())
    if (!(closed.has(r.month) || (open && r.month === open)) || !r.article) continue
    if (!r.brand && !includeUnmapped) continue
    const brand = r.brand ?? UNMAPPED_BRAND
    if (wanted.size && r.brand && !wanted.has(brand)) continue
    const pot = r.branch && noTheo.has(r.branch) ? 0 : r.potential
    add(series, `${r.article}|${brand}`, r.month, r.consumption, pot)
    add(byMonth, r.article, r.month, r.consumption, pot)
  }
  return { series, byMonth, names, months: [...closed, ...(open ? [open] : [])].sort(), openMonth: open, source: 'mc' }
}
