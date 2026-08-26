import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

/**
 * Password hashing with scrypt from node:crypto.
 *
 * scrypt is a memory-hard KDF in the same class as bcrypt and argon2, and is on
 * OWASP's recommended list. It is used here in preference to the bcrypt package
 * because it needs no dependency and no native build — the app must keep
 * starting from a plain `npm run dev` on Windows.
 *
 * Stored format: scrypt$N$r$p$saltB64$hashB64 — parameters travel with the hash,
 * so they can be raised later without invalidating existing passwords.
 */
const PARAMS = { N: 16384, r: 8, p: 1, keyLen: 32 }

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 10) {
    throw new Error('Password must be at least 10 characters')
  }
  const salt = randomBytes(16)
  const key = await scrypt(plain, salt, PARAMS.keyLen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  })
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$')
}

/*
 * There is no verify, on purpose.
 *
 * Sign-in is Microsoft, so nothing in the app compares a password against
 * this column any more. What remains is hashing, and only so the NOT NULL
 * column can be filled with a value nobody holds — a hash of a random string
 * rather than a blank or the same placeholder on every account.
 *
 * Deleting the comparison rather than leaving it unused is the point: an
 * unused verifier is one route away from being a way in again.
 */

/** A readable one-time password for seeded or admin-reset accounts. */
export function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(length)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}
