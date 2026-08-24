import { Router } from 'express'
import { db } from '../db/index.js'
import { generatePassword, hashPassword } from '../auth/passwords.js'
import { revokeAllForUser } from '../auth/sessions.js'
import { requireRole } from '../auth/middleware.js'
import { DEPARTMENTS, isDepartment } from '../departments.js'
import { beginConnect, connectedMailbox, disconnectMailbox } from '../mail/delegated.js'
import { verifyTransport, transportName } from '../mail/transport.js'
import { buildDigest, latestDigest, digestFor, recentDigests, today } from '../insights/digest.js'
import { openAlerts, recentlyResolved, resolve, resolveAll, SOURCES } from '../insights/alerts.js'
import { reviewModels } from '../insights/modelReview.js'
import { sendDailyReports, sendLog, sendSummary } from '../mail/runner.js'
import { buildForRecipient } from '../mail/reports.js'
import {
  REPORTS,
  listRecipients,
  dueRecipients,
  createRecipient,
  updateRecipient,
  deleteRecipient,
} from '../mail/recipients.js'
import { planImport, applyImport, templateCsv } from '../mail/bulk.js'
import { config } from '../config.js'

export const admin = Router()

/** Everything here is admin-only; the guard is applied once, at the router. */
admin.use(requireRole('admin'))

const ROLES = ['admin', 'stakeholder', 'store', 'viewer']
const STATUSES = ['pending', 'active', 'suspended', 'disabled']


const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next)

/** Every change an admin makes is recorded, so the trail exists from day one. */
function audit(actorId, action, target, detail) {
  db.prepare(
    'INSERT INTO audit_log (actor_user_id, action, target, detail_json) VALUES (?, ?, ?, ?)'
  ).run(actorId, action, target ?? null, detail ? JSON.stringify(detail) : null)
}

function scopesOf(userId) {
  return db
    .prepare('SELECT brand_code, location_id FROM user_scopes WHERE user_id = ? ORDER BY brand_code, location_id')
    .all(userId)
    .map((r) => ({ brand: r.brand_code, location: r.location_id }))
}

/**
 * Projection for anything sent to the client. Explicit field list rather than
 * a spread: `SELECT *` would carry password_hash out to the browser, and a
 * denylist only stays correct until someone adds a column.
 */
function userRow(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    department: row.department ?? null,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    locked_until: row.locked_until,
    login_count: row.login_count ?? 0,
    scopes: scopesOf(row.id),
  }
}

// ---------------------------------------------------------------- users

admin.get(
  '/users',
  handle((req, res) => {
    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.status, u.department, u.created_at, u.last_login_at,
                u.locked_until,
                (SELECT COUNT(*) FROM login_events e
                  WHERE e.user_id = u.id AND e.success = 1) AS login_count
           FROM users u
          ORDER BY u.status = 'pending' DESC, u.created_at DESC`
      )
      .all()
    res.json({ users: rows.map(userRow), roles: ROLES, statuses: STATUSES, departments: DEPARTMENTS })
  })
)

admin.post(
  '/users',
  handle(async (req, res) => {
    const email = String(req.body?.email ?? '').trim()
    const name = String(req.body?.name ?? '').trim()
    const role = String(req.body?.role ?? 'store')
    const status = String(req.body?.status ?? 'active')
    const department = req.body?.department ? String(req.body.department) : null
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : []

    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required' })
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' })
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' })
    if (department && !isDepartment(department)) {
      return res.status(400).json({ error: 'Unknown department' })
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return res.status(409).json({ error: 'That email already has an account' })
    }

    // Generated rather than chosen by the admin, so it is never a guessable
    // pattern and is shown exactly once.
    const password = req.body?.password || generatePassword()
    const info = db
      .prepare(
        `INSERT INTO users (email, name, password_hash, role, status, department)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(email, name, await hashPassword(password), role, status, department)

    const id = Number(info.lastInsertRowid)
    writeScopes(id, scopes)
    audit(req.user.id, 'user.create', email, { role, status, department, scopes })

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    res.status(201).json({ user: userRow(row), password })
  })
)

