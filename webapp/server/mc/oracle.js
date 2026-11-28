/**
 * MC's Oracle database, read live. SELECT only.
 *
 * Added 24 Nov 2026 for the "Why they differ" tab of Variance Analysis - see
 * `insights/theoreticalDrivers.js` for what is read and why. Thin mode: the
 * driver speaks Oracle's protocol itself, so the server needs no Oracle client
 * installed, which matters for wherever IT hosts it.
 *
 * One small pool, opened on first use. MC is the business's live stock system,
 * so four connections at most: this page must never be the thing that slows
 * the outlets' own stock counts down.
 */
import oracledb from 'oracledb'
import { config, missingMcOracle } from '../config.js'

let poolPromise = null

/** The schema is spliced into ALTER SESSION, so it must be a bare identifier. */
const safeSchema = () => {
  const s = String(config.mcOracle.schema || '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(s)) throw new Error(`MC_ORACLE_SCHEMA "${s}" is not a valid schema name`)
  return s
}

function pool() {
  if (!poolPromise) {
    const schema = safeSchema()
    poolPromise = oracledb
      .createPool({
        user: config.mcOracle.user,
        password: config.mcOracle.password,
        connectString: config.mcOracle.connectString,
        poolMin: 0,
        poolMax: 4,
        poolIncrement: 1,
        poolTimeout: 300,
        /*
         * A keepalive every minute. MC's till and daily-total reads run for two
         * minutes or more with nothing on the wire, and on 24 Nov 2026 a read
         * that long came back "ORA-17008: Closed connection" - the signature
         * of something in between dropping a quiet connection.
         */
        expireTime: 1,
        callTimeout: 10 * 60 * 1000,
        // Every connection reads MC's tables unqualified, as MC's own SQL does.
        sessionCallback: (conn, _tag, done) => {
          conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${schema}`).then(() => done(), done)
        },
      })
      .catch((err) => {
        // A failed pool must not be cached, or one bad start blocks every retry.
        poolPromise = null
        throw err
      })
  }
  return poolPromise
}

/** True when every connection setting is present. */
export const mcOracleConfigured = () => missingMcOracle().length === 0

/**
 * Run one SELECT and return plain objects keyed by upper-case column name.
 *
 * Refuses anything that is not a SELECT, so a mistake in this codebase cannot
 * become a write to the stock system.
 */
export async function mcSelect(sql, binds = {}) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('MC reads are SELECT only')
  if (!mcOracleConfigured()) throw new Error(`MC Oracle is not configured: ${missingMcOracle().join(', ')}`)
  const p = await pool()
  const conn = await p.getConnection()
  try {
    const res = await conn.execute(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchArraySize: 5000,
      maxRows: 0,
    })
    return res.rows ?? []
  } finally {
    await conn.close().catch(() => {})
  }
}

/**
 * Split a list into IN-list chunks. Oracle allows 1,000 expressions per IN.
 */
export function chunks(list, size = 900) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Integer ids, written inline into an IN list - only after this check. */
export function intList(ids) {
  const clean = [...new Set([...ids].map((x) => String(x).trim()))].filter((x) => /^\d{1,18}$/.test(x))
  return clean
}
