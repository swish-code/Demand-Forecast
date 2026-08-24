import { config } from '../config.js'
import { data } from '../data/index.js'
import { db } from '../db/index.js'
import {
  evaluateBrand,
  worstSeverity,
  lastCompleteDay,
  DAILY_ACCURACY_THRESHOLD,
  DAILY_ACCURACY_FLOOR,
} from './rules.js'
import { raise, clear } from './alerts.js'

/**
 * Builds the daily digest: runs every brand through the rules and stores the
 * result so the admin sees the same message all morning rather than a figure
 * that shifts under them on every page load.
 *
 * Brands are walked one at a time on purpose. The Power BI client already gates
 * concurrency, and a digest is never urgent — going wide here would just push
 * a real user's page load into the retry queue.
 */

const DIGEST_WINDOW_DAYS = 30
/** Only the calendar is needed here — an empty list skips every option query. */
const DATE_ONLY = []

/** Local calendar date, not UTC — "this morning" means the user's morning. */
export function today() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function windowFor(range) {
  const to = range?.lastActual || range?.max || range?.today
  if (!to) return {}
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (DIGEST_WINDOW_DAYS - 1) * 86_400_000)
  return { dateFrom: from.toISOString().slice(0, 10), dateTo: to }
}

/**
 * One brand's findings. Any failure becomes a finding rather than an exception:
 * a brand that cannot be reached is itself the most important thing to report,
 * and one broken model must not cost the digest the other eight.
 */
/**
 * One retry before a brand is written off.
 *
 * The digest runs unattended at seven in the morning, and a single network
 * stall used to cost that brand its whole row — BBT reported "no completed day"
 * for a morning purely because one request did not answer within eight seconds.
 * The interactive timeout is right for somebody waiting on a page; here nobody
 * is, so it is worth asking twice before declaring a model unreachable.
 */
async function withRetry(run, { waitMs = 5_000 } = {}) {
  try {
    return await run()
  } catch (first) {
    await new Promise((r) => setTimeout(r, waitMs))
    try {
      return await run()
    } catch {
      throw first
    }
  }
}

async function forBrand(brand) {
  // Two models hold two chains each (SLC-BUR, ERMG), so the chain has to be
  // pinned here exactly as the API does it. Without this, SLC and BUR report
  // the same figures because they are reading the same unfiltered model.
  const base = { brand: brand.code, ...(brand.chain ? { brands: [brand.chain] } : {}) }
  try {
    const slicers = await withRetry(() => data.slicers(base, brand.datasetId, DATE_ONLY))
    const range = slicers?.dateRange ?? {}
    // Measured to the last *complete* day, not to today. Today is still being
    // written, and a half-finished day drags accuracy down for reasons that
    // have nothing to do with the forecast. This is why a digest figure can
    // read higher than the same brand's card on the dashboard, whose window
    // runs to today by default.
    const window = windowFor(range)
    const f = { ...base, ...window }

    const [kpis, trend, locations, plan] = await Promise.all([
      withRetry(() => data.kpis(f, brand.datasetId)),
      withRetry(() => data.trend(f, brand.datasetId)),
      withRetry(() => data.byLocation(f, brand.datasetId)),
      withRetry(() => data.productionPlan(base, brand.datasetId)).catch(() => null),
    ])

    const planSummary = plan
      ? {
          rows: plan.length,
          tomorrowQty: plan.reduce((n, r) => n + (Number(r.Tomorrow_Forecast_Qty) || 0), 0),
          extraPrep: plan.filter((r) => r.Prep_Status === 'Extra Prep Needed').length,
        }
      : null

    const findings = evaluateBrand({
      brand: { code: brand.code, label: brand.label },
      kpis,
      trend,
      locations,
      plan: planSummary,
      dateRange: range,
    })
    // Whatever was wrong with this brand last time clearly is not any more.
    clear(`powerbi:${brand.code}`)

    // Yesterday's figure for every brand, breach or not. The findings only name
    // the brands that need doing something about; this is the roll call, so a
    // quiet morning reads as quiet rather than as nothing having run.
    return { findings, window, day: lastCompleteDay(trend, range.today) }
  } catch (err) {
    raise({
      source: 'powerbi',
      key: `powerbi:${brand.code}`,
      severity: 'critical',
      title: `${brand.label} could not be read from Power BI`,
      detail: err.message,
    })
    return {
      window: null,
      findings: [
        {
          severity: 'critical',
          code: 'unreachable',
          title: `${brand.label}: could not be read`,
          detail: `Power BI returned "${err.message}". Nothing about this brand could be checked.`,
        },
      ],
    }
  }
}

