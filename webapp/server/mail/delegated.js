import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { config } from '../config.js'
import { pg } from '../db/accounts.js'

/**
 * Sending as a real mailbox, with that mailbox's own consent.
 *
 * This is the simplest route that does not need a tenant administrator. The
 * application permission the app was built around (Mail.Send, admin-consented)
 * lets it send as anybody, which is why only an administrator can grant it.
 * Delegated Mail.Send only lets it send as the one person who signed in, so
 * that person can consent for themselves.
 *
 * Somebody signs in once as automation@swishhh.net and ticks the box. The
 * refresh token is kept here, and every morning it is exchanged for a fresh
 * access token. Nothing else changes: the same reports, the same recipients.
 *
 * The token is stored encrypted rather than in the clear. A refresh token is a
 * standing permission to send mail as that mailbox, so a copy of the database
 * on its own should not be enough — the client secret has to be present too.
 */

const AUTHORITY = () => `https://login.microsoftonline.com/${config.ms.tenantId}`
const GRAPH = 'https://graph.microsoft.com/v1.0'
const SCOPES = 'offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read'

/** Marks a callback as this flow rather than a user signing in. */
export const STATE_PREFIX = 'mbx.'

const b64url = (buf) => buf.toString('base64url')
const STATE_TTL_MS = 10 * 60_000
const pending = new Map()

const sweep = () => {
  const now = Date.now()
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k)
}

/* ------------------------------------------------------------ storage --- */

const key = () =>
  scryptSync(String(config.ms.clientSecret ?? 'no-secret'), 'demand-forecast/mail-identity', 32)

function seal(text) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${body.toString('base64')}`
}

function unseal(packed) {
  const [iv, tag, body] = String(packed).split('.')
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8')
}

const row = () => pg.get('SELECT * FROM mail_identity WHERE id = 1')

/** Who we are currently able to send as, without exposing the token. */
export function connectedMailbox() {
  const r = row()
  if (!r) return null
  return { email: r.email, connectedAt: r.connected_at, connectedBy: r.connected_by }
}

export async function disconnectMailbox() {
  await pg.run('DELETE FROM mail_identity WHERE id = 1')
}

/* --------------------------------------------------------- the consent --- */

export function beginConnect() {
  sweep()
  const state = STATE_PREFIX + b64url(randomBytes(24))
  const verifier = b64url(randomBytes(32))
  pending.set(state, { verifier, expires: Date.now() + STATE_TTL_MS })

  const url = new URL(`${AUTHORITY()}/oauth2/v2.0/authorize`)
  url.searchParams.set('client_id', config.ms.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', config.ms.redirectUri)
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()))
  url.searchParams.set('code_challenge_method', 'S256')
  // Ask every time. Without it, somebody already signed in is sent straight
  // back with no chance to pick the automation mailbox over their own account.
  url.searchParams.set('prompt', 'select_account')
  return { url: url.toString(), state }
}

export const isConnectState = (state) => String(state ?? '').startsWith(STATE_PREFIX)

async function exchange(body) {
  const res = await fetch(`${AUTHORITY()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.ms.clientId,
      client_secret: config.ms.clientSecret,
      redirect_uri: config.ms.redirectUri,
      scope: SCOPES,
      ...body,
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description?.split('\n')[0] || json.error || `Token request failed (${res.status})`)
  }
  return json
}

/** Finish the consent and remember the mailbox. */
export async function completeConnect({ code, state, actorId }) {
  const held = pending.get(state)
  pending.delete(state)
  if (!held) throw new Error('That consent link has expired. Start again.')

  const token = await exchange({
    grant_type: 'authorization_code',
    code,
    code_verifier: held.verifier,
  })
  if (!token.refresh_token) {
    throw new Error('Microsoft did not return a refresh token, so this could not be kept for tomorrow.')
  }

  const me = await fetch(`${GRAPH}/me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  })
    .then((r) => r.json())
    .catch(() => ({}))

  const email = me.mail || me.userPrincipalName || ''
  await pg.run(
    `INSERT INTO mail_identity (id, email, refresh_token, connected_at, connected_by)
     VALUES (1, ?, ?, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       refresh_token = excluded.refresh_token,
       connected_at = excluded.connected_at,
       connected_by = excluded.connected_by`,
    [email, seal(token.refresh_token), actorId ?? null]
  )

  return { email }
}

/* ------------------------------------------------------------ sending --- */

let cached = null

async function accessToken() {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value

  const r = row()
  if (!r) throw new Error('No mailbox is connected. Connect one on the admin page.')

  const token = await exchange({
    grant_type: 'refresh_token',
    refresh_token: unseal(r.refresh_token),
  })

  // Microsoft usually rotates the refresh token; keeping the new one is what
  // stops this quietly expiring in ninety days.
  if (token.refresh_token) {
    await pg.run('UPDATE mail_identity SET refresh_token = ? WHERE id = 1', [seal(token.refresh_token)])
  }

  cached = { value: token.access_token, expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000 }
  return cached.value
}

/**
 * An attachment's bytes, whether it arrived as text or as a Buffer.
 *
 * A CSV is a string; an .xlsx is binary and must not be run through a UTF-8
 * decode on the way to base64 — that silently corrupts the zip and Excel then
 * reports the file as unreadable.
 */
const bytesOf = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'))

export async function sendMail({ to, subject, html, replyTo, attachments = [] }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean)
  if (!recipients.length) throw new Error('No recipients')

  const res = await fetch(`${GRAPH}/me/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
        ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
        ...(attachments.length
          ? {
              attachments: attachments.map((a) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: a.filename,
                contentType: a.contentType ?? 'text/csv',
                contentBytes: bytesOf(a.content).toString('base64'),
              })),
            }
          : {}),
      },
      saveToSentItems: true,
    }),
  })

  if (res.status === 202) return { ok: true }
  const json = await res.json().catch(() => ({}))
  if (res.status === 401) cached = null
  throw Object.assign(
    new Error(json?.error?.message || `Graph sendMail failed (${res.status})`),
    { status: res.status }
  )
}
