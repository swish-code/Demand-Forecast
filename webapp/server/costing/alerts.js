/**
 * The daily variance alert for the Costing Department - 19 Nov 2026.
 *
 * Asked for: an email when an article's variance goes above 20% either way.
 * Decided with the business on 19 Nov 2026:
 *
 *   - ONE email a day listing every article-brand-month that newly crossed the
 *     threshold (about 600-770 a month cross it, so one email each would be
 *     hundreds of messages).
 *   - Each article + brand + month + threshold is alerted ONCE. The key is
 *     stored in COSTING_VARIANCE_ALERT and rows are only ever inserted by
 *     MERGE, so a re-run, a restart or two runs in a day cannot repeat one.
 *   - THE FIRST RUN EMAILS NOTHING. Whatever already exceeds the threshold
 *     when the job first runs is recorded as 'baseline', so it is visible on
 *     the page, and emails start with exceedances that appear after that.
 *   - Recipients: active accounts in the Cost Controller department (managed
 *     in Admin), plus any address in COSTING_ALERT_TO.
 *   - A failed send is recorded with its error and retried on the next run,
 *     up to COSTING_ALERT_MAX_ATTEMPTS (default 5).
 *   - Classifications are NEVER changed by this job. It only notifies.
 *
 * Runs on the server's own schedule, not when somebody opens the page.
 */
import { config } from '../config.js'
import { pg } from '../db/accounts.js'
import { sendMail } from '../mail/transport.js'
import { raise, clear } from '../insights/alerts.js'
import { snowflakeConfigured } from './snowflake.js'
import { anyAlerts, alertsToSend, loadClassifications, markAlerts, recordAlerts } from './store.js'
import { ALERT_THRESHOLD, loadAnalysis, selectAlerts } from './analysis.js'

const MAX_ATTEMPTS = Number(process.env.COSTING_ALERT_MAX_ATTEMPTS) || 5
export const COSTING_DEPARTMENT = 'Cost Controller'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const fmtQty = (v) =>
  v === null || v === undefined ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })
const fmtPct = (v) => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)
const monthName = (m) =>
  new Date(`${String(m).slice(0, 10)}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

function today() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

/** Who receives the alert: Cost Controller accounts, plus COSTING_ALERT_TO. */
export async function alertRecipients() {
  const rows = await pg.all(
    `SELECT email FROM users WHERE status = 'active' AND lower(trim(department)) = lower(?)`,
    [COSTING_DEPARTMENT]
  )
  const extra = String(process.env.COSTING_ALERT_TO ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Map()
  for (const e of [...rows.map((r) => r.email), ...extra]) {
    const k = String(e ?? '').trim().toLowerCase()
    if (k && /@/.test(k) && !seen.has(k)) seen.set(k, String(e).trim())
  }
  return [...seen.values()]
}

/** The email: a short explanation, the table, and the same rows as CSV. */
export function buildAlertEmail(alerts, { link } = {}) {
  const rows = alerts
    .map(
      (a) => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(a.articleId)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(a.articleName)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(a.brand)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(monthName(a.month))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmtQty(a.theoretical)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmtQty(a.actual)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:${a.variancePct > 0 ? '#b45309' : '#4338ca'}"><strong>${fmtPct(a.variancePct)}</strong></td>
      </tr>`
    )
    .join('')
  const threshold = `${Math.round((alerts[0]?.threshold ?? ALERT_THRESHOLD) * 100)}%`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937">
  <p>Dear Costing Department,</p>
  <p>The following ${alerts.length === 1 ? 'article has' : `${alerts.length} articles have`} a variance between
  MC theoretical and consumption of more than <strong>${threshold}</strong> (above or below).
  Variance % = (consumption − MC theoretical) ÷ MC theoretical, the same calculation as the Variance Analysis page.</p>
  <p>Please review ${alerts.length === 1 ? 'this article' : 'these articles'} and, if required, update the
  Recipe / Non-Recipe classification or other relevant information on the Monthly MC Analysis page.
  Nothing has been changed automatically.</p>
  ${link ? `<p><a href="${esc(link)}">Open the Monthly MC Analysis page</a></p>` : ''}
  <table style="border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f3f4f6;text-align:left">
      <th style="padding:6px 10px">Article ID</th><th style="padding:6px 10px">Article name</th>
      <th style="padding:6px 10px">Brand</th><th style="padding:6px 10px">Month</th>
      <th style="padding:6px 10px;text-align:right">MC theoretical</th>
      <th style="padding:6px 10px;text-align:right">Consumption</th>
      <th style="padding:6px 10px;text-align:right">Variance %</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#6b7280;font-size:12px">Each article, brand and month is reported once. The full list is attached as CSV.</p>
</div>`

  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [
    ['Article ID', 'Article name', 'Brand', 'Month', 'MC theoretical', 'Consumption', 'Variance %'],
    ...alerts.map((a) => [
      a.articleId,
      a.articleName,
      a.brand,
      String(a.month).slice(0, 7),
      a.theoretical,
      a.actual,
      a.variancePct === null ? '' : Math.round(a.variancePct * 1000) / 10,
    ]),
  ]
    .map((r) => r.map(csvCell).join(','))
    .join('\r\n')

  return {
    subject: `MC variance above ${threshold}: ${alerts.length} article${alerts.length === 1 ? '' : 's'} to review`,
    html,
    attachments: [
      { filename: `mc-variance-alerts-${today()}.csv`, contentType: 'text/csv', content: Buffer.from(`﻿${csv}`, 'utf8') },
    ],
  }
}

function logEmail({ email, subject, status, error, meta }) {
  return pg
    .run(
      `INSERT INTO email_log (day, email, role, subject, status, error, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [today(), email, 'variance_alert', subject ?? null, status, error ?? null, meta ? JSON.stringify(meta) : null]
    )
    .catch((err) => console.warn(`  [costing] could not record a send (${err.message})`))
}

