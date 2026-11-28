/**
 * MC's theoretical quantity - Potential COS QTY - read live from MC.
 *
 * Added 25 Nov 2026, on request: "eliminate the intermediate Power Query /
 * Power BI process and retrieve the theoretical quantities directly from MC."
 * It replaces the `'Consumption Qty'[Potential COS QTY]` figure on the PM
 * Historical Reconciliation tab of Variance Analysis, and nowhere else.
 *
 * THE DEFINITION IS THE ONE THE POWER QUERY USED, unchanged:
 *
 *   SUM(INVPOSWES.INP_SALES) over INVENTUR rows with INV_TYP = 1 (the monthly
 *   count) and INV_STATUS = 8 (closed), dated inside the month.
 *
 * MC stores it negative; it is negated once here, as the Power BI read did, so
 * a reversal still reduces the figure rather than adding to it.
 *
 * A MONTH EXISTS ONLY ONCE MC HAS CLOSED ITS COUNT. MC writes INP_SALES when the
 * month-end count is closed, so the month in progress has no figure at all -
 * checked 25 Nov 2026: November holds one closed count, dated 1 Nov, with no
 * INP_SALES. `months` lists only the months that have one, and the caller shows
 * the rest as "not closed in MC yet" rather than as zero.
 *
 * WHY NOT DAILYTOTALS. It agrees for October (SS: 2,081,463 against 2,079,876
 * here) but holds September twice - MC rewrote every September day on 24 Nov
 * 2026 and DAILYTOTALS reads 3,491,180 for SS where the closed count reads
 * 1,740,568. It is also a two-minute read per brand; this is under a second.
 *
 * Brand and branch come from the same KST MAP the rest of the page uses, matched
 * on the outlet name, and catering's theoretical (CAT) is left out as it is
 * everywhere on the page.
 */
import { cached } from '../cache.js'
import { mcSelect, mcOracleConfigured } from './oracle.js'
import { CATERING_BRANCHES, canonArticle } from '../powerbi/consumption.js'
import { kstMap, kstKey } from '../insights/theoreticalDrivers.js'

/** How far back the read goes. The page draws at most six complete months. */
const MONTHS_BACK = 9

/**
 * Held for an hour. A closed count can be reopened and closed again - MC has
 * status 9 counts beside the 8s - so the figure is not frozen forever.
 */
const TTL = 3600

const firstOfMonthsAgo = (n, now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)).toISOString().slice(0, 10)

/**
 * Fold MC's rows into the page's keys. Pure, so the mapping rules are tested.
 *
 *   rows   [{ M: 'YYYY-MM-DD', KST_NAME, ART_NUMMER, ART_NAME, POT }]  POT as MC stores it
 *   map    Map(kstKey(name) -> { brand, branch })
 *
 * Returns
 *   series    Map('<article>|<BRAND>' -> Map('<YYYY-MM-01>' -> qty))
 *   months    every month with a closed count, ascending
 *   names     Map('<article>' -> MC's name)
 *   unplaced  Map('<YYYY-MM-01>' -> qty) for outlets the KST MAP does not place
 */
export function foldPotential(rows, map, { noTheo = CATERING_BRANCHES } = {}) {
  const skip = new Set(noTheo.map((b) => String(b).toUpperCase()))
  const series = new Map()
  /** '<BRAND>|<BRANCH>|<article>' -> month -> qty, for the branch tab. */
  const byBranch = new Map()
  /** '<BRAND>|<BRANCH>' -> MC's outlet name. */
  const branchNames = new Map()
  const names = new Map()
  const unplaced = new Map()
  const monthSet = new Set()
  for (const r of rows) {
    const month = String(r.M ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-01$/.test(month)) continue
    monthSet.add(month)
    const qty = -(Number(r.POT) || 0)
    const article = canonArticle(r.ART_NUMMER)
    if (!article || !qty) continue
    const placed = map.get(kstKey(r.KST_NAME))
    if (!placed) {
      unplaced.set(month, (unplaced.get(month) ?? 0) + qty)
      continue
    }
    if (skip.has(placed.branch)) continue
    const key = `${article}|${placed.brand}`
    const inner = series.get(key) ?? new Map()
    inner.set(month, (inner.get(month) ?? 0) + qty)
    series.set(key, inner)
    if (placed.branch) {
      const bk = `${placed.brand}|${placed.branch}|${article}`
      const b = byBranch.get(bk) ?? new Map()
      b.set(month, (b.get(month) ?? 0) + qty)
      byBranch.set(bk, b)
      const outlet = `${placed.brand}|${placed.branch}`
      if (!branchNames.has(outlet)) branchNames.set(outlet, String(r.KST_NAME ?? '').trim())
    }
    if (r.ART_NAME && !names.has(article)) names.set(article, String(r.ART_NAME).trim())
  }
  return { series, byBranch, branchNames, months: [...monthSet].sort(), names, unplaced }
}

