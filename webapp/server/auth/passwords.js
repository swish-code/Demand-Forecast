import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
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

/** Constant-time verify. Returns false rather than throwing on a malformed hash. */
export async function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$')
    if (scheme !== 'scrypt') return false

    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const actual = await scrypt(plain, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** A readable one-time password for seeded or admin-reset accounts. */
export function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(length)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}
