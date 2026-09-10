import { Router } from 'express'
import { data } from '../data/index.js'
import { DATA_DIR } from '../db/driver.js'
import { pg } from '../db/accounts.js'
import { buildContext, explain, trustNote } from '../insights/context.js'
import {
  deriveKpis,
  mergeDateRange,
  mergeKpis,
  mergeOptions,
  mergeRows,
  mergeTrend,
} from '../data/merge.js'
import { cached, clearCache } from '../cache.js'
import { tag } from '../perf.js'
import { refreshRecentAll, cubeState } from '../cube/schedule.js'
import { config, missingSettings, missingWarehouse } from '../config.js'
import { allowedPages } from '../departments.js'
import * as cube from '../cube/query.js'
import {
  consumptionByArticle,
  outboundFromWarehouse,
  OTHER_BUCKET,
} from '../powerbi/warehouse.js'
import { executeQuery } from '../powerbi/client.js'
import { nonRecipeRows } from '../insights/nonRecipe.js'
import { forecastFromConstants } from '../insights/whConstant.js'
import { warehouseDiagnostics } from '../insights/whDiagnostics.js'
import { classifyArticles, classifyOne, statusOf } from '../insights/whClassify.js'
import { sohTrend } from '../insights/sohTrend.js'
import { storeStock, stockColumnsFor } from '../insights/storeStock.js'
import { salesRunRate } from '../insights/salesRunRate.js'
import {
  allowedBrands,
  applyLocationScope,
  locationsForBrand,
  loadScope,
  requireAuth,
  requireRole,
  resolveScopedBrand,
  resolveScopedBrands,
} from '../auth/middleware.js'

export const api = Router()

/** Wrap a handler so thrown errors reach the Express error middleware. */
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next)


// Health is deliberately public so a monitor can reach it without credentials;
// everything below it requires a session.


const LIST_KEYS = ['brands', 'locations', 'products', 'articles', 'items', 'recipeGroups', 'nodeTypes', 'supply', 'recipeKinds', 'statuses']

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
  /*
   * Brand joins date and branch as a dimension the table can be split by.
   *
   * The rows are merged across brands by default — a component in two brands is
   * one thing to order — so showing which brand a line belongs to is not a
   * display choice: the merge has to not happen in the first place.
   */
  return { date: want.has('date'), location: want.has('location'), brand: want.has('brand') }
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

  // Narrowed within this brand: a branch granted on another brand must not
  // widen this one, and branch codes are not unique across chains.
  return applyLocationScope(f, req.scope, brand?.code ?? null)
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
api.get('/health', handle(async (req, res) => {
  let database = 'ok'
  try {
    await pg.get('SELECT 1 AS ok')
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
    missingWarehouse: config.demoMode ? [] : missingWarehouse(),
  })
}))

/** Everything past this point needs a session and carries a scope. */
api.use(requireAuth, (req, res, next) => {
  loadScope(req.user.id, req.user.role)
    .then((scope) => {
      req.scope = scope
      next()
    })
    .catch(next)
})

/*
 * Pages a restricted department may not open, refused rather than hidden.
 *
 * The rail hides them too, but a hidden tab is a decoration: the request is
 * what has to be refused, because a bookmark, a drill-through link or a typed
 * URL all reach the same route without going near the rail.
 */
function pageDenied(req, res, page) {
  const allowed = allowedPages(req.user)
  if (!allowed || allowed.includes(page)) return false
  /*
   * Named for the page rather than the department.
   *
   * The message used to explain the Ingredients restriction whatever the reason
   * was, which was wrong as soon as access could be granted per account: a
   * reader denied the Overview was told about production types they may not
   * even be restricted by.
   */
  res.status(403).json({
    error:
      'Your account does not have access to this page. ' +
      'Ask an administrator if you need it.',
  })
  return true
}

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
  // Why the last brand was refused, so the message can say which restriction
  // did it. A branch outside the grant and a production type outside it are
  // different problems with different answers, and telling somebody to check
  // their locations when they filtered by production type sends them looking in
  // the wrong place.
  let refusal = null
  for (const brand of brands) {
    const { filters, denied, reason } = scopedFilters(req, brand)
    if (denied) {
      refusal = reason ?? refusal
      continue
    }
    parts.push({ brand, ds: brand.datasetId, f: filters })
  }

  if (!parts.length) {
    res.status(403).json({ error: refusal ?? 'You do not have access to the requested locations.' })
    return null
  }

  tag('brands', parts.length)

  return {
    parts,
    brands: parts.map((p) => p.brand),
    single: parts.length === 1,
    fanOut: (fn) => Promise.all(parts.map((p) => fn(p))),
  }
}