/**
 * Potential COS QTY per article, brand and month: every closed month in the
 * last nine, plus the month in progress once its background read has finished
 * (see `openMonth` below). Null when MC is not configured; throws when MC
 * cannot be reached, so the caller can say which.
 *
 * `open` says where the month in progress stands:
 *   { month, status: 'ready' | 'loading' | 'error', through, error }
 * `months` includes it only when it is 'ready'.
 */
/**
 * The same, but when the month in progress is still being read in the
 * background, wait for that read - up to `waitMs` - rather than answer
 * without it. For a caller that shows the month in progress as a column of
 * its own (Monthly MC Analysis, 28 Nov 2026): right after the server starts,
 * a request arriving in the first seconds otherwise got no November at all.
 */
export async function mcPotentialCosSettled({ waitMs = 90_000 } = {}) {
  let live = await mcPotentialCos()
  const deadline = Date.now() + waitMs
  while (live?.open?.status === 'loading' && Date.now() < deadline) {
    await Promise.race([open?.promise ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2000))])
    live = await mcPotentialCos()
  }
  return live
}

export async function mcPotentialCos() {
  if (!mcOracleConfigured()) return null
  const closed = await closedMonths()
  const open = openMonthState(closed)
  if (open.status !== 'ready') return { ...closed, open: openInfo(open) }
  return mergeOpen(closed, open)
}

/* ------------------------------------------------- the month in progress --
 *
 * 25 Nov 2026, on request: "bring Nov too".
 *
 * MC writes INP_SALES only when the month-end count closes, so the month in
 * progress has no Potential COS at all. Its theoretical does exist, day by day,
 * in DAILYTOTALS: -DAY_QTYSOLD is the same recipe explosion booked daily.
 * Checked 25 Nov 2026 against the closed count for October, every outlet:
 * 8,097,589 from DAILYTOTALS against 8,103,688 from INVPOSWES, -0.08%.
 * November was checked for the September fault (every day posted twice): it
 * runs at ~239k a day against October's ~261k, so it is not doubled. Days
 * after yesterday are present as zero rows and add nothing.
 *
 * IT IS SLOW, so it never sits in a request. DAILYTOTALS holds 138 million
 * rows indexed (KST_ID, ART_ID, DAY_DATE). Probing that index once per
 * outlet-article pair MC counted in the last three closed months (~15,400
 * pairs) took 3 min 23 s for two months and 2 min 43 s for eleven days - the
 * cost is the probes, not the days. Split four ways by outlet it runs on the
 * pool's four connections at once. So the read runs in the background - when
 * the server starts, and again once an hour - and the page shows the month
 * as "being read" until the first one lands, then the last good figure.
 *
 * NEW ARTICLES ARE A SECOND READ - 26 Nov 2026. Probing only the pairs MC
 * already counted missed every article added to a recipe since: SS's S/W
 * Jacket generic (2,879 booked since 10 Nov) and Garlic-spicy sticker (2,275
 * since 4 Nov), TBL's Chef Salad sticker (543), PAT's Slider Plus sticker -
 * about 7,000 units booked by MC and shown as nothing. So the articles put on
 * an active recipe line, or linked straight to a product, in the same three
 * months are probed at every counted outlet as well. On its own that read
 * takes about 2 s; folded into the first query as a UNION the plan changed and
 * it took 4 minutes, which is why it is separate. A pair both reads return is
 * kept once (`mergeRows`), so nothing is counted twice.
 */
const OPEN_TTL_MS = 60 * 60 * 1000
const OPEN_PARTS = 4
let open = null // { month, status, value, through, error, at, promise }

