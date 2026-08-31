import { pg } from '../db/accounts.js'
import { config } from '../config.js'
import { consumptionByArticle, articleNames } from '../powerbi/warehouse.js'

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
export async function refreshOutbound(brand, { from, to }) {
  let written = 0
  for (let start = from; start <= to; start = addDays(start, 31)) {
    const end = addDays(start, 30) > to ? to : addDays(start, 30)
    const byDay = await consumptionByArticle(
      brand.code,
      { dateFrom: start, dateTo: end },
      { byDate: true }
    )
    if (!byDay) return { brand: brand.code, rows: 0, skipped: 'no warehouse configured' }

    const rows = []
    for (const [key, qty] of byDay) {
      const [article, date] = String(key).split('|')
      if (!article || !date) continue
      rows.push({ article, date, qty })
    }

    await pg.tx(async () => {
      await pg.run('DELETE FROM cube_outbound_daily WHERE brand = ? AND date >= ? AND date <= ?', [
        brand.code,
        start,
        end,
      ])
      await insertRows(
        'cube_outbound_daily',
        ['brand', 'date', 'article', 'qty'],
        ['brand', 'date', 'article'],
        rows,
        (r) => [brand.code, r.date, r.article, Number(r.qty) || 0]
      )
    })
    written += rows.length
  }

  await rebuildOutboundMonthly(brand.code)
  await noteOutboundCoverage(brand.code)
  return { brand: brand.code, rows: written }
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
 * The constants for the items no recipe covers, worked out once a month.
 *
 * Derived entirely from rows already here — last month's sales from the trend
 * copy, last month's outbound from the table above — so it costs no round trip
 * at all once the copy is filled.
 */
export async function refreshConstants(brand, { month, from, to }) {
  const sales = await pg.get(
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
  const out = []
  for (const brand of config.brands) {
    try {
      out.push(await refreshOutbound(brand, { from, to }))
      await refreshConstants(brand, { month, from: lastFrom, to: lastTo })
    } catch (err) {
      out.push({ brand: brand.code, rows: 0, error: err.message.slice(0, 80) })
    }
  }
  return out
}
