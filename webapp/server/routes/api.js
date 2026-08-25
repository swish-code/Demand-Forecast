import { Router } from 'express'
import { data } from '../data/index.js'
import { db, DATA_DIR } from '../db/index.js'
import { buildContext, explain, trustNote } from '../insights/context.js'
import {
  deriveKpis,
  mergeDateRange,
  mergeKpis,
  mergeOptions,
  mergeRows,
  mergeTrend,
} from '../data/merge.js'
import { clearCache } from '../cache.js'
import { refreshRecentAll, cubeState } from '../cube/schedule.js'
import { config, missingSettings } from '../config.js'
import {
  allowedBrands,
  applyLocationScope,
  loadScope,
  requireAuth,
  requireRole,
  resolveScopedBrand,
  resolveScopedBrands,
} from '../auth/middleware.js'

export const api = Router()

// Health is deliberately public so a monitor can reach it without credentials;
// everything below it requires a session.


const LIST_KEYS = ['brands', 'locations', 'products', 'articles', 'items', 'recipeGroups', 'nodeTypes']

/**
 * Which extra dimensions the reader has asked the table to split by.
 *
 * Showing Branch or Date is not a display choice — a row summed across every
 * branch cannot be split back apart in the browser, so the request has to be
 * grouped that way in the first place. Anything else in the list is ignored.
 */
function grainOf(req) {
  const src = req.method === 'POST' ? req.body || {} : req.query || {}
  const raw = src.grain
  const asked = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  const want = new Set(asked.map((v) => String(v).trim().toLowerCase()))
  return { date: want.has('date'), location: want.has('location') }
}

/** Accept filters from a JSON body (POST) or query string (GET). */
function parseFilters(req) {
  const src = req.method === 'POST' ? req.body || {} : req.query || {}
  const f = {}

  for (const key of LIST_KEYS) {
    const raw = src[key]
    if (raw === undefined || raw === null || raw === '') continue
    const list = Array.isArray(raw) ? raw : String(raw).split(',')
    f[key] = list.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '')
  }

  const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined)
  f.dateFrom = date(src.dateFrom)
  f.dateTo = date(src.dateTo)
  // Prep status is multi-select like every other slicer. A bare string is still
  // accepted so an older client or a hand-built query keeps working.
  const prep = src.prepStatus
  if (prep !== undefined && prep !== null && prep !== '') {
    const list = (Array.isArray(prep) ? prep : String(prep).split(','))
      .map((v) => String(v).trim())
      .filter((v) => v !== '' && v !== 'All')
    if (list.length) f.prepStatus = list
  }

  return f
}

/**
 * Which brand this request is for, narrowed to what the signed-in user may see.
 * Returns null when the user has no brands at all — callers refuse rather than
 * fall back to everything.
 */
function brandOf(req) {
  const src = req.method === 'POST' ? req.body || {} : req.query || {}
  return resolveScopedBrand(req.scope, src.brand)
}

/**
 * The brands this request covers.
 *
 * `brands` (an array) is the current shape; a single `brand` is still accepted
 * so an older client or a hand-built query keeps working.
 */
function brandsOf(req) {
  const src = req.method === 'POST' ? req.body || {} : req.query || {}
  const asked = src.brands ?? src.brand
  return resolveScopedBrands(req.scope, asked)
}

/**
 * Filters for the chosen brand, narrowed to the user's grants.
 *
 * Two models hold more than one chain (SLC-BUR has SLC + BUR, ERMG has
 * MM + TBL), so the brand's own chain is pinned here — one row in the picker
 * always means exactly one brand.
 *
 * The location narrowing is the security-critical part: it is derived from the
 * session, never from the request, so editing the payload cannot widen access.
 */
function scopedFilters(req, brand) {
  const f = parseFilters(req)
  // Carried so the local copy can be looked up by brand. The DAX builder
  // ignores it, and two brands sharing one model — SLC with BUR, MM with TBL —
  // are otherwise indistinguishable once you are past the dataset id.
  if (brand?.code) f.brand = brand.code
  if (brand?.chain) f.brands = [brand.chain]
  return applyLocationScope(f, req.scope)
}

/**
 * Public on purpose: an uptime monitor must reach it without credentials, and
 * it exposes only configuration facts, never data.
 */