function closedMonths() {
  const from = firstOfMonthsAgo(MONTHS_BACK)
  return cached(
    `mc-potential-cos:${from}`,
    async () => {
      const started = Date.now()
      const [map, rows] = await Promise.all([
        kstMap(),
        mcSelect(
          `SELECT TO_CHAR(TRUNC(i.inv_datum, 'MM'), 'YYYY-MM-DD') AS m,
                  k.kst_name, a.art_nummer, MAX(a.art_name) AS art_name,
                  SUM(w.inp_sales) AS pot
             FROM invposwes w
             JOIN inventur i ON i.inv_id = w.inv_id
             JOIN kostst k   ON k.kst_id = i.kst_id
             JOIN artikel a  ON a.art_id = w.art_id
            WHERE i.inv_typ = 1
              AND i.inv_status = 8
              AND i.inv_datum >= TO_DATE(:f, 'YYYY-MM-DD')
            GROUP BY TRUNC(i.inv_datum, 'MM'), k.kst_name, a.art_nummer`,
          { f: from }
        ),
      ])
      const out = foldPotential(rows, map)
      // A month whose counts carry no INP_SALES at all is not closed in any
      // sense that matters here - November's lone 1 Nov count is one.
      const withFigures = new Set()
      for (const inner of out.series.values()) for (const m of inner.keys()) withFigures.add(m)
      out.months = out.months.filter((m) => withFigures.has(m))
      console.log(
        `  [mc-potential-cos] ${out.series.size} article-brands, ` +
          `${out.months[0] ?? '-'}..${out.months[out.months.length - 1] ?? '-'} ` +
          `in ${((Date.now() - started) / 1000).toFixed(1)}s`
      )
      return out
    },
    { seconds: TTL }
  )
}

const thisMonthStart = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)

const nextMonthStart = (m) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)
}

const openInfo = (s) => ({ month: s.month, status: s.status, through: s.through ?? null, error: s.error ?? null })

/**
 * Where the month in progress stands, starting or refreshing its read when it
 * is missing or more than an hour old. Never waits for the read. A month MC
 * has already closed is not read here - the closed count answers it.
 */
function openMonthState(closed) {
  const month = thisMonthStart()
  if (closed.months.includes(month)) return { month, status: 'closed' }
  if (!open || open.month !== month) open = { month, status: 'loading' }
  const stale = !open.at || Date.now() - open.at > OPEN_TTL_MS
  if (stale && !open.promise) {
    open.promise = readOpenMonth(month)
      .then((v) => {
        open = { month, status: 'ready', value: v.out, through: v.through, at: Date.now() }
      })
      .catch((err) => {
        console.warn(`  [mc-open-month] ${month} failed: ${String(err.message).slice(0, 120)}`)
        // Keep the last good figure; record the failure only when there is none.
        if (open.status === 'ready') open = { ...open, promise: null, at: Date.now() - OPEN_TTL_MS + 10 * 60 * 1000 }
        else open = { month, status: 'error', error: String(err.message).slice(0, 200), at: Date.now() - OPEN_TTL_MS + 10 * 60 * 1000 }
      })
  }
  return open
}

/**
 * The two open-month reads as one row list: every row of the first, and the
 * rows of the second for an outlet-article pair the first did not return. Both
 * sum the same DAILYTOTALS rows for a pair, so a pair is taken once, never added.
 */
export function mergeRows(counted, fresh) {
  const key = (r) => `${kstKey(r.KST_NAME)}|${canonArticle(r.ART_NUMMER)}`
  const seen = new Set(counted.map(key))
  return [...counted, ...fresh.filter((r) => !seen.has(key(r)))]
}

