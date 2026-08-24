import { Router } from 'express'
import { db } from '../db/index.js'
import { raise } from '../insights/alerts.js'
import { verifyPassword } from '../auth/passwords.js'
import {
  clearedCookie,
  createSession,
  revokeSession,
  sessionCookie,
} from '../auth/sessions.js'
import { allowedBrands, loadScope, requireAuth } from '../auth/middleware.js'
import { config } from '../config.js'
import { beginSignIn, completeSignIn, accountFor, isConfigured } from '../auth/microsoft.js'
import { isConnectState, completeConnect } from '../mail/delegated.js'

export const auth = Router()

/**
 * Login is the entire attack surface — there is no SSO in front of it — so it
 * carries three independent brakes:
 *   1. per-IP throttle, to slow a spray across many accounts
 *   2. per-account lockout, to slow a focused attack on one account
 *   3. a uniform error message and constant-ish timing, so the response never
 *      reveals whether an email exists
 */
const MAX_ATTEMPTS = 5
const LOCK_MINUTES = 15
const IP_WINDOW_MS = 60_000
const IP_MAX = 20

const ipHits = new Map()

function ipThrottled(ip) {
  const now = Date.now()
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS)
  hits.push(now)
  ipHits.set(ip, hits)
  if (ipHits.size > 5000) ipHits.clear() // crude bound; restarts are cheap
  return hits.length > IP_MAX
}

const clientIp = (req) => (req.headers['x-forwarded-for'] ?? '').toString().split(',')[0].trim() || req.ip

function record(userId, email, success, reason, req) {
  db.prepare(
    `INSERT INTO login_events (user_id, email_attempted, success, reason, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId ?? null, email ?? '', success ? 1 : 0, reason ?? null, clientIp(req), req.headers['user-agent'] ?? null)
}

/** Everything the client needs to render the shell for this user. */
function sessionPayload(user) {
  const scope = loadScope(user.id, user.role)
  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    brands: allowedBrands(scope).map(({ code, label }) => ({ code, label })),
    scope: {
      allBrands: scope.brands === null,
      allLocations: scope.locations === null,
      locations: scope.locations ? [...scope.locations] : null,
    },
  }
}

auth.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim()
  const password = String(req.body?.password ?? '')
  const ip = clientIp(req)

  if (ipThrottled(ip)) {
    record(null, email, false, 'ip_throttled', req)
    return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' })
  }

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' })
  }

  const user = db
    .prepare(
      `SELECT id, email, name, password_hash, role, status, failed_attempts, locked_until
         FROM users WHERE email = ?`
    )
    .get(email)

  // Same message for every failure: never confirm whether an account exists.
  const refuse = (reason, status = 401) => {
    record(user?.id, email, false, reason, req)
    return res.status(status).json({ error: 'Email or password is incorrect' })
  }

  if (!user) {
    // Burn comparable time so a missing account is not measurably faster.
    await verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA')
    return refuse('unknown_email')
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    record(user.id, email, false, 'locked', req)
    return res.status(429).json({ error: 'Account temporarily locked. Try again shortly.' })
  }

  const ok = await verifyPassword(password, user.password_hash)

  if (!ok) {
    const attempts = user.failed_attempts + 1
    const lock = attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, lock, user.id)

    // A lockout is either someone who forgot their password and needs help, or
    // someone guessing at an account. Either way an admin should see it.
    if (lock) {
      raise({
        source: 'auth',
        key: `auth:lockout:${user.email}`,
        severity: 'warning',
        title: `${user.email} was locked out after ${MAX_ATTEMPTS} failed sign-ins`,
        detail: `Locked until ${new Date(lock).toLocaleTimeString('en-GB')}. Reset their password from the users table if they need back in sooner.`,
      })
    }
    return refuse('bad_password')
  }

  if (user.status !== 'active') {
    record(user.id, email, false, `status_${user.status}`, req)
    const message =
      user.status === 'pending'
        ? 'Your account is awaiting approval'
        : 'Your account is not active. Contact an administrator.'
    return res.status(403).json({ error: message })
  }

  db.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?`
  ).run(user.id)

  // Honoured only for the password form. A Microsoft sign-in keeps the standard
  // window, because that session's lifetime is the tenant's business.
  const remember = req.body?.keepSignedIn === true
  const token = createSession(user.id, { ip, userAgent: req.headers['user-agent'], remember })
  record(user.id, email, true, null, req)

  res.setHeader('Set-Cookie', sessionCookie(token, { remember }))
  res.json(sessionPayload(user))
})

auth.post('/logout', (req, res) => {
  revokeSession(req.sessionToken)
  res.setHeader('Set-Cookie', clearedCookie())
  res.json({ ok: true })
})

/** Who am I — used on boot to decide between the login page and the app. */
auth.get('/me', requireAuth, (req, res) => {
  res.json(sessionPayload(req.user))
})

/* -------------------------------------------------- Microsoft sign-in ---- */

/** Whether the login page should offer the Microsoft button at all. */
auth.get('/methods', (req, res) => {
  res.json({ microsoft: isConfigured(), password: true })
})

auth.get('/microsoft/start', (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Microsoft sign-in is not configured on this server.' })
  }
  const { url } = beginSignIn()
  res.redirect(url)
})

/**
 * Where Microsoft returns the browser.
 *
 * Every outcome ends in a redirect back to the app rather than a JSON body,
 * because a person is looking at this in a browser tab. Failures carry a short
 * reason in the query string so the login page can say what went wrong instead
 * of silently returning them to an empty form.
 */
auth.get('/microsoft/callback', async (req, res) => {
  const back = (params) => res.redirect(`${config.appOrigin}/?${new URLSearchParams(params)}`)

  if (req.query.error) {
    return back({ signin: 'failed', reason: String(req.query.error_description || req.query.error).slice(0, 200) })
  }

  const code = String(req.query.code || '')
  const state = String(req.query.state || '')
  if (!code || !state) return back({ signin: 'failed', reason: 'Microsoft did not return a sign-in code.' })

  // A mailbox consent comes back through the same redirect URI, because adding
  // a second one would mean another change in Entra. The state says which it is.
  if (isConnectState(state)) {
    try {
      const { email } = await completeConnect({ code, state, actorId: req.user?.id ?? null })
      return back({ mailbox: 'connected', email })
    } catch (err) {
      return back({ mailbox: 'failed', reason: String(err.message).slice(0, 200) })
    }
  }

  try {
    const identity = await completeSignIn({ code, state })
    const { user, created } = await accountFor(identity)

    if (created) {
      record(user.id, identity.email, false, 'status_pending', req)
      return back({ signin: 'pending', email: identity.email })
    }

    if (user.status !== 'active') {
      record(user.id, identity.email, false, `status_${user.status}`, req)
      return back({ signin: user.status === 'pending' ? 'pending' : 'blocked', email: identity.email })
    }

    db.prepare(
      `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?`
    ).run(user.id)

    const token = createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] })
    record(user.id, identity.email, true, null, req)
    res.setHeader('Set-Cookie', sessionCookie(token))
    return back({ signin: 'ok' })
  } catch (err) {
    return back({ signin: 'failed', reason: err.message.slice(0, 200) })
  }
})
