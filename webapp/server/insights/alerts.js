import { pg } from '../db/accounts.js'

/**
 * Operational alerts: things that went wrong while the app was running, as
 * opposed to the daily digest, which is about what the forecast says.
 *
 * The distinction matters. "Accuracy fell 8pp" is a business finding and
 * belongs in the morning message. "Power BI refused three queries" and "the
 * store report failed to send" are faults — nobody chose them, and they stay on
 * screen until somebody clears them.
 *
 * Repeats are folded into one row with a count rather than appended, so a
 * failure looping every thirty seconds produces one alert saying "×214"
 * instead of burying everything else.
 */

export const SOURCES = {
  powerbi: 'Power BI',
  email: 'Email',
  digest: 'Daily digest',
  auth: 'Sign-in',
  app: 'Application',
}

/**
 * Which keys currently have an open alert.
 *
 * Held in memory so the common case — a request that worked — costs a Set
 * lookup rather than a database round trip. Seeded from the table on first use
 * and after any resolve, so a restart does not lose track of what is open.
 */
let openKeyCache = new Set()

/**
 * Seeded once at boot, kept in memory afterwards.
 *
 * Deliberately not read on demand: isOpen() is called from ordinary request
 * paths that are not async, and a database round trip there would have meant
 * making a dozen callers asynchronous to answer a question the process already
 * knows the answer to.
 */
export async function loadOpenAlerts() {
  const rows = await pg.all('SELECT key FROM alerts WHERE resolved_at IS NULL')
  openKeyCache = new Set(rows.map((r) => r.key))
  return openKeyCache.size
}

function openKeys() {
  return openKeyCache
}

/** True when this key has an unresolved alert against it. */
export function isOpen(key) {
  return openKeys().has(key)
}

/**
 * Records a fault.
 *
 * `key` is what makes two occurrences "the same alert" — include the brand or
 * the recipient, but never a timestamp or a row count, or nothing will ever
 * fold together.
 */
export function raise({ source, key, severity = 'warning', title, detail = null }) {
  // The cache is updated first and synchronously, so isOpen() is right the
  // instant this returns even though the row is still being written.
  openKeys().add(key)

  return (async () => {
    const existing = await pg.get(
      `SELECT id, count FROM alerts WHERE key = ? AND resolved_at IS NULL`,
      [key]
    )

    if (existing) {
      await pg.run(
        `UPDATE alerts
            SET count = count + 1,
                last_seen_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
                severity = ?,
                title = ?,
                detail = ?
          WHERE id = ?`,
        [severity, title, detail, existing.id]
      )
      return existing.id
    }

    const { rows } = await pg.run(
      `INSERT INTO alerts (source, key, severity, title, detail)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [source, key, severity, title, detail]
    )
    return rows[0]?.id ?? null
  })().catch((err) => {
    // An alert that cannot be recorded must not break whatever raised it.
    console.warn(`  [alerts] could not record "${key}" (${err.message})`)
    return null
  })
}

/** Clears an alert because the underlying thing started working again. */
export function clear(key) {
  openKeys().delete(key)
  return pg
    .run(`UPDATE alerts SET resolved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE key = ? AND resolved_at IS NULL`, [key])
    .then((r) => r.changes)
    .catch((err) => {
      console.warn(`  [alerts] could not clear "${key}" (${err.message})`)
      return 0
    })
}

export function openAlerts(limit = 50) {
  return pg.all(
    `SELECT a.*, u.name AS resolved_by_name, u.email AS resolved_by_email
       FROM alerts a
       LEFT JOIN users u ON u.id = a.resolved_by
      WHERE a.resolved_at IS NULL
      ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
               a.last_seen_at DESC
      LIMIT ?`,
    [limit]
  )
}

export function recentlyResolved(limit = 10) {
  return pg.all(
    `SELECT a.*, u.name AS resolved_by_name, u.email AS resolved_by_email
       FROM alerts a
       LEFT JOIN users u ON u.id = a.resolved_by
      WHERE a.resolved_at IS NOT NULL
      ORDER BY a.resolved_at DESC
      LIMIT ?`,
    [limit]
  )
}

/** Dismissed by a person, who is recorded — a fault should not vanish namelessly. */
export async function resolve(id, userId) {
  const { changes } = await pg.run(
    `UPDATE alerts SET resolved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), resolved_by = ?
      WHERE id = ? AND resolved_at IS NULL`,
    [userId, id]
  )
  // A person cleared something; reseed rather than guess which key it was.
  await loadOpenAlerts()
  return changes
}

export async function resolveAll(userId) {
  const { changes } = await pg.run(
    `UPDATE alerts SET resolved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), resolved_by = ? WHERE resolved_at IS NULL`,
    [userId]
  )
  await loadOpenAlerts()
  return changes
}