api.get('/brands', requireAuth, handle(async (req, res) => {
  const scope = await loadScope(req.user.id, req.user.role)
  res.json({ brands: allowedBrands(scope).map(({ code, label }) => ({ code, label })) })
}))

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
  /*
   * Absent and empty are different questions.
   *
   * Absent means "everything", which is what an older client or a hand-built
   * URL means by leaving it out. Empty means "none of them" — the page has not
   * had a single dropdown opened yet, so nothing but the calendar is wanted.
   *
   * Reading empty as absent was costing nine brands about seventy live queries
   * on every page load, for eight lists nobody had asked to see. One page load
   * was measured at 10.7 seconds and 76 Power BI queries before it gave up.
   */
  const raw = src.need
  const need = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.trim()
      ? raw.split(',').map((v) => v.trim()).filter(Boolean)
      : null

  /*
   * The branch list is a grant, not a catalogue.
   *
   * The model answers with every branch the brand has, which is right for an
   * administrator and wrong for everybody else: a store account was being shown
   * the names of fifteen branches it could not open, and picking one returned a
   * 403 rather than data. The figures were never exposed — every query is
   * narrowed server-side — but the names were, and a dropdown whose entries
   * refuse to work is its own kind of broken.
   *
   * Narrowed per brand for the same reason the queries are: branch codes repeat
   * across chains.
   */
  const results = await g.fanOut(async ({ f, ds, brand }) => {
    const out = await data.slicers(f, ds, need)
    const granted = locationsForBrand(req.scope, brand?.code ?? null)

    const narrowed = { ...out }
    if (granted && out?.locations) {
      narrowed.locations = out.locations.filter((l) => granted.has(String(l)))
    }
    /*
     * Warehouse supply is raw materials, so the production type list says so.
     *
     * The rows are already narrowed to RAW by `withSupply`; leaving PA and PREP
     * in this dropdown offered two choices that would return nothing, which
     * reads as a broken filter rather than as a rule.
     */
    const supply = (f?.supply ?? []).filter(Boolean)
    if (supply.includes(SUPPLY_WAREHOUSE) && !supply.includes(SUPPLY_DIRECT) && out?.nodeTypes) {
      narrowed.nodeTypes = out.nodeTypes.filter((t) => String(t) === 'RAW')
    }
    return narrowed
  })
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
  if (pageDenied(req, res, 'summary')) return
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
  if (pageDenied(req, res, 'product')) return
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

/**
 * What actually left the warehouse, attached to what the recipes asked for.
 *
 * Consumption is a fact about an article, not about a recipe: the warehouse
 * issues "Flour All Purpose", not "flour for the burger recipe". The same
 * article appears on several rows here, once per recipe group it belongs to, so
 * writing the figure onto every one of them would count it as many times as the
 * article is used the moment anybody totals the column.
 *
 * So it goes on one row per article — the largest, by what the forecast implies
 * — and the others carry null. Null means "counted on another line", which is
 * why the column has no total in the table: a measured quantity cannot be split
 * across recipes without inventing an allocation nobody asked for.
 */
async function withConsumption(rows, brand, filters, grain = {}, mtd = null) {
  /*
   * Split by branch, there is nothing truthful to show.
   *
   * Consumption is known per brand, not per shop: outbound names its
   * destinations and the forecast uses codes, and the two lists do not yet
   * correspond. Attributing a brand's whole consumption to one branch's row
   * would be a plainly wrong number rather than a missing one.
   */
  if (grain.location) return rows.map((r) => ({ ...r, Consumed_Qty: null }))

  const byDate = Boolean(grain.date)

  /*
   * The copy first, Power BI only if it cannot answer.
   *
   * Nine brands used to mean nine warehouse queries at once, which is the burst
   * the capacity refuses with a sixty-second back-off: 62 seconds measured for
   * one page. From the copy it is a local aggregate per brand.
   */
  const fromCopy = byDate
    ? await cube.outboundByArticleDay(brand.code, filters)
    : await cube.outboundByArticle(brand.code, filters)

  const consumed =
    fromCopy ??
    (await consumptionByArticle(brand.code, filters, { byDate }).catch((err) => {
      console.warn(`  [warehouse] consumption unavailable for ${brand.code}: ${err.message}`)
      return null
    }))
  if (!consumed) return rows.map((r) => ({ ...r, Consumed_Qty: null, Consumed_Unknown: true }))

  /*
   * Absent from the window is not the same as absent from the warehouse.
   *
   * An article this warehouse ships to this brand every month and did not ship
   * in the window really did move nothing, and a requirement for it really is a
   * miss. An article it has never once shipped to this brand cannot be measured
   * at all — it reaches the shops another way, or the code does not match — and
   * writing zero against it turned "we have no evidence" into "the forecast was
   * completely wrong". Measured on 1 Sep 2026: 363 of 1,132 components showed no
   * movement in the window and 265 of those had never appeared in outbound at
   * all, each scored zero, which is most of what the accuracy card was reporting.
   */
  const shipped = await cube.articlesShippedTo(brand.code).catch(() => null)

  // Only read to explain a blank: where an article goes when it goes nowhere
  // near a shop. Nothing here is ever added to a brand's figure.
  const elsewhere = await cube.outboundElsewhere().catch(() => new Map())


  /*
   * The same articles, forecast a completely different way.
   *
   * Not from the recipes at all: from the ratio between what the warehouse
   * shipped and what the brand sold, averaged over the last six whole months,
   * applied to the sales forecast for the window on screen. Where it disagrees
   * with the recipe forecast beside it, one of the two is wrong — and that is
   * worth being able to see.
   */
  const byConstant = await forecastFromConstants(brand.code, filters).catch((err) => {
    console.warn(`  [wh-constant] ${brand.code}: ${err.message}`)
    return new Map()
  })

  const keyOf = (r) => {
    const article = String(r['Item No.'] ?? '').trim()
    if (!article) return null
    return byDate ? `${article}|${String(r.Date ?? '').slice(0, 10)}` : article
  }

  /*
   * One row carries each figure, and the rest are blank.
   *
   * Consumption belongs to an article; these rows are split by recipe group as
   * well, so the same article appears several times. Writing it onto every one
   * would count it once per recipe the moment anybody totals the column, so it
   * goes on the largest by forecast and the others read as a dash.
   */
  const owner = new Map()
  for (const r of rows) {
    const k = keyOf(r)
    if (!k) continue
    const size = Number(r.Component_Forecast_Qty) || 0
    const held = owner.get(k)
    if (!held || size > held.size) owner.set(k, { row: r, size })
  }

  return rows.map((r) => {
    const k = keyOf(r)
    const isOwner = k && owner.get(k)?.row === r
    // All three of these belong to the article, so all three sit on the same
    // single row and are blank on the rest. Splitting them differently would
    // put an article's figures on two different lines.
    if (!isOwner) {
      /*
       * Two reasons a row is not the owner, and they are not the same.
       *
       * Usually it is another line of an article whose figure sits elsewhere.
       * But a PREP step has no article number at all — every one of the 941 of
       * them, because a kitchen step is not a thing the ERP stocks — so there
       * is nothing for the warehouse to be matched against, ever. Saying
       * "counted on another line" about a row that has no line to be counted on
       * is the wrong answer to the wrong question.
       */
      const noArticle = !String(r['Item No.'] ?? '').trim()
      return {
        ...r,
        Consumed_Qty: null,
        Live_Outbound_MTD: null,
        WH_Constant_Forecast_Qty: null,
        ...(noArticle ? { No_Article: true } : {}),
      }
    }

    // The article number, without the day, is what the warehouse knows.
    const article = String(r['Item No.'] ?? '').trim()
    /*
     * Live outbound to date.
     *
     * `mtd === undefined` means the window has already ended, and then this is
     * the same figure as Outbound beside it — the window and the window-to-date
     * are the same range — so the copy's answer is used and no query is made.
     * A Map means the window includes today and the warehouse was asked; null
     * means the window has not started.
     */
    const constant = byConstant.get(article) ?? null

    // Live outbound follows Outbound's rules, not its own. An article the
    // warehouse has never shipped is blank in both — reading "0" in one column
    // and "–" in the other says the warehouse shipped none of it, when the
    // truth is that it has no record of it at all.
    // Always the month to date, or nothing when it could not be asked for.
    const live = () => (mtd ? (mtd.get(article) ?? 0) : null)

    if (consumed.has(k)) {
      const qty = consumed.get(k)
      return {
        ...r,
        Consumed_Qty: qty,
        Live_Outbound_MTD: live(),
        WH_Constant_Forecast_Qty: constant,
      }
    }
    // No shipping history at all, so there is nothing to compare against.
    if (shipped && !shipped.has(article)) {
      const other = elsewhere.get(article)
      return {
        ...r,
        Consumed_Qty: null,
        Consumed_Unknown: true,
        // "The warehouse has none of this" and "the warehouse has plenty of
        // this and none of it comes here" are different answers, and the page
        // was giving the same dash to both.
        Consumed_Elsewhere: other
          ? { destination: other.top?.destination ?? null, qty: other.total }
          : null,
        Live_Outbound_MTD: null,
        WH_Constant_Forecast_Qty: constant,
      }
    }
    return {
      ...r,
      Consumed_Qty: 0,
      Live_Outbound_MTD: live(),
      WH_Constant_Forecast_Qty: constant,
    }
  })
}

