import { db } from './index.js'
import { generatePassword, hashPassword } from '../auth/passwords.js'

/**
 * Create the first admin if the users table is empty, so a fresh install is
 * reachable without hand-editing the database.
 *
 * Set ADMIN_EMAIL and ADMIN_PASSWORD in .env to choose the credentials.
 * Without ADMIN_PASSWORD a strong one is generated and printed ONCE — it is
 * never stored in plain text, so it cannot be recovered afterwards.
 */
export async function seedFirstAdmin() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get()
  if (count > 0) return null

  const email = process.env.ADMIN_EMAIL || 'admin@swishhh.net'
  const password = process.env.ADMIN_PASSWORD || generatePassword()
  const generated = !process.env.ADMIN_PASSWORD

  db.prepare(
    `INSERT INTO users (email, name, password_hash, role, status)
     VALUES (?, ?, ?, 'admin', 'active')`
  ).run(email, 'Administrator', await hashPassword(password))

  return { email, password, generated }
}
