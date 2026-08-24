import { db } from '../db/index.js'

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
let openKeyCache = null

function openKeys() {
  if (!openKeyCache) {
    openKeyCache = new Set(
      db.prepare('SELECT key FROM alerts WHERE resolved_at IS NULL').all().map((r) => r.key)
    )
  }
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
  openKeys().add(key)
  const existing = db
    .prepare(`SELECT id, count FROM alerts WHERE key = ? AND resolved_at IS NULL`)
    .get(key)

  if (existing) {
    db.prepare(
      `UPDATE alerts
          SET count = count + 1,
              last_seen_at = datetime('now'),
              severity = ?,
              title = ?,
              detail = ?
        WHERE id = ?`
    ).run(severity, title, detail, existing.id)
    return existing.id
  }

  const info = db
    .prepare(
      `INSERT INTO alerts (source, key, severity, title, detail)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(source, key, severity, title, detail)
  return Number(info.lastInsertRowid)
}

/** Clears an alert because the underlying thing started working again. */
export function clear(key) {
  openKeys().delete(key)
  return db
    .prepare(`UPDATE alerts SET resolved_at = datetime('now') WHERE key = ? AND resolved_at IS NULL`)
    .run(key).changes
}

export function openAlerts(limit = 50) {
  return db
    .prepare(
      `SELECT a.*, u.name AS resolved_by_name, u.email AS resolved_by_email
         FROM alerts a
         LEFT JOIN users u ON u.id = a.resolved_by
        WHERE a.resolved_at IS NULL
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 a.last_seen_at DESC
        LIMIT ?`
    )
    .all(limit)
}

export function recentlyResolved(limit = 10) {
  return db
    .prepare(
      `SELECT a.*, u.name AS resolved_by_name, u.email AS resolved_by_email
         FROM alerts a
         LEFT JOIN users u ON u.id = a.resolved_by
        WHERE a.resolved_at IS NOT NULL
        ORDER BY a.resolved_at DESC
        LIMIT ?`
    )
    .all(limit)
}

/** Dismissed by a person, who is recorded — a fault should not vanish namelessly. */
export function resolve(id, userId) {
  openKeyCache = null // a person cleared something; reseed rather than guess
  return db
    .prepare(
      `UPDATE alerts SET resolved_at = datetime('now'), resolved_by = ?
        WHERE id = ? AND resolved_at IS NULL`
    )
    .run(userId, id).changes
}

export function resolveAll(userId) {
  openKeyCache = null
  return db
    .prepare(
      `UPDATE alerts SET resolved_at = datetime('now'), resolved_by = ? WHERE resolved_at IS NULL`
    )
    .run(userId).changes
}