/**
 * Live outbound for the current month, up to today, for every bucket.
 *
 * A fixed window, deliberately independent of the date slicer: the first of
 * this month to today, whatever the rest of the page is showing. Look at July
 * and this still answers for September, because the question it exists for is
 * "how much of what I am about to order has already gone out this month".
 *
 * It asks the same question as the copy — issued *from* the central warehouse,
 * to anywhere but itself — and buckets the answer the same way, so the articles
 * that only ever reach the central kitchen are here too. Asking only about the
 * brands, as this did at first, left MTD blank on exactly the rows the outbound
 * rule had just filled in.
 *
 * One query for every destination together, held for five minutes: live cannot
 * mean a fresh query per request, and a burst is what the capacity refuses.
 */
async function liveOutboundToDate(parts) {
  // Outbound names a destination, not a branch, so a branch filter gets nothing.
  if (parts.some((p) => p.f.locations?.length)) return null

  const codes = parts.map((p) => p.brand.code)
  const today = cube.todayFor(codes[0]) ?? new Date().toISOString().slice(0, 10)
  const from = `${today.slice(0, 7)}-01`

  return cached(
    `mtd:${from}:${today}`,
    async () => {
      const lines = await outboundFromWarehouse({ dateFrom: from, dateTo: today }).catch((err) => {
        console.warn(`  [warehouse] live outbound unavailable: ${err.message}`)
        return null
      })
      if (!lines) return null

      const out = new Map()
      for (const l of lines) {
        let byArticle = out.get(l.bucket)
        if (!byArticle) out.set(l.bucket, (byArticle = new Map()))
        byArticle.set(l.article, (byArticle.get(l.article) ?? 0) + l.qty)
      }
      return out
    },
    { seconds: 300 }
  )
}



/**
 * Brands added together, with consumption's blank kept blank.
 *
 * Consumption sits on one row per article and the rest of that article's rows
 * are blank; adding two brands that both carry the blank side of the same
 * component turned two "not known"s into a measured zero. `keepNull` stops that.
 * The unknown flag is then reconciled: if any brand did measure the article, the
 * merged row is measured whatever the others said.
 */
function merged(results) {
  const rows = mergeRows(results, {
    key: (r) => `${r['Recipe Group']}|${r.Item}|${r.BU}`,
    sum: [
      'Component_Forecast_Qty',
      'Component_Actual_Qty',
      'Consumed_Qty',
      'Live_Outbound_MTD',
      'WH_Constant_Forecast_Qty',
    ],
    keepNull: ['Consumed_Qty', 'Live_Outbound_MTD', 'WH_Constant_Forecast_Qty'],
    sort: (a, b) => Number(b.Component_Forecast_Qty) - Number(a.Component_Forecast_Qty),
  })
  for (const r of rows) {
    if (r.Consumed_Qty !== null && r.Consumed_Qty !== undefined) delete r.Consumed_Unknown
  }
  return rows
}

