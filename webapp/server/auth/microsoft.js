import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db/index.js'
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

  const email = String(c.preferred_username || c.email || c.upn || '').trim()
  if (!email.includes('@')) throw new Error('Microsoft did not return an email address for this account.')

  return { email, name: String(c.name || '').trim() }
}

/**
 * The account behind a verified Microsoft identity.
 *
 * An unknown person becomes a `pending` account rather than being turned away
 * outright: an admin then sees them in the approval banner and grants a role
 * and a scope. They can sign in successfully and still see nothing until that
 * happens, which is the intended behaviour, not a bug.
 */
export async function accountFor({ email, name }) {
  const existing = db
    .prepare('SELECT id, email, name, role, status FROM users WHERE email = ?')
    .get(email)

  if (existing) {
    // Fill in a name we did not have, but never overwrite one an admin set.
    if (name && !existing.name) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, existing.id)
    }
    db.prepare("UPDATE users SET auth_provider = 'microsoft' WHERE id = ?").run(existing.id)
    return { user: existing, created: false }
  }

  // No password is ever used for these accounts; the column is NOT NULL, so it
  // gets an unusable random value rather than anything guessable.
  const unusable = await hashPassword(b64url(randomBytes(32)))
  const info = db
    .prepare(
      `INSERT INTO users (email, name, password_hash, role, status, auth_provider)
       VALUES (?, ?, ?, 'store', 'pending', 'microsoft')`
    )
    .run(email, name || '', unusable)

  const user = db
    .prepare('SELECT id, email, name, role, status FROM users WHERE id = ?')
    .get(Number(info.lastInsertRowid))
  return { user, created: true }
}

export { STATE_COOKIE }
