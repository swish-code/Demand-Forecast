import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { pg } from '../db/accounts.js'
import { hashPassword } from './passwords.js'

/**
 * Interactive Microsoft sign-in (OpenID Connect authorization code + PKCE).
 *
 * The app registration that reads Power BI is reused, so the only extra setup
 * is registering the redirect URI on it. Nothing here needs an application
 * permission — `openid`, `profile` and `email` are the standard OIDC scopes and
 * every user consents to them for themselves.
 *
 * Signing in with Microsoft proves *who someone is*. It deliberately does not
 * decide *what they may see*: that still comes from the users table, so a
 * stranger with a valid tenant account lands as `pending` with no scope rather
 * than being handed the dashboard.
 */

const AUTHORITY = () => `https://login.microsoftonline.com/${config.ms.tenantId}`
const SCOPES = 'openid profile email'
const STATE_COOKIE = 'df_oidc'
const STATE_TTL_MS = 10 * 60_000

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Pending sign-ins, held in memory: they live for one redirect and no longer. */
const pending = new Map()

function sweep() {
  const now = Date.now()
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k)
}

export function isConfigured() {
  return Boolean(config.ms.tenantId && config.ms.clientId && config.ms.clientSecret && config.ms.redirectUri)
}

/**
 * Where to send the browser to sign in.
 *
 * PKCE is used even though this is a confidential client with a secret: it
 * costs nothing and removes the whole class of attack where an intercepted
 * authorization code is redeemed by somebody else.
 */
export function beginSignIn() {
  sweep()
  const state = b64url(randomBytes(24))
  const nonce = b64url(randomBytes(16))
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())

  pending.set(state, { nonce, verifier, expires: Date.now() + STATE_TTL_MS })

  const url = new URL(`${AUTHORITY()}/oauth2/v2.0/authorize`)
  url.searchParams.set('client_id', config.ms.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', config.ms.redirectUri)
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')

  return { url: url.toString(), state }
}