/**
 * The warehouse's issues that belong to no single brand, added to the page once.
 *
 * The central kitchen, the bakery, head office, R&D and FM are all real
 * consumers of real stock — 2,501,566 units in a month — but none of them is a
 * forecast brand, so there is nothing to attribute them to. Discarding them was
 * what left raw beef and sauce containers showing a requirement of thousands
 * against a blank: every unit of those articles leaves the warehouse for the
 * kitchen and never reaches a shop under its own code.
 *
 * Added after the brands are merged, and exactly once, because the figure is a
 * property of the article rather than of any brand — adding it inside the
 * per-brand fan-out would have multiplied it by however many brands were ticked.
 *
 * It lands on the row that already carries that article's figure, so the column
 * still totals correctly: one number per article, wherever that article sits.
 */
async function addWarehouseWide(rows, filters, grain, otherMtd = null) {
  if (grain.date || grain.location) return rows

  const other = await cube.outboundByArticle(OTHER_BUCKET, filters).catch(() => null)
  const otherForecast = await forecastFromConstants(OTHER_BUCKET, filters).catch(() => new Map())
  if (!other && !otherForecast.size && !otherMtd?.size) return rows

  // One row per article carries the figures: the one that already has them, or
  // failing that the largest by requirement.
  const owner = new Map()
  for (const r of rows) {
    const a = String(r['Item No.'] ?? '').trim()
    if (!a) continue
    const held = owner.get(a)
    const measured = r.Consumed_Qty !== null && r.Consumed_Qty !== undefined
    if (!held) {
      owner.set(a, r)
      continue
    }
    const heldMeasured = held.Consumed_Qty !== null && held.Consumed_Qty !== undefined
    if (measured && !heldMeasured) owner.set(a, r)
    else if (measured === heldMeasured &&
             (Number(r.Component_Forecast_Qty) || 0) > (Number(held.Component_Forecast_Qty) || 0)) {
      owner.set(a, r)
    }
  }

  for (const [article, row] of owner) {
    const extra = other?.get(article) ?? 0
    const extraForecast = otherForecast.get(article) ?? 0
    const extraMtd = otherMtd?.get(article) ?? 0
    if (!extra && !extraForecast && !extraMtd) continue

    if (extraMtd) {
      row.Live_Outbound_MTD = (Number(row.Live_Outbound_MTD) || 0) + extraMtd
    }

    if (extra) {
      row.Consumed_Qty = (Number(row.Consumed_Qty) || 0) + extra
      // It is measured now, so the blank and its explanation both go.
      delete row.Consumed_Unknown
      delete row.Consumed_Elsewhere
    }
    if (extraForecast) {
      row.WH_Constant_Forecast_Qty = (Number(row.WH_Constant_Forecast_Qty) || 0) + extraForecast
    }
  }

  /*
   * Articles the warehouse ships that reach no brand at all.
   *
   * 304 of them: raw materials that only ever go to the central kitchen, plus
   * everything issued to the bakery, head office and R&D. No recipe names them
   * and no brand receives them, so nothing put them on this page — and this is
   * the page somebody orders from, so leaving them off means they are ordered
   * from a spreadsheet or not at all.
   *
   * Forecast the same way as every other warehouse-only article: the six-month
   * average of outbound per unit sold, applied to the sales forecast for the
   * window on screen. Added once, after the brands are merged, and only when
   * they are not already on the page under a brand.
   */
  const names = await cube.articleMaster().catch(() => new Map())
  const already = new Set(
    rows.map((r) => String(r['Item No.'] ?? '').trim()).filter(Boolean)
  )

  for (const [article, forecast] of otherForecast) {
    if (already.has(article)) continue
    if (!Number.isFinite(forecast) || forecast <= 0) continue
    const known = names.get(article)
    rows.push({
      'Recipe Group': 'No recipe — from outbound',
      Item: known?.name || article,
      'Item No.': article,
      BU: known?.unit || '',
      'Node Type': 'RAW',
      // Same reasoning as the non-recipe rows: no recipe, so no demand figure.
      // The warehouse columns carry these articles.
      Component_Forecast_Qty: null,
      Component_Actual_Qty: null,
      Consumed_Qty: other?.get(article) ?? null,
      Live_Outbound_MTD: otherMtd?.get(article) ?? null,
      WH_Constant_Forecast_Qty: forecast,
    })
  }

  return rows
}

/**
 * Every row says where its stock comes from.
 *
 * An article the warehouse has not issued in six months is not a hole in the
 * data — it is a **direct supply** item, delivered straight to the CPU or to
 * the warehouse by its supplier without ever being issued out again. It has a
 * real requirement and somebody still has to order it; what it does not have is
 * a warehouse movement to measure against, which is why every measured column
 * beside it is blank.
 *
 * So the rows are labelled rather than dropped. An earlier version excluded
 * them, which lost the requirement along with the blanks.
 *
 * Judged on the outbound copy over six whole months, not on the window on
 * screen: an article delivered in May and not since is still warehouse-supplied
 * in September, and a window-based test would relabel it every month.
 */
const SUPPLY_WAREHOUSE = 'Warehouse'
const SUPPLY_DIRECT = 'Direct Supply'

