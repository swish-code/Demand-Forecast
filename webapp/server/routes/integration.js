import { Router } from 'express'
import crypto from 'node:crypto'
import { componentLevel } from './api.js'
import { loadScope } from '../auth/middleware.js'
import { config } from '../config.js'

/**
 * Machine-to-machine read access to the Warehouse Forecast.
 *
 *   GET /api/integration/v1/procurement-forecast?from=YYYY-MM&to=YYYY-MM[&articles=a,b]
 *   Authorization: Bearer <service token>
 *
 * Built for the Supplier app's Forecast page, which needs the same "WH forecast"
 * an administrator sees on Procurement (Warehouse Forecast mode, every brand,
 * one month at a time) without typing it in by hand.
 *
 * The figure is NOT recomputed here. Each month runs `componentLevel` - the
 * handler behind `/api/component-level` - in-process with the exact payload the
 * Procurement page sends, then folds rows per article exactly as that page
 * does. Page and integration therefore cannot drift apart.
 *
 * Rules the blueprint (docs: procurement integration) insists on, and why they
 * hold here:
 *   - one request per month, never a range   (the window sets the anchor)
 *   - no article filter sent upstream        (it blanks the figure); `articles`
 *                                            only narrows the response
 *   - absence is not zero                    (articles with no forecast are
 *                                            simply not in `rows`)
 *
 * Credentials: INTEGRATION_TOKENS is a comma-separated list of
 * `name|sha256-hex-of-token`. Only the hash is stored. The token grants this
 * route and nothing else - it never becomes a session and is not honoured by
 * any other router.
 */

export const integration = Router()

const MAX_MONTHS = 12
const CONCURRENCY = 2 // what Procurement uses; more gets throttled by Power BI
const CACHE_MS = (Number(process.env.INTEGRATION_CACHE_MINUTES) || 30) * 60 * 1000

function tokens() {
  return String(process.env.INTEGRATION_TOKENS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const [name, hash] = e.split('|').map((p) => (p || '').trim())
      return name && /^[0-9a-f]{64}$/i.test(hash || '') ? { name, hash: Buffer.from(hash, 'hex') } : null
    })
    .filter(Boolean)
}

function serviceFor(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))
  if (!m) return null
  const presented = crypto.createHash('sha256').update(m[1].trim()).digest()
  for (const t of tokens()) {
    if (t.hash.length === presented.length && crypto.timingSafeEqual(t.hash, presented)) return t.name
  }
  return null
}

function requireService(req, res, next) {
  const name = serviceFor(req)
  if (!name) return res.status(401).json({ error: 'Not authorised' })
  /*
   * An administrator-shaped identity, held only for the life of this request.
   * Administrator because that is the view the figure is defined against: the
   * Procurement page pack-rounds the warehouse forecast for accounts that see
   * stock detail, and procurement orders in packs.
   */
  req.service = name
  req.serviceUser = {
    id: 0,
    email: `service:${name}`,
    name: `Integration (${name})`,
    role: 'admin',
    status: 'active',
    department: null,
  }
  next()
}

