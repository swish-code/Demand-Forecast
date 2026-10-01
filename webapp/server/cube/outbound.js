import { pg } from '../db/accounts.js'
import { config } from '../config.js'
import {
  articleNames,
  outboundByDestination,
  outboundFromWarehouse,
  forgetWarehouseSourced,
  OTHER_BUCKET,
} from '../powerbi/warehouse.js'
import { siteOutboundByMonth } from '../powerbi/siteOutbound.js'
import { forgetShipped, forgetElsewhere, forgetMaster, forgetShipHistory } from './query.js'
import { forgetConstants } from '../insights/whConstant.js'

/**
 * Keeping the outbound figures locally, for the same reason as everything else.
 *
 * The Ingredients page read Warehouse Analytics directly, one query per brand.
 * Nine brands meant nine at once, which is precisely the burst that capacity
 * answers with 429 and a sixty-second Retry-After — measured at 62 seconds for
 * a page that should take half of one.
 *
 * Copied by article and day. The destination is dropped: nothing can use it
 * until outbound's branch names are reconciled with the forecast's codes, and
 * carrying a column nobody can read costs rows for nothing.
 */

const BATCH = 500
const iso = (d) => d.toISOString().slice(0, 10)
const addDays = (v, n) => {
  const d = new Date(`${v}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return iso(d)
}

async function insertRows(table, columns, conflict, rows, toValues) {
  const marks = `(${columns.map(() => '?').join(', ')})`
  const updates = columns
    .filter((c) => !conflict.includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const args = []
    for (const r of slice) args.push(...toValues(r))
    await pg.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${slice.map(() => marks).join(', ')}
       ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${updates}`,
      args
    )
  }
}

/**
 * One brand's outbound for a window, written by day.
 *
 * Asked a month at a time. Power BI answers a query that returns too much with
 * 200 and roughly half the rows, saying nothing — the same trap the article
 * fetches guard against — and a year of one brand's daily article movements is
 * well past where that was seen.
 */
/**
 * Everything the warehouse issued, for every destination, month by month.
 *
 * One query per month for all destinations at once, rather than one per brand:
 * the fact rows are the same rows whoever is asking, and splitting them nine
 * ways client-side is free. That is nine queries a month chunk down to one.
 *
 * Destinations that are not forecast brands are kept under a single bucket
 * rather than discarded. They are real issues of real stock — the central
 * kitchen alone is 1.65 million units in a month — and the page adds them once,
 * which is what makes a raw material that only ever goes to the kitchen stop
 * reading as a blank.
 *
 * Still a month at a time. Power BI answers a query that returns too much with
 * 200 and roughly half the rows, saying nothing.
 */