async function withSupply(rows, filters) {
  const moved = await cube.articlesShippedSince(6).catch(() => null)

  const labelled = rows.map((r) => {
    const article = String(r['Item No.'] ?? '').trim()
    // No article number is no evidence either way — a kitchen step is neither.
    const supply = !article || !moved ? null : moved.has(article) ? SUPPLY_WAREHOUSE : SUPPLY_DIRECT
    return { ...r, Supply: supply }
  })

  const wanted = (filters?.supply ?? []).filter(Boolean)
  if (!wanted.length) return labelled
  const keep = new Set(wanted)

  /*
   * Warehouse supply means raw materials.
   *
   * Prep steps and the items a kitchen produces are made where they are used —
   * a warehouse does not issue "Brined Chicken Breast", it issues the chicken.
   * A row of either kind carrying a Warehouse label is the six-month lookup
   * matching an article number that also happens to appear in a recipe as a
   * produced item, not a statement that the warehouse ships it.
   *
   * So asking for Warehouse supply narrows to RAW as well. Asked for on 6 Sep
   * 2026, and it only applies to the Warehouse side: picking Direct Supply, or
   * both, leaves production type alone, because a direct-supplied prep item is
   * a real thing and hiding it would answer a question nobody asked.
   */
  const rawOnly = keep.has(SUPPLY_WAREHOUSE) && !keep.has(SUPPLY_DIRECT)

  return labelled.filter((r) => {
    if (!r.Supply || !keep.has(r.Supply)) return false
    if (rawOnly && String(r['Node Type'] ?? '') !== 'RAW') return false
    return true
  })
}

/**
 * Rows a recipe asks for, rows only the warehouse ships, or both.
 *
 * Decided by the recipe group the row arrived with — the non-recipe rows are
 * stamped "No recipe — from outbound" when they are built, so this is reading
 * the answer rather than working it out a second way. The page's Recipe column
 * makes the same test, which is why it has to stay one test.
 */
const RECIPE_KIND = (r) =>
  String(r['Recipe Group'] ?? '').startsWith('No recipe') ? 'Non-recipe' : 'Recipe'

/**
 * Each row's article status, and the slicer that filters on it.
 *
 * The same ladder the forecast routes on — Active through To Be Deactivated —
 * so a reader who filters to Non-Moving sees exactly the articles the forecast
 * decided not to forecast, rather than a second definition that happens to
 * agree most of the time.
 *
 * Cut to the end of the window on screen, like everywhere else this status is
 * used: looking at March must show what was true in March.
 */
async function withStatus(rows, filters) {
  const asAt = filters?.dateTo || new Date().toISOString().slice(0, 10)
  const classes = await classifyArticles({ asAt }).catch(() => new Map())

  const labelled = rows.map((r) => {
    const article = String(r['Item No.'] ?? '').trim()
    // A kitchen step has no article number, so there is nothing to classify.
    if (!article) return { ...r, Status: null, Days_Idle: null }
    const c = classes.get(article) ?? classifyOne(null, asAt)
    return {
      ...r,
      Status: statusOf(c.status)?.label ?? null,
      Days_Idle: c.daysIdle,
    }
  })

  const wanted = (filters?.statuses ?? []).filter(Boolean)
  if (!wanted.length) return labelled
  const keep = new Set(wanted)
  return labelled.filter((r) => r.Status && keep.has(r.Status))
}

/**
 * What the shops are holding, and what the next shipment ought to be.
 *
 * Added beside the warehouse columns rather than folded into them: the forecast
 * says what the shops will need, this says what they already have, and the two
 * are different questions that a single number cannot answer. Nothing here
 * changes WH forecast — see the note at the top of `insights/storeStock.js` for
 * the backtest that settled that.
 *
 * Silent under the same filters that blank the warehouse forecast. Stock can be
 * read per shop, but the forecast beside it cannot be split that way, so a
 * branch-filtered cover figure would divide this branch's stock by every
 * branch's demand.
 */
async function withStoreStock(rows, filters, buckets, grain, admin) {
  /*
   * Withheld rather than hidden.
   *
   * These columns are for the people who maintain the numbers: store stock is
   * still settling — negative book balances, and a posting gap that has been
   * inflating September — and a replenishment quantity read as an instruction
   * by somebody who has not been told its limits does real harm. So the fields
   * are never put in the response at all. Dropping them in the browser would
   * leave them one network tab away.
   */
  if (!admin) return rows
  if (grain.date || grain.location) return rows
  if (filters?.locations?.length || filters?.products?.length || filters?.articles?.length) return rows

  const held = await storeStock({
    dateFrom: filters?.dateFrom,
    dateTo: filters?.dateTo,
    buckets,
  }).catch((err) => {
    console.warn(`  [store-stock] ${err.message.slice(0, 90)}`)
    return null
  })
  // No inventory model, or nothing to read: the columns stay off rather than
  // filling the page with dashes that look like a fault.
  if (!held) return rows

  return rows.map((r) => {
    const article = String(r['Item No.'] ?? '').trim()
    /*
     * Only the row that already carries this article's warehouse figures.
     *
     * Outbound and WH forecast sit on one row per article and are blank on the
     * rest; stock belongs to the article in exactly the same way, so it goes on
     * the same line. Spread across every recipe line it would be counted once
     * per recipe by any total.
     */
    const carries =
      (r.Consumed_Qty !== null && r.Consumed_Qty !== undefined) ||
      (r.WH_Constant_Forecast_Qty !== null && r.WH_Constant_Forecast_Qty !== undefined)
    if (!article || !carries) return r
    return { ...r, ...stockColumnsFor(article, r.WH_Constant_Forecast_Qty, held) }
  })
}

function withRecipeKind(rows, filters) {
  const wanted = (filters?.recipeKinds ?? []).filter(Boolean)
  if (!wanted.length) return rows
  const keep = new Set(wanted)
  return rows.filter((r) => keep.has(RECIPE_KIND(r)))
}