/**
 * Is this instance actually serving?
 *
 * A platform health check that only proves the process is listening will keep
 * routing traffic to an instance whose database has gone. So the database is
 * touched here — one trivial read — and a failure is reported as unhealthy
 * rather than as a cheerful ok.
 */
api.get('/health', (req, res) => {
  let database = 'ok'
  try {
    db.prepare('SELECT 1 AS ok').get()
  } catch (err) {
    database = err.message
  }
  const ok = database === 'ok'
  res.status(ok ? 200 : 503).json({
    ok,
    database,
    storage: DATA_DIR,
    mode: data.mode,
    workspaceId: config.pbi.workspaceId,
    signedIn: Boolean(req.user),
    missingSettings: config.demoMode ? [] : missingSettings(),
  })
})

/** Everything past this point needs a session and carries a scope. */
api.use(requireAuth, (req, res, next) => {
  req.scope = loadScope(req.user.id, req.user.role)
  next()
})

/** Refuse cleanly when a user's grants cover nothing in the requested brand. */
function guard(req, res) {
  const brand = brandOf(req)
  if (!brand) {
    res.status(403).json({ error: 'No brands are assigned to your account. Contact an administrator.' })
    return null
  }
  const { filters, denied } = scopedFilters(req, brand)
  if (denied) {
    res.status(403).json({ error: 'You do not have access to the requested locations.' })
    return null
  }
  return { brand, ds: brand.datasetId, f: filters }
}

/**
 * The multi-brand form of `guard`. Returns one entry per selected brand, each
 * with its own dataset and its own chain-pinned filters, plus a `fanOut` helper
 * that runs a query across all of them.
 *
 * Queries go out in parallel; the Power BI client's own concurrency gate keeps
 * that from turning into a burst it will throttle.
 */
function guardMany(req, res) {
  const brands = brandsOf(req)
  if (!brands.length) {
    res.status(403).json({ error: 'No brands are assigned to your account. Contact an administrator.' })
    return null
  }

  const parts = []
  for (const brand of brands) {
    const { filters, denied } = scopedFilters(req, brand)
    if (denied) continue
    parts.push({ brand, ds: brand.datasetId, f: filters })
  }

  if (!parts.length) {
    res.status(403).json({ error: 'You do not have access to the requested locations.' })
    return null
  }

  return {
    parts,
    brands: parts.map((p) => p.brand),
    single: parts.length === 1,
    fanOut: (fn) => Promise.all(parts.map((p) => fn(p))),
  }
}

/** Wrap a handler so thrown errors reach the Express error middleware. */
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next)

api.get('/brands', requireAuth, (req, res) => {
  const scope = loadScope(req.user.id, req.user.role)
  res.json({ brands: allowedBrands(scope).map(({ code, label }) => ({ code, label })) })
})

/**
 * Slicer options for the selected brands.
 *
 * `need` names the lists the calling page actually shows. It matters: each list
 * is its own DAX query, so the summary page asking for the four it uses instead
 * of all nine is the single biggest saving on a page load.
 */
api.all('/slicers', handle(async (req, res) => {
  const g = guardMany(req, res)
  if (!g) return

  const src = req.method === 'POST' ? req.body || {} : req.query || {}
  const need = Array.isArray(src.need) && src.need.length ? src.need : null

  const results = await g.fanOut(({ f, ds }) => data.slicers(f, ds, need))
  if (g.single) return res.json(results[0])

  res.json({
    brands: mergeOptions(results.map((r) => r.brands)),
    locations: mergeOptions(results.map((r) => r.locations)),
    products: mergeOptions(results.map((r) => r.products)),
    articles: mergeOptions(results.map((r) => r.articles)),
    articleNames: mergeOptions(results.map((r) => r.articleNames)),
    items: mergeOptions(results.map((r) => r.items)),
    recipeGroups: mergeOptions(results.map((r) => r.recipeGroups)),
    nodeTypes: mergeOptions(results.map((r) => r.nodeTypes)),
    prepStatus: mergeOptions(results.map((r) => r.prepStatus)),
    dateRange: mergeDateRange(results.map((r) => r.dateRange)),
  })
}))

/**
 * The window immediately before the selected one, same length. Used to answer
 * "is this period unusual or business as usual?" next to the variance figure.
 */
