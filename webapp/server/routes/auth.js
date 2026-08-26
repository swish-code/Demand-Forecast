import { Router } from 'express'
import { pg } from '../db/accounts.js'
import { raise } from '../insights/alerts.js'
import { verifyPassword } from '../auth/passwords.js'
import {
  clearedCookie,
  createSession,
  revokeSession,
  sessionCookie,
} from '../auth/sessions.js'
import { allowedBrands, loadScope, requireAuth } from '../auth/middleware.js'
import { nodeTypesFor, pagesFor } from '../departments.js'
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

/**
 * The sign-in log. Awaited by callers that can, and never allowed to fail a
 * response: a login that worked must not 500 because its audit row did not.
 */
function record(userId, email, success, reason, req) {
  return pg
    .run(
      `INSERT INTO login_events (user_id, email_attempted, success, reason, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId ?? null, email ?? '', success ? 1 : 0, reason ?? null, clientIp(req), req.headers['user-agent'] ?? null]
    )
    .catch((err) => console.warn(`  [auth] could not record a sign-in attempt (${err.message})`))
}

/** Everything the client needs to render the shell for this user. */
async function sessionPayload(user) {
  const scope = await loadScope(user.id, user.role)
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department ?? null,
    },
    brands: allowedBrands(scope).map(({ code, label }) => ({ code, label })),
    scope: {
      allBrands: scope.brands === null,
      allLocations: scope.locations === null,
      locations: scope.locations ? [...scope.locations] : null,
      // What the rail should show, and which production types this department
      // may see. Both are enforced on the server as well — this is so the shell
      // does not offer a tab that would answer 403.
      pages: pagesFor(user.department),
      nodeTypes: nodeTypesFor(user.department),
    },
  }
}

/*
 * Sign-in is Microsoft, and only Microsoft.
 *
 * Nobody here should be keeping a second password for a second copy of the
 * staff directory: the accounts already exist in Entra, they already have a
 * password policy and whatever second factor the tenant enforces, and an
 * account disabled there should not still open this. A local password was a
 * way in that survived all of that.
 *
 * PASSWORD_LOGIN=1 puts the form back. It is off unless it is set, so a
 * deployment that does not name it has no password sign-in at all. It exists
 * for two situations and no others: local development against a machine with
 * no Entra app registration, and getting back in if the tenant configuration
 * is broken badly enough that nobody can sign in to fix it.
 */
const PASSWORD_LOGIN = process.env.PASSWORD_LOGIN === '1'

auth.post('/login', async (req, res) => {
  if (!PASSWORD_LOGIN) {
    return res.status(404).json({
      error: 'This app signs in with Microsoft. There is no password to enter.',
    })
  }

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

  const user = await pg.get(
    `SELECT id, email, name, password_hash, role, status, department, failed_attempts, locked_until
       FROM users WHERE lower(email) = lower(?)`,
    [email]
  )

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
    await pg.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [attempts, lock, user.id])

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

  await pg.run(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [user.id]
  )

  // Honoured only for the password form. A Microsoft sign-in keeps the standard
  // window, because that session's lifetime is the tenant's business.
  const remember = req.body?.keepSignedIn === true
  const token = await createSession(user.id, { ip, userAgent: req.headers['user-agent'], remember })
  await record(user.id, email, true, null, req)

  res.setHeader('Set-Cookie', sessionCookie(token, { remember }))
  res.json(await sessionPayload(user))
})

auth.post('/logout', async (req, res, next) => {
  try {
    await revokeSession(req.sessionToken)
  } catch (err) {
    return next(err)
  }
  res.setHeader('Set-Cookie', clearedCookie())
  res.json({ ok: true })
})

/** Who am I — used on boot to decide between the login page and the app. */
auth.get('/me', requireAuth, (req, res, next) => {
  sessionPayload(req.user).then((payload) => res.json(payload), next)
})

/* -------------------------------------------------- Microsoft sign-in ---- */

/** Whether the login page should offer the Microsoft button at all. */
auth.get('/methods', (req, res) => {
  /*
   * Who to ask when you have no access.
   *
   * ADMIN_CONTACT if it is set, otherwise the administrator the deployment was
   * seeded with. Sent to the sign-in page so "Request access" reaches a person
   * rather than looping the visitor back through a sign-in that will only tell
   * them to wait again.
   */
  const contact = process.env.ADMIN_CONTACT || process.env.ADMIN_EMAIL || null
  res.json({ microsoft: isConfigured(), password: PASSWORD_LOGIN, contact })
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

    await pg.run(
      `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
      [user.id]
    )

    const token = await createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] })
    await record(user.id, identity.email, true, null, req)
    res.setHeader('Set-Cookie', sessionCookie(token))
    return back({ signin: 'ok' })
  } catch (err) {
    return back({ signin: 'failed', reason: err.message.slice(0, 200) })
  }
})