/**
 * The warehouse forecast and what actually left, day by day.
 *
 * Composed from the same two calculations the Stock Article page uses, at a
 * finer grain — not a second definition of either:
 *
 *   Outbound  `cube_outbound_daily`, the copy the extract fills from
 *             `fact_outbound_line` where the source is the Central Warehouse
 *             and the destination is anything but. Totalled per day here
 *             instead of per article, because a trend needs thirty numbers and
 *             not a hundred thousand.
 *
 *   Forecast  `forecastFromConstants`, unchanged — the six-month rate times the
 *             sales forecast for the window. The rate is a constant, so the
 *             window total decomposes exactly: a day takes its share of the
 *             sales forecast, and the days sum back to the window figure the
 *             cards and the table show. Nothing here can drift from them
 *             without the window total drifting too.
 *
 * Aggregated on the server on purpose. The browser gets one row per day.
 */
/**
 * Why the warehouse forecast misses, for whoever has to improve it.
 *
 * Administrators only: it is a diagnosis of the method rather than a figure to
 * order from, and every row on it is an argument about a calculation.
 */
/**
 * Warehouse stock against what left it, week by week.
 *
 * Not admin-only: it answers an operational question — is the warehouse holding
 * enough — rather than diagnosing the forecast, so it belongs to whoever can
 * see the warehouse pages at all.
 */
api.all('/soh-trend', handle(async (req, res) => {
  if (pageDenied(req, res, 'warehouse')) return
  const g = guardMany(req, res)
  if (!g) return
  const f = g.parts[0]?.f ?? {}
  res.json((await sohTrend({ dateFrom: f.dateFrom, dateTo: f.dateTo })) ?? { weeks: [], unavailable: true })
}))

/**
 * Sales value by month, and the pace the current month is running at.
 *
 * On the warehouse pages because it is the warehouse forecast's denominator —
 * every WH figure is the constant times this number.
 */
api.all('/sales-runrate', handle(async (req, res) => {
  if (pageDenied(req, res, 'warehouse')) return
  const g = guardMany(req, res)
  if (!g) return
  const f = g.parts[0]?.f ?? {}
  res.json(await salesRunRate({ dateTo: f.dateTo }))
}))

api.all('/warehouse-diagnostics', handle(async (req, res) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'This analysis is available to administrators.' })
    return
  }
  const g = guardMany(req, res)
  if (!g) return
  res.json(await warehouseDiagnostics(g.parts))
}))


api.all('/warehouse-trend', handle(async (req, res) => {
  // The rail hides the tab; this refuses the request, which is what a bookmark
  // or a typed URL actually reaches.
  if (pageDenied(req, res, 'warehouse')) return
  const g = guardMany(req, res)
  if (!g) return

  /*
   * Supply reaches this query as a list of articles.
   *
   * It is not a column in the outbound copy — it is decided by whether the
   * warehouse has issued the article in the last six months, which is the same
   * rule `withSupply` applies to the table. Read from the same place, so the
   * two can never disagree about what "Warehouse" means.
   */
  const wanted = new Set((g.parts[0]?.f?.supply ?? []).filter(Boolean))
  let onlyArticles = null
  if (wanted.size === 1) {
    const moved = await cube.articlesShippedSince(6).catch(() => null)
    if (moved) {
      if (wanted.has(SUPPLY_WAREHOUSE)) onlyArticles = moved
      // Direct supply has no warehouse outbound by definition — that is what
      // makes it direct. An empty set is the honest answer, not a missing one.
      else onlyArticles = new Set()
    }
  }

  const parts = await g.fanOut(async ({ f, brand }) => {
    const allBrands = false
    const [outbound, salesByDay, whForecast] = await Promise.all([
      cube.outboundByDay(brand.code, f, onlyArticles).catch(() => null),
      cube.forecastSalesByDay(brand.code, f, { allBrands }).catch(() => new Map()),
      forecastFromConstants(brand.code, f).catch(() => new Map()),
    ])

    // The window total, from the same map the cards and the table are built
    // from, narrowed by supply the same way.
    let total = 0
    for (const [article, qty] of whForecast) {
      if (onlyArticles && !onlyArticles.has(article)) continue
      total += Number(qty) || 0
    }

    let salesTotal = 0
    for (const v of salesByDay.values()) salesTotal += v

    return { outbound, salesByDay, total, salesTotal }
  })

  const days = new Map()
  const at = (d) => {
    let held = days.get(d)
    if (!held) days.set(d, (held = { Date: d, WH_Forecast: 0, Outbound: 0, measured: false }))
    return held
  }

  for (const p of parts) {
    for (const [d, qty] of p.outbound ?? []) {
      const row = at(d)
      row.Outbound += qty
      row.measured = true
    }
    if (p.salesTotal > 0 && p.total > 0) {
      for (const [d, sales] of p.salesByDay) {
        at(d).WH_Forecast += p.total * (sales / p.salesTotal)
      }
    }
  }

  const rows = [...days.values()].sort((a, b) => a.Date.localeCompare(b.Date))
  for (const r of rows) {
    /*
     * Scored exactly as the table scores an article: symmetric, against the
     * larger of the two, and blank rather than zero when there is nothing to
     * compare. A day the warehouse issued nothing and forecast nothing is not
     * a day it got wrong.
     */
    /*
     * The same formula the column uses:
     *   1 − |Forecast − Actual| / MAX(Forecast, Actual)
     * so a day on the trend and an article in the table are scored alike.
     */
    const bigger = Math.max(r.Outbound, r.WH_Forecast)
    r.WH_Accuracy = r.measured && bigger > 0 ? 1 - Math.abs(r.WH_Forecast - r.Outbound) / bigger : null
  }

  res.json({ rows })
}))


/**
 * Total sales per day, forecast against actual, across the brands in scope.
 *
 * Sales accuracy is a property of the day, not of the article: the same trading
 * day either went the way it was forecast or it did not, and every article sold
 * on it inherits that one answer. Measuring it per component instead — which is
 * what the recipe explosion gives you — only ever restates the same figure
 * multiplied by a recipe quantity, which cancels.
 *
 * Read from `cube.trend`, the reader the Overview page already draws its daily
 * chart from, so this page and that chart cannot disagree about what a day's
 * sales were. Brands are added together, because the reader has chosen them.
 */