/** Runs every brand and writes one digest row. Returns the stored digest. */
export async function buildDigest({ reason = 'scheduled' } = {}) {
  const startedAt = Date.now()
  const findings = []

  const windows = []
  const daily = []
  for (const brand of config.brands) {
    const { findings: rows, window, day } = await forBrand(brand)
    for (const r of rows) findings.push({ ...r, brand: brand.code, brandLabel: brand.label })
    if (window?.dateTo) windows.push({ brand: brand.code, from: window.dateFrom, to: window.dateTo })

    daily.push({
      brand: brand.code,
      brandLabel: brand.label,
      date: day?.date ?? null,
      actual: day?.actual ?? null,
      forecast: day?.forecast ?? null,
      accuracy: day?.accuracy ?? null,
      state: !day
        ? 'none'
        : day.accuracy < DAILY_ACCURACY_FLOOR
          ? 'bad'
          : day.accuracy < DAILY_ACCURACY_THRESHOLD
            ? 'warn'
            : 'good',
    })
  }

  // Worst first. The point of a scoreboard read at seven in the morning is that
  // the problems are at the top, not somewhere in the middle in brand order.
  daily.sort((a, b) => {
    if (a.accuracy === null) return 1
    if (b.accuracy === null) return -1
    return a.accuracy - b.accuracy
  })

  const digest = {
    day: today(),
    generated_at: new Date().toISOString(),
    reason,
    duration_ms: Date.now() - startedAt,
    brands: config.brands.length,
    daily,
    dailyThreshold: DAILY_ACCURACY_THRESHOLD,
    windows,
    // The single date every brand was measured to, when they agree — which is
    // the normal case, and lets the panel say it in one line.
    measuredTo: windows.length && windows.every((w) => w.to === windows[0].to) ? windows[0].to : null,
    worst: worstSeverity(findings),
    counts: {
      critical: findings.filter((f) => f.severity === 'critical').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
    findings,
  }

  // One row per day: a manual re-run replaces the morning's copy rather than
  // stacking a second one the admin has to choose between.
  db.prepare(
    `INSERT INTO digests (day, generated_at, reason, payload_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       generated_at = excluded.generated_at,
       reason       = excluded.reason,
       payload_json = excluded.payload_json`
  ).run(digest.day, digest.generated_at, reason, JSON.stringify(digest))

  return digest
}

export function latestDigest() {
  const row = db.prepare('SELECT payload_json FROM digests ORDER BY day DESC LIMIT 1').get()
  return row ? JSON.parse(row.payload_json) : null
}

export function digestFor(day) {
  const row = db.prepare('SELECT payload_json FROM digests WHERE day = ?').get(day)
  return row ? JSON.parse(row.payload_json) : null
}

export function recentDigests(limit = 14) {
  return db
    .prepare('SELECT day, generated_at, reason FROM digests ORDER BY day DESC LIMIT ?')
    .all(limit)
}

/**
 * Schedules the morning run.
 *
 * Deliberately a polling check rather than a single long timer: a laptop that
 * sleeps through 07:00 would silently skip the day with setTimeout, whereas
 * this notices on the next tick after waking and still produces the digest.
 */
export function startDigestSchedule() {
  const hour = Number(process.env.DIGEST_HOUR ?? 7)
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null

  let running = false
  const tick = async () => {
    if (running) return
    const now = new Date()
    if (now.getHours() < hour) return
    if (db.prepare('SELECT 1 FROM digests WHERE day = ?').get(today())) return

    running = true
    try {
      const digest = await buildDigest({ reason: 'scheduled' })
      clear('digest:scheduled')
      console.log(
        `  Daily digest for ${digest.day}: ${digest.counts.critical} critical, ` +
          `${digest.counts.warning} warning, ${digest.counts.info} info`
      )
    } catch (err) {
      console.error('  Daily digest failed:', err.message)
      raise({
        source: 'digest',
        key: 'digest:scheduled',
        severity: 'critical',
        title: 'The morning digest did not complete',
        detail: err.message,
      })
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, 5 * 60_000)
  timer.unref?.()
  setTimeout(tick, 15_000).unref?.()
  return timer
}