admin.patch(
  '/users/:id',
  handle((req, res) => {
    const id = Number(req.params.id)
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!user) return res.status(404).json({ error: 'No such user' })

    const patch = {}
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim()
    if (req.body?.role !== undefined) {
      if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Unknown role' })
      patch.role = req.body.role
    }
    if (req.body?.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown status' })
      patch.status = req.body.status
    }
    if (req.body?.department !== undefined) {
      const d = req.body.department ? String(req.body.department) : null
      if (d && !isDepartment(d)) return res.status(400).json({ error: 'Unknown department' })
      patch.department = d
    }

    // An admin must not be able to lock every admin out of the system.
    if ((patch.role && patch.role !== 'admin') || (patch.status && patch.status !== 'active')) {
      if (user.role === 'admin' && lastActiveAdmin(user.id)) {
        return res.status(409).json({ error: 'This is the last active admin — promote someone else first' })
      }
    }

    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ')
      db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(patch), id)
    }
    if (Array.isArray(req.body?.scopes)) writeScopes(id, req.body.scopes)

    // Losing access should take effect now, not whenever the session expires.
    if (patch.status && patch.status !== 'active') revokeAllForUser(id)

    audit(req.user.id, 'user.update', user.email, { ...patch, scopes: req.body?.scopes })
    res.json({ user: userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) })
  })
)

const MIN_PASSWORD = 12