async function salesByDay(parts) {
  /*
   * One brand at a time.
   *
   * These are local reads against a single-connection engine, so asking for
   * nine at once buys nothing and was one of the paths handing the engine
   * overlapping statements. Sequential is the same total work.
   */
  const series = []
  for (const p of parts) {
    series.push(await cube.trend(p.brand.code, p.f).catch(() => null))
  }

  const byDate = new Map()
  let actual = 0
  let forecast = 0
  for (const list of series) {
    for (const r of list ?? []) {
      const d = String(r.Date ?? '').slice(0, 10)
      if (!d) continue
      const a = Number(r.Actual_Qty) || 0
      const f = Number(r.Forecast_Qty) || 0
      const held = byDate.get(d) ?? { actual: 0, forecast: 0 }
      held.actual += a
      held.forecast += f
      byDate.set(d, held)
      actual += a
      forecast += f
    }
  }

  return {
    byDate: Object.fromEntries(byDate),
    total: { actual, forecast },
  }
}


/**
 * Which menu items use an article, and how much of it each one takes.
 *
 * Read straight from 'RECIPE TABLE' — the same table the component forecast is
 * exploded from, so the quantities here are the quantities behind Forecast qty
 * rather than a second opinion about the recipe.
 *
 * `QTY BU` is per one unit of the finished product: a burger taking 0.00018 kg
 * of parsley is one row. `Recipe Path` says how it gets there, which matters
 * because most articles arrive through a sub-recipe rather than directly — the
 * parsley is in the ranch sauce, and the ranch sauce is in the burger.
 *
 * Matched on article number where there is one, and on the item name where
 * there is not: every PREP step has a blank `Item No.`, and those are exactly
 * the rows somebody is most likely to be asking this question about.
 */