export async function refreshOutboundAllBrands({ from, to }) {
  let written = 0

  for (let start = from; start <= to; start = addDays(start, 31)) {
    const end = addDays(start, 30) > to ? to : addDays(start, 30)

    const lines = await outboundFromWarehouse({ dateFrom: start, dateTo: end, byDate: true })
    if (!lines) return { rows: 0, skipped: 'no warehouse configured' }

    // Collapsed to (bucket, date, article) before writing, so the same article
    // reaching two branches of one brand on one day is one row.
    const rolled = new Map()
    for (const l of lines) {
      if (!l.date) continue
      // Nested maps, not a joined string key. A string has to be taken apart
      // again, and any separator can appear inside a destination name.
      let byDate = rolled.get(l.bucket)
      if (!byDate) rolled.set(l.bucket, (byDate = new Map()))
      let byArticle = byDate.get(l.date)
      if (!byArticle) byDate.set(l.date, (byArticle = new Map()))
      byArticle.set(l.article, (byArticle.get(l.article) ?? 0) + l.qty)
    }

    /*
     * One bucket at a time, not the whole month in one transaction.
     *
     * Two reasons, both learned the hard way. The delete has to name the brand:
     * the index on this table leads with it, so a date-only range cannot use it
     * and scans the whole table - twelve times over, once per month chunk. And
     * the copy lives inside the web server on a single database connection, so
     * one long transaction holds it for the duration and every request queues
     * behind it. The server stopped answering at all, health check included.
     *
     * Per bucket the delete is indexed and the insert is small, and the pause
     * between them lets the loop serve whatever is waiting.
     */
    for (const [bucket, byDate] of rolled) {
      const rows = []
      for (const [date, byArticle] of byDate) {
        for (const [article, qty] of byArticle) rows.push({ bucket, date, article, qty })
      }

      await pg.tx(async () => {
        await pg.run('DELETE FROM cube_outbound_daily WHERE brand = ? AND date >= ? AND date <= ?', [
          bucket,
          start,
          end,
        ])
        await insertRows(
          'cube_outbound_daily',
          ['brand', 'date', 'article', 'qty'],
          ['brand', 'date', 'article'],
          rows,
          (r) => [r.bucket, r.date, r.article, Number(r.qty) || 0]
        )
      })
      written += rows.length

      // Hand the event loop back before the next bucket.
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /*
   * Anything stored under a bucket that is not a brand or the catch-all.
   *
   * A separator eaten by a shell heredoc turned the row key into single
   * characters for one run, so rows landed under a brand of "B" with a date of
   * "B". Nothing would ever remove them, because every delete names a real
   * bucket. Cleared here, where the real buckets are known.
   */
  // Cheap because a real bucket is never one character long: a brand code is at
  // least two and the catch-all is seven. A NOT IN over every bucket could not
  // use the index and scanned the whole table on every run.
  await pg.run('DELETE FROM cube_outbound_daily WHERE length(brand) < 2')

  for (const brand of config.brands) {
    await rebuildOutboundMonthly(brand.code)
    await noteOutboundCoverage(brand.code)
  }
  await rebuildOutboundMonthly(OTHER_BUCKET)
  await noteOutboundCoverage(OTHER_BUCKET)

  return { rows: written }
}


/**
 * Rebuild one brand's monthly rollup from its daily rows.
 *
 * IN ONE TRANSACTION, from 1 Oct 2026.
 *
 * It used to be a DELETE followed by an INSERT as two separate statements, and
 * the gap between them was a hole: anything that stopped the process in between
 * left the table EMPTY for that brand. That is not a cosmetic loss -
 * `cube_outbound_monthly` is what the warehouse constant trains on, so an
 * interrupted refresh silently blanked WH forecast and WH ACC% on every row of
 * Stock Article, beside a perfectly healthy Outbound column read from the daily
 * table that was never touched.
 *
 * It happened exactly that way: a refresh started from the Admin page while
 * `node --watch` was restarting the server on file changes. The window is small
 * but it is open on every run, and a deploy, a crash or an OOM would do the
 * same.
 *
 * Wrapped, the two statements are one unit: either the rollup is replaced or
 * the previous one stays. The worst case becomes stale rather than absent,
 * which is the right direction for a derived table to fail in.
 */
/**
 * Rebuild the monthly rollup wherever it has been lost, from the daily rows.
 *
 * Added 1 Oct 2026, with the transaction below.
 *
 * The rollup is DERIVED: every row of it is a sum of `cube_outbound_daily`,
 * which no refresh deletes. So when the rollup is missing and the daily rows are
 * not, the answer is arithmetic rather than another year of Power BI traffic -
 * seconds against minutes, and no capacity spent.
 *
 * This matters because nothing else notices. The startup freshness gate reads
 * coverage TIMESTAMPS, so an emptied rollup still looks recently pulled and is
 * skipped on every boot - the copy stays broken until somebody refreshes it by
 * hand. Checking the rows rather than the clock is what makes it self-healing.
 *
 * Returns the number of brands repaired, so the caller can say so.
 */
export async function repairOutboundRollup() {
  const brands = [...config.brands.map((b) => b.code), OTHER_BUCKET]
  const repaired = []
  for (const brand of brands) {
    const monthly = (await pg.get('SELECT COUNT(*)::int AS n FROM cube_outbound_monthly WHERE brand = ?', [brand]))?.n ?? 0
    if (monthly > 0) continue
    const daily = (await pg.get('SELECT COUNT(*)::int AS n FROM cube_outbound_daily WHERE brand = ?', [brand]))?.n ?? 0
    // Nothing daily either means this brand was genuinely never pulled. That is
    // a job for the refresh, not for a rollup that has nothing to roll up.
    if (!daily) continue
    await rebuildOutboundMonthly(brand)
    repaired.push(brand)
  }
  if (repaired.length) {
    forgetConstants()
    console.warn(
      `  [cube] outbound rollup was empty for ${repaired.join(', ')} - rebuilt from the daily ` +
        `rows. Warehouse forecast would have been blank for ${repaired.length === 1 ? 'that brand' : 'those brands'}.`
    )
  }
  return repaired.length
}

async function rebuildOutboundMonthly(brand) {
  await pg.tx(async () => {
    await pg.run('DELETE FROM cube_outbound_monthly WHERE brand = ?', [brand])
    await pg.run(
      `INSERT INTO cube_outbound_monthly (brand, month, article, qty)
       SELECT brand, substr(date, 1, 7), article, SUM(qty)
         FROM cube_outbound_daily WHERE brand = ?
        GROUP BY brand, substr(date, 1, 7), article`,
      [brand]
    )
  })
}

/**
 * How many whole months of site history to keep.
 *
 * The forecast trains on six, and the seventh exists so that a backtest - or a
 * window opened on last month - still has six whole months before it.
 */
const SITE_MONTHS = 7

/** The `count` whole months before the month `at` falls in, oldest first. */
function wholeMonthsBefore(at, count) {
  const d = at instanceof Date ? at : new Date(`${String(at).slice(0, 10)}T00:00:00Z`)
  const out = []
  for (let i = count; i >= 1; i--) {
    out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
  }
  return out
}

/**
 * What the production sites issued, month by month, for the PA forecast.
 *
 * The twin of `rebuildOutboundMonthly` above and deliberately not built from
 * `cube_outbound_daily`: that table is warehouse-sourced, so a prepared article
 * has no row in it at all. This reads the sites directly.
 *
 * Written monthly rather than daily, unlike the warehouse copy. The only reader
 * is the rate model, which consumes whole months and nothing finer - a daily
 * copy would be seven times the rows and the same answer.
 *
 * Whole months only, and never the current one: a part month is a partial
 * numerator over a partial denominator, which is the thing the six-month rule
 * exists to avoid.
 */
export async function refreshSiteOutbound({ now = new Date() } = {}) {
  const months = wholeMonthsBefore(now, SITE_MONTHS)
  const rows = await siteOutboundByMonth(months).catch((err) => {
    console.warn(`  [site-outbound] ${String(err.message).slice(0, 90)}`)
    return null
  })
  if (!rows?.length) return { rows: 0 }

  /*
   * Replaced per month, not wholesale.
   *
   * A month that failed its query contributes nothing and must leave the copy's
   * previous answer for that month standing - the same rule the master-actual
   * write follows. Deleting everything first would turn one throttled query
   * into a hole in the training history.
   */
  const seen = [...new Set(rows.map((r) => r.month))]
  for (const month of seen) {
    await pg.run('DELETE FROM cube_site_outbound_monthly WHERE month = ?', [month])
  }
  await insertRows(
    'cube_site_outbound_monthly',
    ['brand', 'month', 'article', 'qty'],
    ['brand', 'month', 'article'],
    rows,
    (r) => [r.brand, r.month, r.article, r.qty]
  )
  forgetConstants()
  /*
   * Says so when it works, not only when it fails.
   *
   * This wrote the table silently for its first day, and `siteIfStale` returns
   * silently when the table already holds rows - so the log could show no trace
   * of the PA forecast history either arriving or being skipped. Several hours
   * on 29 Sep 2026 went into three wrong theories about a blank column that had
   * in fact been filled by an Admin refresh, and a single line here would have
   * ended it immediately. A job that fills a table should name the table.
   */
  console.log(
    `  [cube] site outbound: ${rows.length} rows over ${seen.length} month(s) — ${seen.sort().join(', ')}`
  )
  return { rows: rows.length, months: seen.length }
}

/** Measured from the rows, like every other coverage figure here. */
async function noteOutboundCoverage(brand) {
  const span = (await pg.get(
    'SELECT MIN(date) AS lo, MAX(date) AS hi FROM cube_outbound_daily WHERE brand = ?',
    [brand]
  )) ?? { lo: null, hi: null }
  await pg.run(
    `INSERT INTO cube_coverage (brand, out_from, out_to)
     VALUES (?, ?, ?)
     ON CONFLICT (brand) DO UPDATE SET out_from = excluded.out_from, out_to = excluded.out_to`,
    [brand, span.lo, span.hi]
  )
}

/** The article master, so a nine-digit code can be shown as a name. */
export async function refreshArticles() {
  const names = await articleNames()
  if (!names.size) return { rows: 0 }
  const rows = [...names.entries()].map(([article, v]) => ({ article, ...v }))
  await insertRows('cube_article', ['article', 'name', 'unit'], ['article'], rows, (r) => [
    r.article,
    r.name ?? '',
    r.unit ?? '',
  ])
  return { rows: rows.length }
}

/**
 * The destinations that are not brands, per article.
 *
 * Recorded so a blank Outbound can explain itself. An article the warehouse
 * ships in quantity but only ever into the central kitchen has no brand to be
 * attributed to, and saying so is the difference between a figure somebody
 * trusts and one they think is broken.
 */
export async function refreshElsewhere({ from, to } = {}) {
  const rows = await outboundByDestination({ dateFrom: from, dateTo: to })
  if (!rows.length) return { rows: 0 }

  const brands = new Set(config.brands.map((b) => b.code))
  const other = rows.filter((r) => !brands.has(r.destination) && r.qty > 0)

  await pg.run('DELETE FROM cube_article_elsewhere')
  await insertRows(
    'cube_article_elsewhere',
    ['article', 'destination', 'qty'],
    ['article', 'destination'],
    other,
    (r) => [r.article, r.destination, r.qty]
  )
  return { rows: other.length }
}

/**
 * The constants for the items no recipe covers, worked out once a month.
 *
 * Derived entirely from rows already here — last month's sales from the trend
 * copy, last month's outbound from the table above — so it costs no round trip
 * at all once the copy is filled.
 */
export async function refreshConstants(brand, { month, from, to, allBrands = false } = {}) {
  /*
   * The bucket for destinations that are not brands has no brand's sales to be
   * measured against, so it is measured against all of them. It is consumption
   * for the business — the central kitchen cooking for everyone — and the rate
   * that describes it is per item the business sells, not per item one brand
   * sells.
   */
  const sales = allBrands
    ? await pg.get(
        `SELECT SUM(actual)::float8 AS qty FROM cube_location_daily
          WHERE date >= ? AND date <= ?`,
        [from, to]
      )
    : await pg.get(
        `SELECT SUM(actual)::float8 AS qty FROM cube_location_daily
          WHERE brand = ? AND date >= ? AND date <= ?`,
        [brand.code, from, to]
      )
  const lastSales = Number(sales?.qty) || 0
  if (!lastSales) return { brand: brand.code, rows: 0, skipped: 'no sales' }

  // Anything a recipe covers is forecast from the recipe and must not be
  // forecast a second time from its own movement.
  const rows = await pg.all(
    `SELECT o.article, SUM(o.qty)::float8 AS qty
       FROM cube_outbound_daily o
      WHERE o.brand = ? AND o.date >= ? AND o.date <= ?
        AND o.article NOT IN (SELECT article FROM cube_component_daily WHERE article <> '')
      GROUP BY o.article
     HAVING SUM(o.qty) > 0`,
    [brand.code, from, to]
  )

  await pg.run('DELETE FROM cube_constant WHERE brand = ?', [brand.code])
  await insertRows(
    'cube_constant',
    ['brand', 'article', 'month', 'constant', 'outbound'],
    ['brand', 'article'],
    rows,
    (r) => [brand.code, r.article, month, lastSales / Number(r.qty), Number(r.qty)]
  )
  return { brand: brand.code, rows: rows.length }
}

/** Every brand: outbound, the article master, then the constants. */
export async function refreshAllOutbound({ from, to, month, lastFrom, lastTo }) {
  await refreshArticles().catch(() => ({ rows: 0 }))
  await refreshElsewhere({ from, to }).catch((err) => {
    console.log(`  [cube] elsewhere failed: ${err.message.slice(0, 80)}`)
    return { rows: 0 }
  })
  const out = []
  // One pass over the warehouse for every destination, rather than one per
  // brand: the rows are the same rows whoever is asking.
  try {
    out.push(await refreshOutboundAllBrands({ from, to }))
  } catch (err) {
    out.push({ rows: 0, error: err.message.slice(0, 80) })
  }

  /*
   * The production sites, for the PA forecast.
   *
   * After the warehouse pass and in its own try: this is a second source for a
   * second forecast, and a throttled site query must not cost the warehouse its
   * copy. Seven whole months, one query each, every brand at once.
   */
  try {
    out.push({ site: await refreshSiteOutbound() })
  } catch (err) {
    out.push({ site: { rows: 0 }, error: err.message.slice(0, 80) })
  }

  for (const brand of config.brands) {
    try {
      await refreshConstants(brand, { month, from: lastFrom, to: lastTo })
    } catch (err) {
      out.push({ brand: brand.code, error: err.message.slice(0, 80) })
    }
  }
  // The unattributed bucket gets a constant too, measured against every brand's
  // sales together — it is consumption for the business, just not for any one
  // brand, and the page adds its forecast once alongside the rest.
  try {
    await refreshConstants({ code: OTHER_BUCKET }, { month, from: lastFrom, to: lastTo, allBrands: true })
  } catch (err) {
    out.push({ brand: OTHER_BUCKET, error: err.message.slice(0, 80) })
  }
  // An article the warehouse has started shipping is new evidence, and the
  // "never shipped here" set is what decides whether a component can be scored
  // at all. Held for the life of the process otherwise.
  forgetShipped()
  forgetElsewhere()
  // Which articles the warehouse supplies is decided from the source column,
  // and a new article starting to arrive from it is the same new evidence.
  forgetWarehouseSourced()
  forgetMaster()
  // The status ladder is read straight off these dates.
  forgetShipHistory()
  // The six-month constants are averages over these very rows.
  forgetConstants()
  return out
}