admin.post(
  '/users/:id/password',
  handle(async (req, res) => {
    const id = Number(req.params.id)
    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(id)
    if (!user) return res.status(404).json({ error: 'No such user' })

    // A chosen password is allowed — it is the only way to retire the seeded
    // one — but never a short one.
    const chosen = req.body?.password ? String(req.body.password) : null
    if (chosen && chosen.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Use at least ${MIN_PASSWORD} characters` })
    }
    const password = chosen ?? generatePassword()

    db.prepare(
      'UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?'
    ).run(await hashPassword(password), id)

    // Every other session for this account dies. Changing your own password
    // keeps the session you are sitting in, so an admin is not thrown out
    // halfway through their own change.
    revokeAllForUser(id, id === req.user.id ? req.sessionToken : null)

    audit(req.user.id, 'user.reset_password', user.email, { chosen: Boolean(chosen) })
    res.json({ password: chosen ? null : password })
  })
)

admin.delete(
  '/users/:id',
  handle((req, res) => {
    const id = Number(req.params.id)
    const user = db.prepare('SELECT email, role FROM users WHERE id = ?').get(id)
    if (!user) return res.status(404).json({ error: 'No such user' })
    if (id === req.user.id) return res.status(409).json({ error: 'You cannot delete your own account' })
    if (user.role === 'admin' && lastActiveAdmin(id)) {
      return res.status(409).json({ error: 'This is the last active admin' })
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    audit(req.user.id, 'user.delete', user.email, null)
    res.json({ ok: true })
  })
)

function lastActiveAdmin(excludingId) {
  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?`)
    .get(excludingId)
  return n === 0
}

/** Scopes are replaced wholesale — simpler to reason about than diffing rows. */
function writeScopes(userId, scopes) {
  db.prepare('DELETE FROM user_scopes WHERE user_id = ?').run(userId)
  const insert = db.prepare('INSERT INTO user_scopes (user_id, brand_code, location_id) VALUES (?, ?, ?)')
  for (const s of scopes) {
    const brand = s?.brand ? String(s.brand) : null
    const location = s?.location ? String(s.location) : null
    if (!brand && !location) continue
    insert.run(userId, brand, location)
  }
}

// ------------------------------------------------------------ analytics

admin.get(
  '/analytics',
  handle((req, res) => {
    const days = Math.min(180, Math.max(7, Number(req.query.days) || 30))
    const since = `-${days} days`

    const totals = db
      .prepare(
        `SELECT
           COUNT(*)                                                   AS total,
           SUM(CASE WHEN status = 'active'  THEN 1 ELSE 0 END)         AS active,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)         AS pending,
           SUM(CASE WHEN status IN ('suspended','disabled') THEN 1 ELSE 0 END) AS inactive,
           SUM(CASE WHEN last_login_at >= datetime('now', ?) THEN 1 ELSE 0 END) AS seen_recently,
           SUM(CASE WHEN last_login_at IS NULL THEN 1 ELSE 0 END)      AS never_signed_in
         FROM users`
      )
      .get(since)

    // Daily sign-ins, distinct people rather than raw events — one person
    // logging in six times is one user, not six.
    const daily = db
      .prepare(
        `SELECT date(created_at) AS day,
                COUNT(*) AS logins,
                COUNT(DISTINCT user_id) AS users
           FROM login_events
          WHERE success = 1 AND created_at >= datetime('now', ?)
          GROUP BY day ORDER BY day`
      )
      .all(since)

    const failures = db
      .prepare(
        `SELECT date(created_at) AS day, COUNT(*) AS failures
           FROM login_events
          WHERE success = 0 AND created_at >= datetime('now', ?)
          GROUP BY day ORDER BY day`
      )
      .all(since)

    const byRole = db
      .prepare(
        `SELECT u.role,
                COUNT(DISTINCT u.id) AS users,
                COUNT(e.id)          AS logins
           FROM users u
           LEFT JOIN login_events e
                  ON e.user_id = u.id AND e.success = 1 AND e.created_at >= datetime('now', ?)
          GROUP BY u.role ORDER BY u.role`
      )
      .all(since)

    // Usage per brand and per store, resolved through each user's grants.
    //
    // The DISTINCT subqueries matter: a store user granted two locations of one
    // brand has two scope rows, and joining login events straight onto those
    // would count every sign-in twice.
    const brandRows = db
      .prepare(
        `SELECT g.brand_code AS brand,
                COUNT(DISTINCT g.user_id) AS users,
                COUNT(e.id)               AS logins
           FROM (SELECT DISTINCT user_id, brand_code FROM user_scopes
                  WHERE brand_code IS NOT NULL) g
           LEFT JOIN login_events e
                  ON e.user_id = g.user_id AND e.success = 1 AND e.created_at >= datetime('now', ?)
          GROUP BY g.brand_code
          ORDER BY logins DESC, users DESC`
      )
      .all(since)

    const byLocation = db
      .prepare(
        `SELECT g.location_id AS location,
                COUNT(DISTINCT g.user_id) AS users,
                COUNT(e.id)               AS logins
           FROM (SELECT DISTINCT user_id, location_id FROM user_scopes
                  WHERE location_id IS NOT NULL) g
           LEFT JOIN login_events e
                  ON e.user_id = g.user_id AND e.success = 1 AND e.created_at >= datetime('now', ?)
          GROUP BY g.location_id
          ORDER BY logins DESC, users DESC
          LIMIT 20`
      )
      .all(since)

    const labels = new Map(config.brands.map((b) => [b.code, b.label]))
    const byBrand = brandRows.map((r) => ({ ...r, label: labels.get(r.brand) ?? r.brand }))

    const byDepartment = db
      .prepare(
        `SELECT COALESCE(u.department, 'Not set') AS department,
                COUNT(DISTINCT u.id) AS users,
                COUNT(e.id)          AS logins
           FROM users u
           LEFT JOIN login_events e
                  ON e.user_id = u.id AND e.success = 1 AND e.created_at >= datetime('now', ?)
          GROUP BY COALESCE(u.department, 'Not set')
          ORDER BY logins DESC, users DESC`
      )
      .all(since)

    const recent = db
      .prepare(
        `SELECT e.created_at, e.email_attempted, e.success, e.reason, e.ip, u.name, u.role
           FROM login_events e
           LEFT JOIN users u ON u.id = e.user_id
          ORDER BY e.id DESC LIMIT 50`
      )
      .all()

    res.json({ days, totals, daily, failures, byRole, byBrand, byLocation, byDepartment, recent })
  })
)

// ---------------------------------------------------------------- audit

admin.get(
  '/audit',
  handle((req, res) => {
    const rows = db
      .prepare(
        `SELECT a.created_at, a.action, a.target, a.detail_json, u.email AS actor
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
          ORDER BY a.id DESC LIMIT 200`
      )
      .all()
    res.json({ entries: rows })
  })
)

// ------------------------------------------------------------- insights

/**
 * The morning digest. Findings are computed on a schedule rather than per
 * request so that the message stays the same all morning — an alert that
 * changes wording every time the page is refreshed is one nobody trusts.
 */
admin.get(
  '/insights',
  handle((req, res) => {
    const day = req.query.day ? String(req.query.day) : null
    const digest = day ? digestFor(day) : latestDigest()
    const row = digest
      ? db.prepare('SELECT acked_by, acked_at FROM digests WHERE day = ?').get(digest.day)
      : null
    const ackedBy = row?.acked_by
      ? db.prepare('SELECT email, name FROM users WHERE id = ?').get(row.acked_by)
      : null

    res.json({
      digest,
      today: today(),
      stale: digest ? digest.day !== today() : true,
      acknowledged: row?.acked_at ? { at: row.acked_at, by: ackedBy?.name || ackedBy?.email } : null,
      history: recentDigests(),
    })
  })
)

/** Rebuild now. Slow by nature — it walks every brand — so it is explicit. */
admin.post(
  '/insights/run',
  handle(async (req, res) => {
    const digest = await buildDigest({ reason: `manual:${req.user.email}` })
    audit(req.user.id, 'digest.run', digest.day, { counts: digest.counts })
    res.json({ digest, today: today(), stale: false, acknowledged: null, history: recentDigests() })
  })
)

/** Marks the day's findings as seen, so tomorrow's digest reads as new. */
admin.post(
  '/insights/ack',
  handle((req, res) => {
    const day = String(req.body?.day || today())
    const info = db
      .prepare(`UPDATE digests SET acked_by = ?, acked_at = datetime('now') WHERE day = ?`)
      .run(req.user.id, day)
    if (!info.changes) return res.status(404).json({ error: 'No digest for that day' })
    audit(req.user.id, 'digest.ack', day, null)
    res.json({ ok: true })
  })
)

// --------------------------------------------------------------- alerts

/**
 * Faults, as opposed to forecast findings. Kept separate from the digest
 * because they are cleared by fixing something, not by reading them.
 */
admin.get(
  '/alerts',
  handle((req, res) => {
    res.json({ open: openAlerts(), resolved: recentlyResolved(), sources: SOURCES })
  })
)

admin.post(
  '/alerts/:id/resolve',
  handle((req, res) => {
    const changed = resolve(Number(req.params.id), req.user.id)
    if (!changed) return res.status(404).json({ error: 'No open alert with that id' })
    audit(req.user.id, 'alert.resolve', req.params.id, null)
    res.json({ open: openAlerts(), resolved: recentlyResolved(), sources: SOURCES })
  })
)

admin.post(
  '/alerts/resolve-all',
  handle((req, res) => {
    const changed = resolveAll(req.user.id)
    audit(req.user.id, 'alert.resolve_all', null, { changed })
    res.json({ open: openAlerts(), resolved: recentlyResolved(), sources: SOURCES, changed })
  })
)

// ---------------------------------------------------------------- email

/**
 * Who is due to receive what, without sending anything. Answers the question an
 * admin actually has before turning this on: "who is this going to reach?"
 */
admin.get(
  '/email/recipients',
  handle((req, res) => {
    res.json({
      recipients: listRecipients(),
      reports: REPORTS,
      departments: DEPARTMENTS,
      brands: config.brands.map(({ code, label }) => ({ code, label })),
      mailbox: config.mail.from,
      testTo: config.mail.testTo,
      enabled: config.mail.enabled,
      hour: config.mail.hour,
      log: sendLog(50),
      summary: sendSummary(),
    })
  })
)

/**
 * A spreadsheet of recipients, read but not written.
 *
 * Two steps on purpose: this returns what the file would do, and nothing
 * happens until the same file comes back with `commit`. Sixty addresses is
 * exactly the size of mistake that should be visible before it is made.
 */
admin.post(
  '/email/recipients/import',
  handle(async (req, res) => {
    const text = String(req.body?.text ?? '')
    if (!text.trim()) return res.status(400).json({ error: 'Nothing to import — the file is empty.' })

    const plan = await planImport(text)
    if (plan.error) return res.status(400).json({ error: plan.error })

    if (!req.body?.commit) {
      return res.json({ ...plan, committed: false })
    }

    const usable = plan.entries.filter((e) => e.action !== 'unchanged')
    const counts = applyImport(plan.entries, req.user.id)
    audit(req.user.id, 'email.recipient.import', `${usable.length} recipients`, counts)
    res.json({ ...plan, committed: true, counts, recipients: listRecipients() })
  })
)

/** The file to start from. */
admin.get(
  '/email/recipients/template',
  handle((req, res) => {
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="recipients-template.csv"')
    res.send(templateCsv())
  })
)

admin.post(
  '/email/recipients',
  handle((req, res) => {
    const email = String(req.body?.email ?? '').trim()
    const report = String(req.body?.report ?? '')
    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required' })
    if (!REPORTS[report]) return res.status(400).json({ error: 'Unknown report' })
    const department = req.body?.department ? String(req.body.department) : null
    if (department && !isDepartment(department)) {
      return res.status(400).json({ error: 'Unknown department' })
    }

    try {
      const id = createRecipient(
        {
          email,
          name: req.body?.name,
          report,
          department,
          brands: req.body?.brands,
          locations: req.body?.locations,
          active: req.body?.active !== false,
        },
        req.user.id
      )
      audit(req.user.id, 'email.recipient.create', email, { report, department })
      res.status(201).json({ id, recipients: listRecipients() })
    } catch (err) {
      // The unique index is the guard against the same person being added to
      // the same report twice and getting two copies every morning.
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'That address already receives this report' })
      }
      throw err
    }
  })
)