api.all('/article-usage', handle(async (req, res) => {
  if (pageDenied(req, res, 'component')) return
  const g = guardMany(req, res)
  if (!g) return

  const src = req.method === 'POST' ? req.body || {} : req.query || {}
  const articleNo = String(src.articleNo ?? '').trim()
  const item = String(src.item ?? '').trim()
  if (!articleNo && !item) {
    res.status(400).json({ error: 'An article number or an item name is required.' })
    return
  }

  const column = articleNo ? "'RECIPE TABLE'[Item No.]" : "'RECIPE TABLE'[Item]"
  const value = (articleNo || item).replace(/"/g, '""')

  /*
   * One query per dataset, not one per brand.
   *
   * Two pairs of brands share a model — SLC with BUR, MM with TBL — and
   * 'RECIPE TABLE' has no brand column, so the recipe rows in a shared model
   * belong to both of the brands it covers. Fanning out per brand asked the
   * same model the same question twice and, because the cache is keyed on the
   * dataset, handed back the same rows both times. Merged on a key that
   * included the brand, the two identical answers landed on one line and their
   * quantities were added: "2 filaaa on toast + 2 Fries" reported 4 Kids Fries
   * Sleeves per unit where the recipe says 2, and the second brand vanished.
   *
   * Asking each model once removes both faults. The row is labelled with every
   * brand that model covers, which is what the recipe actually applies to.
   */
  const byDataset = new Map()
  for (const p of g.parts) {
    if (!byDataset.has(p.ds)) byDataset.set(p.ds, { codes: [], chains: new Set() })
    const held = byDataset.get(p.ds)
    held.codes.push(p.brand.code)
    // A model can hold two brands, and CHAINID is what separates them inside it.
    for (const c of p.f.brands?.length ? p.f.brands : [p.brand.chainId ?? p.brand.code]) {
      if (c) held.chains.add(String(c))
    }
  }

  const parts = await Promise.all(
    [...byDataset.entries()].map(([ds, { codes, chains }]) => {
      const scope = [...chains].sort()
      const plu = scope.length
        ? `TREATAS({${scope.map((c) => `"${c}"`).join(', ')}}, Forecast_Product_Table[CHAINID])`
        : ''

      /*
       * Scoped to the products this brand actually sells.
       *
       * 'RECIPE TABLE' is a company-wide master and the same 245,874 rows are
       * loaded into every model — it has no brand column at all. Read on its
       * own it says every brand makes every product, which is how "9 Arayes &
       * Wraps Combo" came back under BBT, CHP, PAT and SS when it belongs to
       * Shawarma Station alone.
       *
       * Forecast_Product_Table is the brand-scoped side, and its Clean_ItemID
       * is the recipe's Product PLU. Narrowing the recipe rows to the PLUs that
       * table holds for the selected brands is the same join the
       * [Component_Forecast_Qty] measure makes internally, and the same one the
       * recipe slicers already use — so this answer and the Forecast qty column
       * are now scoped identically.
       */
      const dax = `EVALUATE
VAR PLUs =
  CALCULATETABLE(
    VALUES(Forecast_Product_Table[Clean_ItemID])${plu ? `,
    ${plu}` : ''}
  )
RETURN
SUMMARIZECOLUMNS(
  'RECIPE TABLE'[Product Name],
  'RECIPE TABLE'[Product PLU],
  'RECIPE TABLE'[Recipe],
  'RECIPE TABLE'[Recipe Path],
  'RECIPE TABLE'[Node Type],
  'RECIPE TABLE'[BU],
  TREATAS({"${value}"}, ${column}),
  FILTER(ALL('RECIPE TABLE'[Product PLU]), 'RECIPE TABLE'[Product PLU] IN PLUs),
  "Qty_Per_Unit", SUM('RECIPE TABLE'[QTY BU])
)`

      return cached(`${ds}:usage:${column}:${value}:${scope.join(',')}`, () =>
        // Raw rows in the cache, so nothing stored carries one caller's label.
        executeQuery(dax, ds, { bulk: true })
      )
        .then((rows) => rows.map((r) => ({ ...r, CHAINID: codes.join(' / ') })))
        .catch((err) => {
          console.warn(`  [usage] ${codes.join('/')}: ${err.message}`)
          return []
        })
    })
  )

  /*
   * One line per menu item, per model.
   *
   * The same product can reach an article down more than one path — through a
   * sauce and again directly — and those are genuinely separate requirements,
   * so they are added rather than deduplicated. What must not be added is the
   * same path counted twice, which is what the per-brand fan-out was doing.
   */
  const out = new Map()
  for (const r of parts.flat()) {
    const key = `${r.CHAINID}|${r['Product PLU'] ?? ''}|${r['Product Name'] ?? ''}`
    const held = out.get(key)
    const qty = Number(r.Qty_Per_Unit) || 0
    if (!held) {
      out.set(key, {
        CHAINID: r.CHAINID,
        Product: r['Product Name'] ?? '',
        PLU: r['Product PLU'] ?? '',
        Qty_Per_Unit: qty,
        BU: r.BU ?? '',
        Paths: r['Recipe Path'] ? [r['Recipe Path']] : [],
      })
      continue
    }
    held.Qty_Per_Unit += qty
    if (r['Recipe Path'] && !held.Paths.includes(r['Recipe Path'])) held.Paths.push(r['Recipe Path'])
  }

  const rows = [...out.values()]
    .filter((r) => r.Qty_Per_Unit > 0)
    .sort((a, b) => b.Qty_Per_Unit - a.Qty_Per_Unit)

  res.json({ rows })
}))


api.all('/component-level', handle(async (req, res) => {
  if (pageDenied(req, res, 'component')) return
  const g = guardMany(req, res)
  if (!g) return
  const grain = grainOf(req)

  // Once, for every brand, before the fan-out — not once per brand inside it.
  const mtdAll = grain.date ? null : await liveOutboundToDate(g.parts)

  const results = await g.fanOut(async ({ ds, f, brand }) => {
    const rows = await data.componentLevel(f, ds, grain)

    /*
     * The items no recipe covers, appended.
     *
     * Gloves and packaging are as much a warehouse requirement as flour, and
     * leaving them off this page meant the one list somebody orders from was
     * missing a third of what they order. They arrive already forecast, from
     * the constant measured against last month's outbound.
     *
     * Not when the table is split by day or branch: the constant is a monthly
     * figure per brand, and cutting it finer would be inventing a shape it
     * does not have.
     */
    /*
     * Cached like everything else on this page.
     *
     * This was the one call on the route that went straight to its source on
     * every request, so the Ingredients page could never be fully warm however
     * often it was loaded. Keyed on the brand and the window, which is all it
     * depends on.
     */
    const extra =
      grain.date || grain.location || f.items?.length || f.recipeGroups?.length
        ? []
        : await cached(
            `${ds}:nonRecipe:${f.dateFrom}:${f.dateTo}`,
            () => nonRecipeRows(brand, f)
          ).catch((err) => {
            console.warn(`  [non-recipe] ${brand.code}: ${err.message}`)
            return []
          })

    const mine = mtdAll?.get(brand.code) ?? null
    const withOutbound = await withConsumption([...rows, ...extra], brand, f, grain, mine)
    // Only stamped when the table is actually split by brand: carrying it
    // otherwise would make every row look brand-specific after the merge.
    return grain.brand ? withOutbound.map((r) => ({ ...r, CHAINID: brand.code })) : withOutbound
  })
  const window = g.parts[0].f
  // One local query per brand, and the answer is a few dozen numbers.
  const sales = await salesByDay(g.parts)

  // The shops whose stock counts: the brands on screen, plus the kitchens and
  // bakery the page already adds under the catch-all.
  const buckets = [...g.parts.map((p) => p.brand.code), OTHER_BUCKET]

  if (g.single)
    return res.json({
      sales,
      rows: withRecipeKind(
        await withStoreStock(
          await withStatus(
            await withSupply(
              await addWarehouseWide(results[0], window, grain, mtdAll?.get(OTHER_BUCKET)),
              window
            ),
            window
          ),
          window,
          buckets,
          grain,
          req.user?.role === 'admin'
        ),
        window
      ),
    })

  // Components are shared recipes, so the same item in two brands is genuinely
  // the same thing to order — these do add up.
  res.json({
    sales,
    rows: withRecipeKind(
      await withStoreStock(
        await withStatus(
          await withSupply(
            await addWarehouseWide(
              // Split by brand, the brands are the answer, so they are not added up.
              grain.brand ? results.flat() : merged(results),
              window,
              grain,
              mtdAll?.get(OTHER_BUCKET)
            ),
            window
          ),
          window
        ),
        window,
        buckets,
        grain,
        req.user?.role === 'admin'
      ),
      window
    ),
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
  if (pageDenied(req, res, 'production')) return
  const g = guardMany(req, res)
  if (!g) return

  const results = await g.fanOut(({ ds, f }) => data.productionPlanKpis(f, ds))
  res.json({ kpis: mergePlanKpis(results) })
}))

api.all('/production-plan', handle(async (req, res) => {
  if (pageDenied(req, res, 'production')) return
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
  if (pageDenied(req, res, 'summary')) return
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
api.get('/cube', requireRole('admin'), handle(async (req, res) => res.json(await cubeState())))
