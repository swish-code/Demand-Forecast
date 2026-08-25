import { config } from '../config.js'
import { cached } from '../cache.js'
import * as cube from '../cube/query.js'
import { deriveKpis } from './merge.js'
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

/** Every result is cached per dataset, so brands never share a cache entry. */
const call = (name, f, ds, run, extra) => cached(`${ds || 'demo'}:${keyOf(name, f, extra)}`, run)

export const data = {
  mode: config.demoMode ? 'demo' : 'powerbi',

  // `need` is part of the cache key: a page asking for four lists must not be
  // served — or serve — a cached entry that only ever fetched two.
  slicers: (f, ds, need = null) =>
    call('slicers', f, ds, () => provider.slicers(f, ds, need), need ? [...need].sort().join(',') : 'all'),
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
    call('kpis', f, ds, () => {
      if (live || !cube.canAnswer(f.brand, f)) return provider.kpis(f, ds)
      const rows = cube.trend(f.brand, f)
      const total = (k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0)
      return deriveKpis(total('Actual_Qty'), total('Forecast_Qty'))
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
      () => (!live && cube.canAnswer(f.brand, f) ? cube.trend(f.brand, f) : provider.trend(f, ds)),
      live ? 'live' : undefined
    ),

  topProducts: (f, top, ds) =>
    call(
      'topProducts',
      f,
      ds,
      () =>
        cube.canAnswer(f.brand, f)
          ? cube.topProducts(f.brand, f, top)
          : provider.topProducts(f, top, ds),
      top
    ),

  byLocation: (f, ds) =>
    call('byLocation', f, ds, () =>
      cube.canAnswer(f.brand, f) ? cube.byLocation(f.brand, f) : provider.byLocation(f, ds)
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
          ? cube.productLevel(f.brand, f)
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
        grain.date && grain.location
          ? inChunks(f, (win) => provider.componentLevel(win, ds, grain))
          : provider.componentLevel(f, ds, grain),
      grainKey(grain)
    ),
  productionPlan: (f, ds) => call('productionPlan', f, ds, () => provider.productionPlan(f, ds)),
  productionPlanKpis: (f, ds) => call('productionPlanKpis', f, ds, () => provider.productionPlanKpis(f, ds)),
}