// Exported so the cache prewarmer can compute the identical window. Two copies
// of this arithmetic would drift by a day and the warmer would silently fill
// cache entries nothing ever asks for.
export function previousWindow(f) {
  if (!f.dateFrom || !f.dateTo) return null
  const DAY = 86400000
  const from = new Date(f.dateFrom + 'T00:00:00Z').getTime()
  const to = new Date(f.dateTo + 'T00:00:00Z').getTime()
  const span = Math.round((to - from) / DAY) + 1
  const prevTo = from - DAY
  const prevFrom = prevTo - (span - 1) * DAY
  const iso = (t) => new Date(t).toISOString().slice(0, 10)
  return { ...f, dateFrom: iso(prevFrom), dateTo: iso(prevTo) }
}

api.all('/summary', handle(async (req, res) => {
  const g = guardMany(req, res)
  if (!g) return
  const src = req.method === 'POST' ? req.body : req.query
  // 0 or absent means every product; the client scrolls the full list.
  const top = Number(src?.top) || 0

  const results = await g.fanOut(async ({ ds, f, brand }) => {
    const prevFilters = previousWindow(f)

    // One trend query covering both windows rather than two.
    //
    // The previous period's KPIs used to be their own query per brand — nine of
    // the thirty-six a nine-brand load fires, for a parenthetical on one card.
    // Widening this query to span both windows and splitting the rows here
    // costs nothing extra and removes a quarter of the page's requests, which
    // matters on a capacity that answers 429 with a sixty-second Retry-After.
    const spanning = prevFilters ? { ...f, dateFrom: prevFilters.dateFrom } : f

    const [rows, topProducts, byLocation] = await Promise.all([
      data.trend(spanning, ds),
      data.topProducts(f, top, ds),
      data.byLocation(f, ds),
    ])

    const inWindow = (r, from, to) => (!from || r.Date >= from) && (!to || r.Date <= to)
    const trend = rows.filter((r) => inWindow(r, f.dateFrom, f.dateTo))
    const total = (list, field) => list.reduce((n, r) => n + (Number(r[field]) || 0), 0)

    // The headline KPIs are the trend summed over the window — verified equal
    // to the dedicated KPI query for all nine models, to the unit.
    const kpis = deriveKpis(total(trend, 'Actual_Qty'), total(trend, 'Forecast_Qty'))

    const prevRows = prevFilters
      ? rows.filter((r) => inWindow(r, prevFilters.dateFrom, prevFilters.dateTo))
      : []
    const prev = prevRows.length
      ? deriveKpis(total(prevRows, 'Actual_Qty'), total(prevRows, 'Forecast_Qty'))
      : null

    return { brand, kpis, trend, topProducts, byLocation, prev }
  })

  if (g.single) {
    const { kpis, trend, topProducts, byLocation, prev } = results[0]
    return res.json({ kpis, trend, topProducts, byLocation, prev })
  }

  res.json({
    kpis: mergeKpis(results.map((r) => r.kpis)),
    trend: mergeTrend(results.map((r) => r.trend)),
    // Product names repeat across brands, so the brand is part of the key and a
    // combined view lists "Chilli Lime" once per brand that sells it.
    topProducts: mergeRows(
      results.map((r) => r.topProducts.map((x) => ({ ...x, CHAINID: x.CHAINID ?? r.brand.code }))),
      {
        key: (x) => `${x.CHAINID}|${x.ProductName_Fixed_Option}`,
        sum: ['Actual_Qty', 'Forecast_Qty'],
        sort: (a, b) => Number(b.Actual_Qty) - Number(a.Actual_Qty),
      }
    ),
    byLocation: mergeRows(
      results.map((r) => r.byLocation.map((x) => ({ ...x, CHAINID: x.CHAINID ?? r.brand.code }))),
      { key: (x) => `${x.CHAINID}|${x.LocationID}`, sum: ['Actual_Qty', 'Forecast_Qty'] }
    ),
    prev: results.some((r) => r.prev) ? mergeKpis(results.map((r) => r.prev)) : null,
  })
}))

