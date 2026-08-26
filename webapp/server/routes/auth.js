import { Router } from 'express'
import { pg } from '../db/accounts.js'
import { raise } from '../insights/alerts.js'
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

/*
 * Brute force was a password problem, and the passwords are gone.
 *
 * A per-IP throttle and a per-account lockout guarded the one endpoint that
 * took a guessable secret. Microsoft sign-in has no such endpoint here: the
 * guessing, the lockout and the second factor all happen in the tenant, and
 * what comes back is a signed token that is either valid or is not.
 *
 * The sign-in log stays. It is how somebody notices an account being used
 * from somewhere it should not be, which is a question the tenant cannot
 * answer for them.
 */
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
 * There is no password sign-in, and no route that would accept one.
 *
 * Staff already have a work account with the tenant's password policy and
 * whatever second factor it enforces behind it. A password kept here was a
 * way in that survived all of that: someone disabled in Entra could still
 * open this, and every account meant a credential handed over somewhere.
 *
 * POST /auth/login is gone rather than disabled, so there is nothing to
 * re-enable by setting a variable and nothing to find by guessing. Getting
 * back in after a broken app registration means fixing the registration.
 */

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
  res.json({ microsoft: isConfigured(), password: false, contact })
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