function monthsBetween(from, to) {
  const out = []
  let y = Number(from.slice(0, 4))
  let m = Number(from.slice(5, 7))
  const ly = Number(to.slice(0, 4))
  const lm = Number(to.slice(5, 7))
  while ((y < ly || (y === ly && m <= lm)) && out.length <= MAX_MONTHS) {
    const mm = String(m).padStart(2, '0')
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    out.push({ key: `${y}-${mm}`, from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` })
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

/** Run the component-level pipeline for one month, as Procurement asks it. */
async function runMonth(mo, user) {
  const req = {
    method: 'POST',
    body: {
      brands: config.brands.map((b) => b.code),
      dateFrom: mo.from,
      dateTo: mo.to,
      grain: [],
      // Columns nothing here reads. Omitting never changes a figure.
      omit: ['site', 'openPo'],
    },
    query: {},
    headers: {},
    user,
    scope: await loadScope(user.id, user.role, user.department, null),
  }
  let status = 200
  let body = null
  const res = {
    status(c) {
      status = c
      return this
    },
    json(b) {
      body = b
      return this
    },
    set() {
      return this
    },
    setHeader() {},
  }
  await componentLevel(req, res)
  if (status !== 200) throw new Error(body?.error || `component-level answered ${status}`)

  /*
   * Folded per article exactly as Procurement.jsx folds them: keyed by
   * `Item No.` (name when there is none), quantities added, and a missing
   * reading kept missing rather than becoming 0.
   */
  const out = new Map()
  for (const r of body?.rows ?? []) {
    const code = String(r['Item No.'] ?? '').trim()
    const name = String(r.Item ?? '').trim()
    const id = code || name
    if (!id) continue
    const q = r.WH_Constant_Forecast_Qty
    if (q === null || q === undefined || !Number.isFinite(Number(q))) continue
    const held = out.get(id) ?? { article_number: code, article: name, forecast_qty: 0, unit: r.BU ?? null }
    held.article = held.article || name
    held.forecast_qty += Number(q)
    out.set(id, held)
  }
  return [...out.values()]
}

const monthCache = new Map() // key -> { at, promise }

function cachedMonth(mo, user) {
  const hit = monthCache.get(mo.key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise
  const promise = runMonth(mo, user)
  monthCache.set(mo.key, { at: Date.now(), promise })
  promise.catch(() => monthCache.delete(mo.key))
  return promise
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

integration.get('/v1/procurement-forecast', requireService, async (req, res, next) => {
  try {
    const from = String(req.query.from ?? '')
    const to = String(req.query.to ?? '')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(to) || to < from) {
      return res.status(400).json({ error: 'from and to are required as YYYY-MM, with from <= to' })
    }
    const months = monthsBetween(from, to)
    if (months.length > MAX_MONTHS) return res.status(400).json({ error: `At most ${MAX_MONTHS} months per request` })

    const wanted = String(req.query.articles ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
    const keep = wanted.length
      ? (r) => wanted.includes(r.article_number.toLowerCase()) || wanted.includes(r.article.toLowerCase())
      : () => true

    const started = Date.now()
    const results = new Array(months.length)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, months.length) }, async () => {
        while (next < months.length) {
          const i = next++
          try {
            results[i] = { ok: true, rows: await cachedMonth(months[i], req.serviceUser) }
          } catch (err) {
            results[i] = { ok: false, error: String(err?.message || err).slice(0, 200) }
          }
        }
      })
    )

    const now = thisMonth()
    const rows = []
    const unavailable = []
    const returned = []
    months.forEach((mo, i) => {
      const r = results[i]
      if (!r.ok) return unavailable.push({ month: mo.key, reason: 'error', detail: r.error })
      if (!r.rows.length) return unavailable.push({ month: mo.key, reason: 'no_forecast_available' })
      returned.push(mo.key)
      const period_type = mo.key < now ? 'historical' : mo.key === now ? 'current' : 'future'
      for (const row of r.rows) {
        if (!keep(row)) continue
        rows.push({ month: mo.key, brand: 'ALL', ...row, period_type })
      }
    })

    console.log(
      `  [integration] ${req.service} procurement-forecast ${from}..${to}` +
        `${wanted.length ? ` articles=${wanted.length}` : ''} -> ${rows.length} rows in ${Date.now() - started}ms`
    )

    res.json({
      meta: {
        basis: 'warehouse',
        figure: 'WH_Constant_Forecast_Qty',
        brands: config.brands.map((b) => b.code),
        generated_at: new Date().toISOString(),
        months_requested: months.map((m) => m.key),
        months_returned: returned,
        months_unavailable: unavailable,
        row_count: rows.length,
      },
      rows,
    })
  } catch (err) {
    next(err)
  }
})