admin.patch(
  '/email/recipients/:id',
  handle((req, res) => {
    const updated = updateRecipient(Number(req.params.id), req.body ?? {})
    if (!updated) return res.status(404).json({ error: 'No such recipient' })
    audit(req.user.id, 'email.recipient.update', updated.email, req.body)
    res.json({ recipient: updated, recipients: listRecipients() })
  })
)

admin.delete(
  '/email/recipients/:id',
  handle((req, res) => {
    if (!deleteRecipient(Number(req.params.id))) {
      return res.status(404).json({ error: 'No such recipient' })
    }
    audit(req.user.id, 'email.recipient.delete', req.params.id, null)
    res.json({ recipients: listRecipients() })
  })
)

/** Checks the mailbox and the Mail.Send permission are actually usable. */
admin.get(
  '/email/check',
  handle(async (req, res) => {
    // Checks whichever route is actually selected, not Graph regardless.
    // Telling somebody who has chosen Power Automate that they need a tenant
    // administrator's consent sends them to ask for something they do not need.
    const state = await verifyTransport()
    res.json({
      ok: Boolean(state.ok),
      error: state.ok ? null : state.detail || `Not configured: ${(state.missing ?? []).join(', ')}`,
      transport: state.transport,
    })
  })
)

/**
 * Renders one recipient's report and returns it, sending nothing. This is how
 * you find out the email is wrong before sixty branches do.
 */
