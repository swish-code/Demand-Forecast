import { pg } from '../db/accounts.js'
import { config } from '../config.js'
import {
  articleNames,
  outboundByDestination,
  outboundFromWarehouse,
  OTHER_BUCKET,
} from '../powerbi/warehouse.js'
import { forgetShipped, forgetElsewhere, forgetMaster } from './query.js'
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


async function rebuildOutboundMonthly(brand) {
  await pg.run('DELETE FROM cube_outbound_monthly WHERE brand = ?', [brand])
  await pg.run(
    `INSERT INTO cube_outbound_monthly (brand, month, article, qty)
     SELECT brand, substr(date, 1, 7), article, SUM(qty)
       FROM cube_outbound_daily WHERE brand = ?
      GROUP BY brand, substr(date, 1, 7), article`,
    [brand]
  )
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
  forgetMaster()
  // The six-month constants are averages over these very rows.
  forgetConstants()
  return out
}