api.all('/product-level', handle(async (req, res) => {
  const g = guardMany(req, res)
  if (!g) return

  const results = await g.fanOut(async ({ ds, f, brand }) => {
  const grain = grainOf(req)
  const prevFilters = previousWindow(f)

  /*
   * What "the same thing, last month" means depends on the grain.
   *
   * Split by branch, it is that branch's own history — comparing one branch
   * against the chain's total would read as a collapse everywhere. Split by
   * day, there is nothing to compare to: the row is a single Tuesday and the
   * window before it is a month, so the comparison is dropped rather than
   * invented. Left as it was, it read +1,665% on a row that had barely moved.
   */
  const prevGrain = { date: false, location: grain.location }
  const sameThing = (r) =>
    prevGrain.location ? `${r.LocationID}|${r.Clean_ItemID}` : String(r.Clean_ItemID)
  const comparable = Boolean(prevFilters) && !grain.date

  const [kpis, rows, prevRows] = await Promise.all([
    data.kpis(f, ds),
    data.productLevel(f, ds, grain),
    // The same articles over the window immediately before. Without it a large
    // variance is just a number; with it you can tell a product whose demand
    // moved from one the forecast simply got wrong.
    comparable ? data.productLevel(prevFilters, ds, prevGrain).catch(() => null) : null,
  ])

  let withShift = rows
  if (prevRows) {
    const before = new Map(prevRows.map((r) => [sameThing(r), Number(r.Actual_Qty) || 0]))
    withShift = rows.map((r) => {
      const was = before.get(sameThing(r))
      return {
        ...r,
        Prev_Actual_Qty: was ?? null,
        // Null rather than zero when there is nothing to compare against: a
        // product that did not exist last month has no demand change, and
        // showing it as +100% would be a lie about a new listing.
        Demand_Shift_Pct: was ? (Number(r.Actual_Qty) - was) / was : null,
      }
    })
  }

    return {
      brand,
      kpis,
      rows: withShift.map((r) => ({ ...r, CHAINID: r.CHAINID ?? brand.code })),
      comparedWith: comparable ? { from: prevFilters.dateFrom, to: prevFilters.dateTo } : null,
    }
  })

  if (g.single) {
    const { kpis, rows, comparedWith } = results[0]
    return res.json({ kpis, rows, comparedWith })
  }

  res.json({
    kpis: mergeKpis(results.map((r) => r.kpis)),
    // One row per article per brand: the same article code can exist in two
    // chains and mean two different things.
    rows: results.flatMap((r) => r.rows),
    comparedWith: results[0].comparedWith,
  })
}))

api.all('/component-level', handle(async (req, res) => {
  const g = guardMany(req, res)
  if (!g) return
  const results = await g.fanOut(({ ds, f }) => data.componentLevel(f, ds, grainOf(req)))
  if (g.single) return res.json({ rows: results[0] })

  // Components are shared recipes, so the same item in two brands is genuinely
  // the same thing to order — these do add up.
  res.json({
    rows: mergeRows(results, {
      key: (r) => `${r['Recipe Group']}|${r.Item}|${r.BU}`,
      sum: ['Component_Forecast_Qty'],
      sort: (a, b) => Number(b.Component_Forecast_Qty) - Number(a.Component_Forecast_Qty),
    }),
  })
}))

/**
 * The production plan's measures across however many brands were asked for.
 *
 * Plan_Date is not summed — it is the day the plan covers, which every brand
 * agrees on because they all read it from the same TODAY(). The latest is taken
 * rather than the first so a brand whose model has not refreshed cannot make
 * the whole page claim an older day than it is showing.
 */
function mergePlanKpis(list) {
  const kpis = list.reduce(
    (acc, r) => ({
      Tomorrow_Forecast_Qty: acc.Tomorrow_Forecast_Qty + (Number(r?.Tomorrow_Forecast_Qty) || 0),
      Products_To_Prepare: acc.Products_To_Prepare + (Number(r?.Products_To_Prepare) || 0),
      High_Demand_Products: acc.High_Demand_Products + (Number(r?.High_Demand_Products) || 0),
      Low_Demand_Products: acc.Low_Demand_Products + (Number(r?.Low_Demand_Products) || 0),
      Today_Forecast_Qty: acc.Today_Forecast_Qty + (Number(r?.Today_Forecast_Qty) || 0),
    }),
    {
      Tomorrow_Forecast_Qty: 0,
      Products_To_Prepare: 0,
      High_Demand_Products: 0,
      Low_Demand_Products: 0,
      Today_Forecast_Qty: 0,
    }
  )
  const latest = (key) => {
    const days = list.map((r) => r?.[key]).filter(Boolean).sort()
    return days.length ? days[days.length - 1] : null
  }
  return { ...kpis, Plan_Date: latest('Plan_Date'), Today_Date: latest('Today_Date') }
}