admin.get(
  '/email/preview/:userId',
  handle(async (req, res) => {
    const person = dueRecipients().find((p) => p.id === Number(req.params.userId))
    if (!person) return res.status(404).json({ error: 'Not a report recipient' })
    if (person.skip) return res.status(409).json({ error: person.skip })

    const messages = await buildForRecipient(person, latestDigest())
    if (!messages?.length) return res.status(409).json({ error: 'Nothing to report for tomorrow' })

    if (req.query.html === '1') {
      res.type('html').send(messages[0].html)
      return
    }
    res.json({
      recipient: { email: person.email, report: person.report },
      messages: messages.map((m) => ({ subject: m.subject, meta: m.meta, html: m.html })),
    })
  })
)

/** Sends now. `dryRun` builds without sending; `userId` limits it to one person. */
admin.post(
  '/email/send',
  handle(async (req, res) => {
    const dryRun = Boolean(req.body?.dryRun)
    const onlyUserId = req.body?.userId ?? null
    const run = await sendDailyReports({
      dryRun,
      onlyUserId,
      reason: `manual:${req.user.email}`,
    })
    audit(req.user.id, dryRun ? 'email.dry_run' : 'email.send', onlyUserId ? String(onlyUserId) : 'all', run.counts)
    res.json({ run, log: sendLog(50), summary: sendSummary() })
  })
)

// --------------------------------------------------------- model review

/**
 * How the forecast is built, brand by brand — problems in the measures and in
 * the shape of the data, with the change that would fix each one.
 *
 * Cached for an hour: it is nine heavy queries and the answer is about the
 * model's design, which does not change between page loads.
 */
let reviewCache = null

admin.get(
  '/model-review',
  handle(async (req, res) => {
    const fresh = req.query.refresh === '1'
    if (!fresh && reviewCache && reviewCache.expires > Date.now()) {
      return res.json(reviewCache.payload)
    }

    const digest = latestDigest()
    const window =
      digest?.windows?.[0]?.from && digest?.windows?.[0]?.to
        ? { from: digest.windows[0].from, to: digest.windows[0].to }
        : (() => {
            const to = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
            const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
            return { from, to }
          })()

    const review = await reviewModels(window)
    const payload = { window, ...review, generatedAt: new Date().toISOString() }
    reviewCache = { payload, expires: Date.now() + 60 * 60_000 }
    res.json(payload)
  })
)


/* ------------------------------------------------- the sending mailbox --- */

/**
 * Which way mail leaves, and whether it is ready to.
 *
 * The delegated route exists because the application permission needs a tenant
 * administrator and that consent has not been granted. This one the sending
 * mailbox grants for itself, which is the whole point of it.
 */
admin.get(
  '/email/transport',
  handle(async (req, res) => {
    // The spread goes first. Graph's own check reports the mailbox it would
    // send *as*, which is not the same thing as a mailbox somebody has
    // connected — letting it land last made an unconnected app claim one.
    res.json({
      ...(await verifyTransport()),
      transport: transportName(),
      connectedMailbox: connectedMailbox(),
    })
  })
)

/** Where to send the browser to connect the sending mailbox. */
admin.get('/email/mailbox/connect', (req, res) => {
  res.json(beginConnect())
})

admin.post('/email/mailbox/disconnect', (req, res) => {
  disconnectMailbox()
  res.json({ ok: true })
})
