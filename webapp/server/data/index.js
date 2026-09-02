import { config } from '../config.js'
import { cached } from '../cache.js'
import * as cube from '../cube/query.js'
import { deriveKpis } from './merge.js'
import { raise } from '../insights/alerts.js'
import { demoProvider } from './demo.js'
import { liveProvider } from './live.js'

const provider = config.demoMode ? demoProvider : liveProvider

/** Stable cache key: same filters in any key order produce the same string. */
function keyOf(name, filters, extra) {
  const normalized = Object.keys(filters || {})
    .sort()
    .reduce((acc, k) => {
      const v = filters[k]
      if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return acc
      acc[k] = Array.isArray(v) ? [...v].map(String).sort() : v
      return acc
    }, {})
  return `${name}:${JSON.stringify(normalized)}${extra === undefined ? '' : ':' + extra}`
}

/** Part of the cache key: two grains are two different answers. */
const grainKey = (g = {}) => `${g.date ? 'd' : ''}${g.location ? 'l' : ''}` || 'flat'

/**
 * The finest grain, asked for a week at a time.
 *
 * Splitting a month of articles by both branch and day produces around ninety
 * thousand rows for one brand, and Power BI does not return that in one piece:
 * it answers 200 with roughly half the rows and no indication that anything is
 * missing. A month came back reading 1,133,418 units against a true 1,228,977.
 *
 * So the window is cut into weeks, each asked for separately and concatenated.
 * The pieces cover disjoint dates, so no row can appear twice, and each one is
 * small enough to come back whole — the four weekly answers summed to exactly
 * the figure the KPI measure reports.
 */
const CHUNK_DAYS = Number(process.env.PBI_GRAIN_CHUNK_DAYS) || 7

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function dateChunks(from, to) {
  const out = []
  for (let start = from; start <= to; start = addDays(start, CHUNK_DAYS)) {
    const end = addDays(start, CHUNK_DAYS - 1)
    out.push({ dateFrom: start, dateTo: end > to ? to : end })
  }
  return out
}

/**
 * Run one query per week and join the answers.
 *
 * Sequential on purpose: these are the heaviest queries the app makes, and
 * firing five of them at once is how the capacity starts answering 429.
 */
async function inChunks(f, run) {
  if (!f.dateFrom || !f.dateTo) return run(f)
  const spans = dateChunks(f.dateFrom, f.dateTo)
  if (spans.length < 2) return run(f)

  const rows = []
  for (const span of spans) rows.push(...(await run({ ...f, ...span })))
  return rows
}

/**
 * Read from the copy, and fall back to Power BI if that goes wrong.
 *
 * The copy is an optimisation. Power BI is still there, still correct, and
 * still the thing the copy is a copy of — so a fault on the fast path has an
 * obvious right answer: take the slow one. What must never happen is the page
 * showing a database error to somebody who asked for last month's sales.
 *
 * This is not theoretical. Three list functions mapped over a promise without
 * awaiting it, which threw on every call; it stayed invisible for as long as
 * the copy was empty, because nothing reached that code. The first deployment
 * where the copy actually filled put "rowsOf(...).map is not a function" on the
 * Overview instead of the figures.
 *
 * The fault is logged and raised as an alert so it gets fixed rather than
 * quietly absorbed for ever — degrading silently is how a copy ends up broken
 * for a month and nobody knowing.
 */
async function fromCopyOrLive(what, fromCopy, fromLive) {
  try {
    return await fromCopy()
  } catch (err) {
    console.error(`  [cube] ${what} failed, falling back to Power BI:`, err.message)
    raise({
      source: 'app',
      key: `cube:${what}`,
      severity: 'warning',
      title: `The local copy could not answer ${what}`,
      detail: `${err.message}\n\nThe page was served from Power BI instead, so the figures are right but slower.`,
    })
    return fromLive()
  }
}

/** Every result is cached per dataset, so brands never share a cache entry. */
const call = (name, f, ds, run, extra) => cached(`${ds || 'demo'}:${keyOf(name, f, extra)}`, run)