/** Reads a JWT's claims without verifying its signature — see the note below. */
function claims(jwt) {
  const part = jwt.split('.')[1]
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

function sameString(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Exchanges the code and returns the verified identity.
 *
 * The id_token's signature is not checked against the tenant's JWKS, and that
 * is a deliberate, bounded decision: this token was not accepted from the
 * browser. It was fetched by this server, over TLS, directly from Microsoft's
 * token endpoint, authenticated with the client secret. There is no path for a
 * forged token to arrive here. What *is* checked are the claims that bind the
 * token to this request — audience, issuer, expiry and the nonce we generated —
 * because those catch a replayed or misdirected token, which is the risk that
 * actually exists in this flow.
 */
export async function completeSignIn({ code, state }) {
  sweep()
  const held = pending.get(state)
  if (!held) throw new Error('This sign-in link has expired. Start again.')
  pending.delete(state)

  const body = new URLSearchParams({
    client_id: config.ms.clientId,
    client_secret: config.ms.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.ms.redirectUri,
    code_verifier: held.verifier,
    scope: SCOPES,
  })

  const res = await fetch(`${AUTHORITY()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.id_token) {
    throw new Error(json.error_description?.split('\n')[0] || `Microsoft rejected the sign-in (${res.status})`)
  }

  const c = claims(json.id_token)

  if (!sameString(c.aud ?? '', config.ms.clientId)) throw new Error('Sign-in token was issued for a different application.')
  if (!String(c.iss ?? '').includes(config.ms.tenantId)) throw new Error('Sign-in token came from a different tenant.')
  if (!c.nonce || !sameString(c.nonce, held.nonce)) throw new Error('Sign-in could not be verified. Please try again.')
  if (Number(c.exp) * 1000 < Date.now()) throw new Error('Sign-in token had already expired.')

  /*
   * Every address this person could have been written down as.
   *
   * An administrator granting access ahead of time types the address they know
   * — usually the mailbox on a business card. Entra's preferred_username is the
   * user principal name, which is often the same string and sometimes is not:
   * an onmicrosoft.com UPN against a vanity mail domain, or a UPN that kept
   * somebody's maiden name after their mailbox was renamed.
   *
   * Matching on preferred_username alone meant those people were treated as
   * strangers. The grant sat in the users table, unused, while they were told
   * to wait for approval they had already been given.
   *
   * The first is still who they are — it is what a new account gets created as
   * — but all of them are worth looking up before deciding nobody knows them.
   */
  const candidates = [c.preferred_username, c.email, c.upn]
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.includes('@'))

  const emails = [...new Set(candidates.map((v) => v.toLowerCase()))]
    .map((lower) => candidates.find((v) => v.toLowerCase() === lower))

  if (!emails.length) throw new Error('Microsoft did not return an email address for this account.')

  return { email: emails[0], emails, name: String(c.name || '').trim() }
}

/**
 * The account behind a verified Microsoft identity.
 *
 * An unknown person becomes a `pending` account rather than being turned away
 * outright: an admin then sees them in the approval banner and grants a role
 * and a scope. They can sign in successfully and still see nothing until that
 * happens, which is the intended behaviour, not a bug.
 */
/**
 * The addresses that are administrators the moment they sign in.
 *
 * Without this a fresh deployment is a locked room. The first person to sign in
 * with Microsoft is created pending, waiting for an administrator to approve
 * them — and there is no administrator, because the password form is hidden
 * whenever Microsoft sign-in is working. Somebody has to be let in by
 * configuration rather than by another user.
 *
 * ADMIN_EMAILS is a comma-separated list and falls back to ADMIN_EMAIL, so a
 * deployment that only names one still works. Matching is case-insensitive:
 * Entra returns whatever casing the directory holds, which is not necessarily
 * what was typed into the variable.
 */
const bootstrapAdmins = () =>
  new Set(
    String(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  )

const isBootstrapAdmin = (...addresses) => {
  const named = bootstrapAdmins()
  return addresses.flat().some((e) => e && named.has(String(e).trim().toLowerCase()))
}

export async function accountFor({ email, emails, name }) {
  // Matched without regard to case: Entra returns whatever casing the directory
  // holds, which is not necessarily how the account was first written down. And
  // against every address the token carries, so a grant written under somebody's
  // mailbox still finds them when they sign in under a different UPN.
  const lookup = (emails?.length ? emails : [email]).map((e) => String(e).trim().toLowerCase())
  const marks = lookup.map(() => '?').join(', ')

  /*
   * Every row this person could be, best one first.
   *
   * One person can end up with two rows. Somebody signs in before anybody has
   * heard of them and a pending shell is created under their user principal
   * name; an administrator then adds them properly under the mailbox address on
   * their card. Both are them, and Entra hands us both addresses.
   *
   * Ordered by id, the shell won — it was created first — so the account was
   * refused at the door however many times access had been granted, and a fresh
   * request went to the administrator every time. That is the fault this
   * ordering fixes: an active row is the answer whenever one exists, and among
   * equals the most recently used, because that is the row somebody has been
   * maintaining.
   *
   * TRIM as well as lower(): an address pasted with a trailing space is the
   * same person, and the grant on it should still find them.
   */
  const matches = await pg.all(
    `SELECT id, email, name, role, status, auth_provider, last_login_at
       FROM users
      WHERE lower(trim(email)) IN (${marks})
      ORDER BY (status = 'active') DESC,
               (role = 'admin') DESC,
               last_login_at DESC NULLS LAST,
               id ASC`,
    lookup
  )

  const existing = matches[0]

  if (existing) {
    /*
     * Fold away the shells the first attempt left behind.
     *
     * Only ever a row that nobody has touched: created by a sign-in rather than
     * by a person, still pending, never signed in, and carrying no grants. That
     * is provably an artefact of this same bug and not somebody's work, and
     * leaving it means the administrator's list keeps showing an account
     * waiting for access that has already been given it.
     */
    const shells = matches.filter(
      (m) => m.id !== existing.id && m.status === 'pending' && m.auth_provider === 'microsoft' && !m.last_login_at
    )
    for (const shell of shells) {
      const { n } = (await pg.get('SELECT COUNT(*)::int AS n FROM user_scopes WHERE user_id = ?', [shell.id])) ?? { n: 0 }
      if (n > 0) continue
      await pg.run('DELETE FROM users WHERE id = ?', [shell.id])
      console.log(`  [auth] removed a duplicate pending account for ${shell.email} (${existing.email} is active)`)
    }

    // Fill in a name we did not have, but never overwrite one an admin set.
    if (name && !existing.name) {
      await pg.run('UPDATE users SET name = ? WHERE id = ?', [name, existing.id])
    }
    await pg.run("UPDATE users SET auth_provider = 'microsoft' WHERE id = ?", [existing.id])

    // A named administrator who was created pending by an earlier sign-in is
    // let in now rather than waiting for somebody who cannot exist yet.
    if (isBootstrapAdmin(lookup) && (existing.status !== 'active' || existing.role !== 'admin')) {
      await pg.run("UPDATE users SET status = 'active', role = 'admin' WHERE id = ?", [existing.id])
      console.log(`  [auth] ${email} activated as an administrator (named in ADMIN_EMAILS)`)
      return {
        user: { ...existing, status: 'active', role: 'admin' },
        created: false,
        promoted: true,
      }
    }
    return { user: existing, created: false }
  }

  // No password is ever used for these accounts; the column is NOT NULL, so it
  // gets an unusable random value rather than anything guessable.
  const unusable = await hashPassword(b64url(randomBytes(32)))
  const bootstrap = isBootstrapAdmin(lookup)
  if (bootstrap) console.log(`  [auth] ${email} created as an administrator (named in ADMIN_EMAILS)`)
  // RETURNING gives the whole row, so there is no second query and no reliance
  // on a last-insert id that PostgreSQL does not report the same way.
  const { rows } = await pg.run(
    `INSERT INTO users (email, name, password_hash, role, status, auth_provider)
     VALUES (?, ?, ?, ?, ?, 'microsoft')
     RETURNING id, email, name, role, status`,
    [email, name || '', unusable, bootstrap ? 'admin' : 'store', bootstrap ? 'active' : 'pending']
  )
  return { user: rows[0], created: true }
}

export { STATE_COOKIE }
