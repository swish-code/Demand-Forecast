import { pg } from './accounts.js'
import { generatePassword, hashPassword } from '../auth/passwords.js'

/**
 * Make sure somebody can get in to a fresh install.
 *
 * This used to create an administrator with a printed password. Sign-in is
 * Microsoft now, so there is no password to print and nothing useful to hand
 * over — what a fresh deployment needs instead is a row saying "this address is
 * an administrator", waiting for the person to sign in against it.
 *
 * ADMIN_EMAILS is the list. It is also read at sign-in, so an address named
 * there is activated as an administrator whether or not this ever ran — this
 * only means the row is already sitting in the users table beforehand, which is
 * the difference between an admin page that looks empty on day one and one that
 * does not.
 *
 * Only ever on an empty table, so it cannot resurrect an account somebody
 * deliberately removed.
 */
export async function seedFirstAdmin() {
  const { count } = (await pg.get('SELECT COUNT(*)::int AS count FROM users')) ?? { count: 0 }
  if (count > 0) return null

  const listed = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)

  if (!listed.length) return null

  for (const email of listed) {
    // The column is NOT NULL and nothing will ever check it, so it takes a
    // value nobody holds rather than a blank or a shared placeholder.
    await pg.run(
      `INSERT INTO users (email, name, password_hash, role, status, auth_provider)
       VALUES (?, 'Administrator', ?, 'admin', 'active', 'microsoft')`,
      [email, await hashPassword(generatePassword())]
    )
  }

  return { admins: listed }
}
