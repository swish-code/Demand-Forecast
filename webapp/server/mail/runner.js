import { config } from '../config.js'
import { data } from '../data/index.js'
import { pg } from '../db/accounts.js'
import { sendMail } from './transport.js'
import { buildForRecipient } from './reports.js'
import { dueRecipients } from './recipients.js'
import { latestDigest } from '../insights/digest.js'
import { raise, clear } from '../insights/alerts.js'

/**
 * Sends the daily reports and records what happened to each one.
 *
 * Every attempt is logged, successes included. When a branch says they did not
 * get their plan, the answer has to be a row with a timestamp, not a shrug.
 */

/** Local calendar date — the reports are "tomorrow" relative to the reader. */
function today() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function log({ day, userId, email, role, subject, status, error, meta }) {
  return pg
    .run(
      `INSERT INTO email_log (day, user_id, email, role, subject, status, error, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [day, userId ?? null, email, role, subject ?? null, status, error ?? null, meta ? JSON.stringify(meta) : null]
    )
    .catch((err) => console.warn(`  [mail] could not record a send (${err.message})`))
}

/**
 * @param {object} opts
 * @param {boolean} opts.dryRun  build everything, send nothing
 * @param {number}  opts.onlyUserId  a single recipient, for a test send
 */
export async function sendDailyReports({ dryRun = false, onlyUserId = null, reason = 'scheduled' } = {}) {
  const day = today()
  const started = Date.now()
  const results = []

  let people = await dueRecipients()
  if (onlyUserId) people = people.filter((p) => p.id === Number(onlyUserId))

  // Fetched once for the whole run rather than per recipient: everyone taking
  // the digest gets the same morning.
  const digest = people.some((p) => p.report === 'daily_digest') ? await latestDigest() : null

  for (const person of people) {
    if (person.skip) {
      log({ day, userId: person.userId, email: person.email, role: person.report, status: 'skipped', error: person.skip })
      results.push({ email: person.email, role: person.report, status: 'skipped', reason: person.skip })
      continue
    }

    let messages
    try {
      messages = await buildForRecipient(person, digest)
    } catch (err) {
      log({ day, userId: person.userId, email: person.email, role: person.report, status: 'failed', error: err.message })
      results.push({ email: person.email, role: person.report, status: 'failed', reason: err.message })
      continue
    }

    if (!messages?.length) {
      const reason = 'nothing to report for tomorrow'
      log({ day, userId: person.userId, email: person.email, role: person.report, status: 'skipped', error: reason })
      results.push({ email: person.email, role: person.report, status: 'skipped', reason })
      continue
    }

    for (const message of messages) {
      // The test override is checked at the moment of sending, not when the
      // list is built, so there is no path where a half-configured run leaks to
      // real branches.
      const to = config.mail.testTo || person.email
      const redirected = Boolean(config.mail.testTo) && to !== person.email

      if (dryRun) {
        results.push({
          email: person.email,
          role: person.report,
          status: 'built',
          subject: message.subject,
          bytes: message.html.length,
          meta: message.meta,
        })
        continue
      }

      try {
        await sendMail({
          to,
          subject: redirected ? `[test → ${person.email}] ${message.subject}` : message.subject,
          html: message.html,
          attachments: message.attachments ?? [],
        })
        log({
          day,
          userId: person.userId,
          email: to,
          role: person.report,
          subject: message.subject,
          status: 'sent',
          meta: { ...message.meta, intendedFor: person.email, redirected },
        })
        results.push({ email: to, role: person.report, status: 'sent', subject: message.subject, redirected })
      } catch (err) {
        log({
          day,
          userId: person.userId,
          email: to,
          role: person.report,
          subject: message.subject,
          status: 'failed',
          error: err.message,
        })
        results.push({ email: to, role: person.report, status: 'failed', reason: err.message })
      }
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length
  const failed = results.filter((r) => r.status === 'failed').length

  // One alert for one problem. Every failure in a run shares a root cause often
  // enough that a per-message alert would just repeat itself, so the run
  // summarises: how many failed, and why the first one did.
  if (!dryRun) {
    const firstError = results.find((r) => r.status === 'failed')?.reason
    if (failed && !sent) {
      raise({
        source: 'email',
        key: 'email:daily',
        severity: 'critical',
        title: 'The daily reports did not go out',
        detail: `All ${failed} failed. ${firstError ?? 'No reason was given.'}`,
      })
    } else if (failed) {
      raise({
        source: 'email',
        key: 'email:daily',
        severity: 'warning',
        title: `${failed} of ${failed + sent} daily reports failed to send`,
        detail: `${sent} went out. ${firstError ?? ''} See the send log below.`,
      })
    } else if (sent) {
      clear('email:daily')
    }
  }

  return {
    day,
    reason,
    dryRun,
    durationMs: Date.now() - started,
    counts: {
      sent,
      failed,
      skipped: results.filter((r) => r.status === 'skipped').length,
      built: results.filter((r) => r.status === 'built').length,
    },
    redirectedTo: config.mail.testTo || null,
    results,
  }
}

export function sendLog(limit = 100) {
  return pg.all(
    `SELECT id, day, email, role, subject, status, error, created_at, meta_json
       FROM email_log ORDER BY id DESC LIMIT ?`,
    [limit]
  )
}

export function sendSummary(days = 14) {
  // SUM over a boolean is a SQLite idiom; PostgreSQL wants the comparison
  // spelled out as a CASE, and the counts cast back to plain integers.
  return pg.all(
    `SELECT day,
            SUM(CASE WHEN status = 'sent'    THEN 1 ELSE 0 END)::int AS sent,
            SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)::int AS failed,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)::int AS skipped
       FROM email_log
      WHERE created_at >= to_char(now() - ?::interval, 'YYYY-MM-DD HH24:MI:SS')
      GROUP BY day ORDER BY day DESC`,
    [`${days} days`]
  )
}

/**
 * The morning send.
 *
 * Same polling shape as the digest, and for the same reason: a machine asleep
 * at seven would silently skip the day if this were a single timer. The day is
 * recorded in email_log, so a restart cannot cause a second send.
 */
export function startMailSchedule() {
  if (!config.mail.enabled) return null
  const hour = Number(config.mail.hour)
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null

  // Give up waiting for the refresh at this hour and send regardless.
  const latest = Number(process.env.MAIL_LATEST_HOUR) || hour + 3

  /**
   * Has the model been refreshed for today yet?
   *
   * The hour alone is not enough. A prep list built before the overnight
   * refresh lands describes yesterday's world, and the branch acting on it has
   * no way of knowing. So the run waits until the model actually holds
   * yesterday's sales, and only stops waiting at the deadline — at which point
   * it sends anyway rather than silently skipping a morning, and says so.
   */
  const dataIsFresh = async () => {
    const brand = config.brands[0]
    if (!brand) return true
    try {
      const slicers = await data.slicers(
        { brand: brand.code, ...(brand.chain ? { brands: [brand.chain] } : {}) },
        brand.datasetId,
        []
      )
      const lastActual = slicers?.dateRange?.lastActual
      if (!lastActual) return true
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
      return lastActual >= yesterday
    } catch {
      // Unreachable is not the same as stale; the send itself will report a
      // real failure if there is one.
      return true
    }
  }

  let running = false
  let waitingSince = null
  const tick = async () => {
    if (running) return
    const nowHour = new Date().getHours()
    if (nowHour < hour) return
    const already = await pg.get(`SELECT 1 FROM email_log WHERE day = ? LIMIT 1`, [today()])
    if (already) return

    const fresh = await dataIsFresh()
    if (!fresh && nowHour < latest) {
      if (!waitingSince) {
        waitingSince = Date.now()
        console.log(`  Daily reports waiting: the model has not refreshed yet (will send by ${latest}:00)`)
      }
      return
    }
    const sentLate = !fresh
    waitingSince = null

    running = true
    try {
      const run = await sendDailyReports({ reason: sentLate ? 'scheduled:stale-data' : 'scheduled' })
      if (sentLate) {
        raise({
          source: 'email',
          key: 'email:stale',
          severity: 'warning',
          title: 'Reports went out before the model refreshed',
          detail: `It was still ${latest}:00 with no refresh, so the run went ahead. The figures may be a day behind.`,
        })
      }
      console.log(
        `  Daily reports for ${run.day}: ${run.counts.sent} sent, ${run.counts.failed} failed, ${run.counts.skipped} skipped`
      )
    } catch (err) {
      console.error('  Daily reports failed:', err.message)
      raise({
        source: 'email',
        key: 'email:daily',
        severity: 'critical',
        title: 'The daily report run crashed',
        detail: err.message,
      })
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, 5 * 60_000)
  timer.unref?.()
  setTimeout(tick, 30_000).unref?.()
  return timer
}