/** The month in progress from DAILYTOTALS, four outlet groups at once. */
async function readOpenMonth(month) {
  const started = Date.now()
  const binds = { f: month, t: nextMonthStart(month), since: firstOfMonthsAgo(3) }
  const sql = `WITH pairs AS (
      SELECT DISTINCT i.kst_id, w.art_id
        FROM invposwes w JOIN inventur i ON i.inv_id = w.inv_id
       WHERE i.inv_typ = 1 AND i.inv_status = 8
         AND i.inv_datum >= TO_DATE(:since, 'YYYY-MM-DD')
         AND NVL(w.inp_sales, 0) <> 0
         AND MOD(i.kst_id, ${OPEN_PARTS}) = :part)
    SELECT /*+ LEADING(p) USE_NL(d) INDEX(d) */
           :f AS m, k.kst_name, a.art_nummer, MAX(a.art_name) AS art_name,
           SUM(d.day_qtysold) AS pot,
           TO_CHAR(MAX(CASE WHEN d.day_qtysold <> 0 THEN d.day_date END), 'YYYY-MM-DD') AS last_day
      FROM pairs p
      JOIN dailytotals d ON d.kst_id = p.kst_id AND d.art_id = p.art_id
      JOIN kostst k  ON k.kst_id = p.kst_id
      JOIN artikel a ON a.art_id = p.art_id
     WHERE d.day_date >= TO_DATE(:f, 'YYYY-MM-DD') AND d.day_date < TO_DATE(:t, 'YYYY-MM-DD')
     GROUP BY k.kst_name, a.art_nummer`
  const freshSql = `WITH fresh AS (
      SELECT ri.art_nr AS art_id
        FROM rezepturitem ri JOIN rezeptur r ON r.rez_id = ri.rez_id
       WHERE ri.art_nr IS NOT NULL AND NVL(r.aktiv, ' ') <> 'S'
         AND ri.new_zeit >= TO_DATE(:since, 'YYYY-MM-DD')
      UNION
      SELECT p.art_nr FROM produkt p
       WHERE p.art_nr IS NOT NULL AND p.new_zeit >= TO_DATE(:since, 'YYYY-MM-DD')),
    ksts AS (
      SELECT DISTINCT i.kst_id FROM inventur i
       WHERE i.inv_typ = 1 AND i.inv_status = 8
         AND i.inv_datum >= TO_DATE(:since, 'YYYY-MM-DD')
         AND MOD(i.kst_id, ${OPEN_PARTS}) = :part),
    pairs AS (SELECT /*+ MATERIALIZE */ k.kst_id, f.art_id FROM ksts k CROSS JOIN fresh f)
    SELECT /*+ LEADING(p) USE_NL(d) INDEX(d) */
           :f AS m, k.kst_name, a.art_nummer, MAX(a.art_name) AS art_name,
           SUM(d.day_qtysold) AS pot,
           TO_CHAR(MAX(d.day_date), 'YYYY-MM-DD') AS last_day
      FROM pairs p
      JOIN dailytotals d ON d.kst_id = p.kst_id AND d.art_id = p.art_id
      JOIN kostst k  ON k.kst_id = p.kst_id
      JOIN artikel a ON a.art_id = p.art_id
     WHERE d.day_date >= TO_DATE(:f, 'YYYY-MM-DD') AND d.day_date < TO_DATE(:t, 'YYYY-MM-DD')
       AND d.day_qtysold <> 0
     GROUP BY k.kst_name, a.art_nummer`
  const read = (q) => Array.from({ length: OPEN_PARTS }, (_, part) => mcSelect(q, { ...binds, part }))
  const [map, counted, fresh] = await Promise.all([
    kstMap(),
    Promise.all(read(sql)).then((p) => p.flat()),
    Promise.all(read(freshSql)).then((p) => p.flat()),
  ])
  const rows = mergeRows(counted, fresh)
  let through = null
  for (const r of rows) if (r.LAST_DAY && (!through || r.LAST_DAY > through)) through = r.LAST_DAY
  const out = foldPotential(rows, map)
  console.log(
    `  [mc-open-month] ${month} through ${through ?? '-'}: ${out.series.size} article-brands ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`
  )
  return { out, through }
}

/** The closed months with the month in progress added. Memoised per pair. */
let merged = null
function mergeOpen(closed, state) {
  if (merged && merged.closed === closed && merged.state === state) return merged.value
  const month = state.month
  const add = (target, source) => {
    for (const [k, inner] of source) {
      const copy = new Map(target.get(k) ?? [])
      for (const [m, q] of inner) if (m === month) copy.set(m, q)
      target.set(k, copy)
    }
  }
  const series = new Map(closed.series)
  const byBranch = new Map(closed.byBranch)
  add(series, state.value.series)
  add(byBranch, state.value.byBranch)
  const names = new Map(closed.names)
  for (const [a, n] of state.value.names) if (!names.has(a)) names.set(a, n)
  const branchNames = new Map(closed.branchNames)
  for (const [b, n] of state.value.branchNames) if (!branchNames.has(b)) branchNames.set(b, n)
  const value = {
    ...closed,
    series,
    byBranch,
    names,
    branchNames,
    months: [...closed.months, month].sort(),
    open: openInfo(state),
  }
  merged = { closed, state, value }
  return value
}

/*
 * Start the month in progress as soon as the server is up, so the first person
 * to open the page does not find it still reading. Unref'd, so it never holds
 * the process open, and swallowed, because a failure is already recorded.
 */
if (
  mcOracleConfigured() &&
  process.env.NODE_ENV !== 'test' &&
  !process.env.NODE_TEST_CONTEXT &&
  !process.execArgv.some((a) => a.startsWith('--test'))
) {
  setTimeout(() => {
    mcPotentialCos().catch(() => {})
  }, 5000).unref()
}