/**
 * Tomorrow's totals without tomorrow's rows.
 *
 * The Overview shows one figure from the production plan. Asking /production-plan
 * for it would ship several thousand article rows to draw a single card, so the
 * measures are fetched on their own.
 */
api.all('/production-plan/kpis', handle(async (req, res) => {
  const g = guardMany(req, res)
  if (!g) return

  const results = await g.fanOut(({ ds, f }) => data.productionPlanKpis(f, ds))
  res.json({ kpis: mergePlanKpis(results) })
}))

api.all('/production-plan', handle(async (req, res) => {
  const g = guardMany(req, res)
  if (!g) return

  const results = await g.fanOut(async ({ ds, f, brand }) => {
    const [kpis, rows] = await Promise.all([
      data.productionPlanKpis(f, ds),
      data.productionPlan(f, ds),
    ])
    return { brand, kpis, rows }
  })

  if (g.single) return res.json({ kpis: results[0].kpis, rows: results[0].rows })

  res.json({
    kpis: mergePlanKpis(results.map((r) => r.kpis)),
    rows: results.flatMap((r) => r.rows),
  })
}))

/**
 * Why forecast and actual differ, for the pages that show it to end users.
 *
 * Deliberately its own endpoint rather than bolted onto /summary: the
 * production plan needs it too, it is the same answer for both, and computing
 * it once means the explanation a branch reads is word for word the one head
 * office reads.
 *
 * The window is fixed at the last 30 complete days and ignores the date slicer.
 * "Is this normal for us?" is a question about the recent past, not about
 * whatever range someone happens to have selected.
 */
const CONTEXT_DAYS = 30
/** Only the calendar is needed here — an empty list skips every option query. */
const DATE_ONLY = []

api.all('/context', handle(async (req, res) => {
  const g = guardMany(req, res)
  if (!g) return
  const { ds, f } = g.parts[0]

  const slicers = await data.slicers({ ...f, dateFrom: undefined, dateTo: undefined }, ds, DATE_ONLY)
  const today = slicers?.dateRange?.today ?? null
  const last = slicers?.dateRange?.lastActual ?? slicers?.dateRange?.max ?? null
  if (!last) return res.json({ enough: false, days: 0 })

  const DAY = 86400000
  const from = new Date(Date.parse(`${last}T00:00:00Z`) - (CONTEXT_DAYS - 1) * DAY)
    .toISOString()
    .slice(0, 10)
  // Location and product filters are kept: a branch asking why its own numbers
  // are off should be answered about its own numbers.
  const window = { ...f, dateFrom: from, dateTo: last }

  // Across several brands the explanation is about the combined numbers, so the
  // series are merged before the rules run — the same way the summary page adds
  // them up.
  const results = await g.fanOut(async (part) => {
    const w = { ...part.f, dateFrom: window.dateFrom, dateTo: window.dateTo }
    const [t, l] = await Promise.all([
      data.trend(w, part.ds),
      data.byLocation(w, part.ds).catch(() => []),
    ])
    return { trend: t, byLocation: l.map((x) => ({ ...x, CHAINID: x.CHAINID ?? part.brand.code })) }
  })

  const trend = mergeTrend(results.map((r) => r.trend))
  const byLocation = mergeRows(results.map((r) => r.byLocation), {
    key: (x) => `${x.CHAINID}|${x.LocationID}`,
    sum: ['Actual_Qty', 'Forecast_Qty'],
  })

  const ctx = buildContext({ trend, byLocation, today })
  res.json({ ...ctx, explanation: explain(ctx), trustNote: trustNote(ctx) })
}))

api.post('/cache/clear', (req, res) => {
  clearCache()
  // Refresh in the corner means "give me the current numbers", so it pulls the
  // recent days into the local copy as well. Deliberately not awaited: it is
  // nine queries against a capacity that may be throttling, and the page should
  // not sit on a spinner for it. The next request picks up whatever landed.
  refreshRecentAll()
  res.json({ ok: true, refreshing: true })
})

/** What the local copy holds, for the admin panel. */
api.get('/cube', requireRole('admin'), (req, res) => res.json(cubeState()))
