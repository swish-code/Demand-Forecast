import { createHash, randomBytes } from 'node:crypto'
import { pg } from '../db/accounts.js'

/**
 * Server-side sessions in a cookie.
 *
 * Chosen over JWT because store staff use shared and kiosk devices: a session
 * can be revoked instantly here, whereas a JWT stays valid until it expires and
 * cannot be called back. Only a SHA-256 of the session id is stored, so a copy
 * of the database cannot be replayed as a live login.
 */

export const COOKIE_NAME = 'df_session'
const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS) || 12

/**
 * "Keep me signed in" — a week rather than the usual half a day.
 *
 * Deliberately not months. Store staff share devices, so a session that
 * outlives someone's rota is a real risk; a week covers the person who opens
 * this on their own laptop every morning without leaving a till logged in
 * indefinitely. It stays revocable like any other session.
 */
const REMEMBER_HOURS = (Number(process.env.SESSION_REMEMBER_DAYS) || 7) * 24

const hash = (raw) => createHash('sha256').update(raw).digest('hex')
const isoIn = (hours) => new Date(Date.now() + hours * 3600_000).toISOString()

export async function createSession(userId, { ip, userAgent, remember = false } = {}) {
  const raw = randomBytes(32).toString('base64url')
  await pg.run(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
    [hash(raw), userId, isoIn(remember ? REMEMBER_HOURS : TTL_HOURS), ip ?? null, userAgent ?? null]
  )
  return raw
}

/** The user behind a session id, or null if it is unknown, expired or revoked. */
export async function resolveSession(raw) {
  if (!raw) return null

  const row = await pg.get(
    `SELECT s.id AS sid, s.expires_at, u.id, u.email, u.name, u.role, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`,
    [hash(raw)]
  )

  if (!row) return null
  // A suspended or disabled account loses access without needing a logout.
  if (row.status !== 'active') return null

  await pg.run(`UPDATE sessions SET last_seen_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`, [row.sid])

  return { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status }
}

export async function revokeSession(raw) {
  if (!raw) return
  await pg.run(`UPDATE sessions SET revoked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`, [hash(raw)])
}

/**
 * Used when an admin suspends or deletes someone mid-session.
 *
 * `keepRaw` spares one session — the caller's own — so that changing your own
 * password does not sign you out of the tab you are changing it in. Every other
 * device holding that account still gets cut off, which is the point.
 */
export async function revokeAllForUser(userId, keepRaw = null) {
  if (keepRaw) {
    await pg.run(
      `UPDATE sessions SET revoked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE user_id = ? AND revoked_at IS NULL AND id != ?`,
      [userId, hash(keepRaw)]
    )
    return
  }
  await pg.run(
    `UPDATE sessions SET revoked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      WHERE user_id = ? AND revoked_at IS NULL`,
    [userId]
  )
}

export async function purgeExpiredSessions() {
  const { changes } = await pg.run(
    `DELETE FROM sessions WHERE expires_at < to_char(now() - interval '7 days', 'YYYY-MM-DD HH24:MI:SS')`
  )
  return changes
}

/**
 * Cookie flags. `secure` is on unless explicitly disabled for local http —
 * production must serve over HTTPS or the cookie will not be sent.
 */
export function sessionCookie(raw, { remember = false } = {}) {
  const secure = process.env.COOKIE_INSECURE === '1' ? '' : ' Secure;'
  // Kept in step with the row's expires_at, or the browser would keep sending a
  // cookie the server has already stopped honouring.
  const maxAge = (remember ? REMEMBER_HOURS : TTL_HOURS) * 3600
  return `${COOKIE_NAME}=${raw}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`
}

export function clearedCookie() {
  const secure = process.env.COOKIE_INSECURE === '1' ? '' : ' Secure;'
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`
}

/**
 * Minimal cookie reader. Only one cookie is ever needed, so this avoids adding
 * cookie-parser as a dependency.
 */
export function readCookie(req, name) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}