export const data = {
  mode: config.demoMode ? 'demo' : 'powerbi',

  // `need` is part of the cache key: a page asking for four lists must not be
  // served — or serve — a cached entry that only ever fetched two.
  /*
   * Whatever the local copy can answer comes from there; the rest goes live.
   *
   * Opening a slicer with nine brands selected cost one query per list per
   * brand — fifty-four of them, about four and a half seconds. Locations,
   * products and article codes are columns the copy already holds, so those are
   * read locally and only the recipe-side lists are still asked for. The
   * provider is always called: it carries the calendar, and that is one cheap
   * row per brand rather than a list scan.
   */
  slicers: (f, ds, need = null) =>
    call(
      'slicers',
      f,
      ds,
      async () => {
        // An empty object is the honest fallback here: whatever the copy could
        // not supply is fetched from the model below, which is what happens for
        // a brand it has never covered.
        const local = need
          ? await fromCopyOrLive('slicerLists', () => cube.listsFor(f.brand, f, need), () => ({}))
          : {}
        const keys = Object.keys(local)
        const rest = need ? need.filter((k) => !keys.includes(k)) : need
        // The calendar too, when the copy has it. It is four dates that change
        // once a day, and asking nine models for them was six seconds of every
        // cold load — the single biggest live cost left on a page.
        const calendar = cube.dateRangeFor(f.brand)
        const live = await provider.slicers(f, ds, rest, { dateRange: calendar })
        // Local values win where present; everything else is as the model gave it.
        return { ...live, ...local }
      },
      need ? [...need].sort().join(',') : 'all'
    ),
  // Derived from the copy the same way /summary derives them, so the two pages
  // cannot show different totals for the same window.
  /*
   * `live` refuses the local copy for this one call.
   *
   * The copy is refreshed hourly, so it can be an hour behind the model — fine
   * for a page, wrong for the morning digest, which states the day it measured.
   * That day was read live from the model while the figures came from a copy
   * that had not caught up: the digest built at 05:55 said 24 August above
   * figures for the 23rd, because the extract landed at 06:33.
   */
  kpis: (f, ds, { live = false } = {}) =>
    call('kpis', f, ds, async () => {
      if (live || !cube.canAnswer(f.brand, f)) return provider.kpis(f, ds)
      return fromCopyOrLive(
        'kpis',
        async () => {
          const rows = await cube.trend(f.brand, f)
          const total = (k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0)
          return deriveKpis(total('Actual_Qty'), total('Forecast_Qty'))
        },
        () => provider.kpis(f, ds)
      )
    }, live ? 'live' : undefined),

  /*
   * The three Overview queries prefer the local copy.
   *
   * cube.canAnswer refuses whenever it cannot answer truthfully — a filter it
   * has no column for, or a window reaching past what has been extracted — and
   * the request goes to Power BI as before. Wrong numbers served quickly would
   * be far worse than right numbers served slowly, so the check is deliberately
   * pessimistic.
   *
   * Still cached. A local aggregate is milliseconds for one brand, but the
   * unfiltered view of nine brands groups close to a million rows and then
   * merges fifteen hundred products, which measured at 1.1s — worth keeping.
   * The extract clears the cache when it changes anything, so the two cannot
   * drift apart.
   */
  trend: (f, ds, { live = false } = {}) =>
    call(
      'trend',
      f,
      ds,
      () =>
        !live && cube.canAnswer(f.brand, f)
          ? fromCopyOrLive('trend', () => cube.trend(f.brand, f), () => provider.trend(f, ds))
          : provider.trend(f, ds),
      live ? 'live' : undefined
    ),

  topProducts: (f, top, ds) =>
    call(
      'topProducts',
      f,
      ds,
      () =>
        cube.canAnswer(f.brand, f)
          ? fromCopyOrLive(
              'topProducts',
              () => cube.topProducts(f.brand, f, top),
              () => provider.topProducts(f, top, ds)
            )
          : provider.topProducts(f, top, ds),
      top
    ),

  byLocation: (f, ds) =>
    call('byLocation', f, ds, () =>
      cube.canAnswer(f.brand, f)
        ? fromCopyOrLive('byLocation', () => cube.byLocation(f.brand, f), () => provider.byLocation(f, ds))
        : provider.byLocation(f, ds)
    ),
  /*
   * The Products page reads the article-grain copy when it can.
   *
   * It cannot when a branch filter is applied — that table has no branch
   * column, because keeping one would have made it four hundred thousand rows
   * per brand instead of thirty-seven thousand. Those requests go to Power BI,
   * which is the honest answer rather than a fast wrong one.
   */
  /*
   * `grain` splits rows by date or branch when the reader asks for it.
   *
   * The local copy cannot serve those: it holds article rows without a branch
   * column and summed across dates. So any request for a finer grain goes to
   * Power BI, and the grain is part of the cache key — otherwise a request for
   * the split view would be answered from the summed one.
   */
  productLevel: (f, ds, grain = {}) =>
    call(
      'productLevel',
      f,
      ds,
      () =>
        !grain.date && !grain.location && cube.canAnswerArticles(f.brand, f)
          ? fromCopyOrLive(
              'productLevel',
              () => cube.productLevel(f.brand, f),
              () => provider.productLevel(f, ds, grain)
            )
          : grain.date && grain.location
            ? inChunks(f, (win) => provider.productLevel(win, ds, grain))
            : provider.productLevel(f, ds, grain),
      grainKey(grain)
    ),
  componentLevel: (f, ds, grain = {}) =>
    call(
      'componentLevel',
      f,
      ds,
      () =>
        // Splitting by branch is the one thing the recipe copy cannot do — it
        // has no branch column — so that still goes live.
        !grain.location && cube.canAnswerComponents(f.brand, f)
          ? fromCopyOrLive(
              'componentLevel',
              () => cube.componentLevel(f.brand, f, grain),
              () => provider.componentLevel(f, ds, grain)
            )
          : grain.date && grain.location
            ? inChunks(f, (win) => provider.componentLevel(win, ds, grain))
            : provider.componentLevel(f, ds, grain),
      grainKey(grain)
    ),
  /*
   * The plan is copied whole and filtered locally.
   *
   * These two were the last queries on any page that always went live: 3.4s and
   * 1.7s for nine brands, on a page opened first thing every morning and a card
   * that sits on the Overview. What the copy holds is Power BI's own answer,
   * refreshed hourly, so the figures are the model's — only the waiting is gone.
   */
  productionPlan: (f, ds) =>
    call('productionPlan', f, ds, async () => {
      const local = await fromCopyOrLive('productionPlan', () => cube.planFor(f.brand, f), () => null)
      return local ?? provider.productionPlan(f, ds)
    }),
  productionPlanKpis: (f, ds) =>
    call('productionPlanKpis', f, ds, async () => {
      // Only when nothing is filtered: the stored measures are the brand's
      // totals, and a branch-filtered card has to be recomputed by the model.
      const plain = !f.locations?.length && !f.products?.length && !f.articles?.length
      const local = plain
        ? await fromCopyOrLive('productionPlanKpis', () => cube.planKpisFor(f.brand), () => null)
        : null
      return local ?? provider.productionPlanKpis(f, ds)
    }),
}