/**
 * One run: find exceedances, record new ones, email what is waiting.
 * Safe to call more than once a day - only unsent alerts are ever emailed.
 */
export async function runVarianceAlerts({ reason = 'scheduled', deps = {} } = {}) {
  // Everything that reaches outside this file, replaceable for the tests.
  const {
    configured = snowflakeConfigured,
    analysis = loadAnalysis,
    alertRecipients: recipientsOf = alertRecipients,
    sendMail: send = sendMail,
    logEmail: log = logEmail,
    raise: raiseAlert = raise,
    clear: clearAlert = clear,
    testTo = config.mail.testTo,
    appOrigin = config.appOrigin,
  } = deps
  if (!configured()) return { skipped: 'Snowflake is not configured' }

  const overrides = await loadClassifications()
  const { months, rows } = await analysis({ month: null, brands: null, overrides })
  const found = selectAlerts(rows, months)

  const firstRun = !(await anyAlerts())
  const recorded = await recordAlerts(found, firstRun ? 'baseline' : 'pending')
  if (firstRun) {
    console.log(`  [costing] first alert run: ${recorded} existing exceedances recorded as baseline, none emailed`)
    return { reason, months, found: found.length, recorded, baseline: true, sent: 0 }
  }

  const waiting = await alertsToSend(MAX_ATTEMPTS)
  if (!waiting.length) return { reason, months, found: found.length, recorded, sent: 0 }

  const recipients = await recipientsOf()
  if (!recipients.length) {
    raiseAlert({
      source: 'costing',
      key: 'costing:recipients',
      severity: 'warning',
      title: 'Variance alerts have nobody to go to',
      detail: `${waiting.length} alert(s) are waiting. Add an active account to the ${COSTING_DEPARTMENT} department, or set COSTING_ALERT_TO.`,
    })
    return { reason, months, found: found.length, recorded, waiting: waiting.length, sent: 0, error: 'no recipients' }
  }
  clearAlert('costing:recipients')

  const message = buildAlertEmail(waiting, { link: appOrigin ? `${appOrigin}/?page=costing` : null })
  const ids = waiting.map((a) => a.id)
  let delivered = 0
  let lastError = null
  for (const intended of recipients) {
    const to = testTo || intended
    const redirected = Boolean(testTo) && to !== intended
    try {
      await send({
        to,
        subject: redirected ? `[test → ${intended}] ${message.subject}` : message.subject,
        html: message.html,
        attachments: message.attachments,
      })
      delivered += 1
      log({ email: to, subject: message.subject, status: 'sent', meta: { alerts: ids.length, intendedFor: intended, redirected } })
    } catch (err) {
      lastError = err.message
      log({ email: to, subject: message.subject, status: 'failed', error: err.message, meta: { alerts: ids.length } })
    }
  }

  if (delivered > 0) {
    await markAlerts(ids, { status: 'sent', recipients: recipients.join('; ') })
    clearAlert('costing:send')
  } else {
    await markAlerts(ids, { status: 'failed', error: lastError })
    raiseAlert({
      source: 'costing',
      key: 'costing:send',
      severity: 'critical',
      title: 'The variance alert email did not go out',
      detail: `${ids.length} alert(s) not delivered: ${lastError ?? 'unknown error'}. They will be retried on the next run.`,
    })
  }
  return { reason, months, found: found.length, recorded, sent: delivered > 0 ? ids.length : 0, recipients: recipients.length, error: delivered ? null : lastError }
}

/**
 * Once a day, at COSTING_ALERT_HOUR (default 9, local time).
 *
 * Polled every ten minutes rather than one timer, like the daily reports: a
 * machine asleep at the hour would otherwise skip the day. Re-running is safe
 * because only unsent alerts are emailed.
 */
export function startCostingAlertSchedule() {
  if (!snowflakeConfigured()) return null
  if (String(process.env.COSTING_ALERTS_ENABLED ?? 'true').toLowerCase() === 'false') return null
  const hour = Number(process.env.COSTING_ALERT_HOUR ?? 9)
  let lastDay = null
  let running = false
  const tick = async () => {
    if (running || new Date().getHours() < hour || lastDay === today()) return
    running = true
    try {
      const run = await runVarianceAlerts()
      lastDay = today()
      console.log(`  [costing] variance alerts: ${JSON.stringify({ found: run.found, recorded: run.recorded, sent: run.sent, error: run.error ?? null })}`)
    } catch (err) {
      console.error('  [costing] variance alert run failed:', err.message)
      raise({ source: 'costing', key: 'costing:run', severity: 'critical', title: 'The variance alert run failed', detail: err.message })
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, 10 * 60_000)
  timer.unref?.()
  setTimeout(tick, 60_000).unref?.()
  return { hour }
}
