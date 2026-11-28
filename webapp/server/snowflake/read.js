/**
 * Snowflake, READ-ONLY - 25 Nov 2026.
 *
 * Added for the BBT and Yelo PM theoretical, which now takes its SALES from the
 * Foodics data in Snowflake (AIRBYTE_FOODICS) instead of from Power BI - see
 * `snowflake/foodicsSales.js`. The other Snowflake connection in this app,
 * `costing/snowflake.js`, writes the costing page's records; this one only
 * ever reads, and is kept separate so it cannot be used to write.
 *
 * READ-ONLY THREE WAYS
 *
 *   1. The ROLE. Every session runs as SNOWFLAKE_READ_ROLE (POWERBI_ROLE by
 *      default), which on 25 Nov 2026 was granted, with the owner's approval,
 *      exactly: USAGE on schemas AIRBYTE_FOODICS.AIRBYTE_BBT and .AIRBYTE_YELO,
 *      and SELECT on their V_ORDER_PRODUCTS_COMBINED views and BRANCHES tables.
 *      Checked: it is refused every other table, including the MC copy.
 *   2. SECONDARY ROLES OFF. Snowflake otherwise lets a session borrow the
 *      user's other roles (here SYSADMIN) in the background. Every statement
 *      is preceded by USE SECONDARY ROLES NONE on the same session.
 *   3. THE CODE. Anything that is not a single SELECT / WITH is refused here,
 *      before it reaches Snowflake.
 *
 * One gap, stated: the role can create TEMPORARY tables (a PUBLIC default on
 * the schema). They vanish with the session and cannot touch existing data,
 * and (3) means this module never issues one.
 *
 * SETTINGS (server .env). The login is the existing SNOWFLAKE_ACCOUNT /
 * SNOWFLAKE_USER(NAME) / SNOWFLAKE_PASSWORD (or key pair); these override:
 *
 *   SNOWFLAKE_READ_ROLE        default POWERBI_ROLE
 *   SNOWFLAKE_READ_WAREHOUSE   default AIRBYTE_WAREHOUSE (the role may use it)
 */
import fs from 'node:fs'
import snowflakeSdk from 'snowflake-sdk'

const snowflake = snowflakeSdk.default ?? snowflakeSdk
snowflake.configure({ logLevel: 'ERROR' })

const env = (k) => String(process.env[k] ?? '').trim()
const envUser = () => env('SNOWFLAKE_USERNAME') || env('SNOWFLAKE_USER')
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/

export const readRole = () => env('SNOWFLAKE_READ_ROLE') || 'POWERBI_ROLE'
const readWarehouse = () => env('SNOWFLAKE_READ_WAREHOUSE') || 'AIRBYTE_WAREHOUSE'

/** Which settings are missing for the read connection - empty means ready. */
export function snowflakeReadMissing() {
  const missing = []
  if (!env('SNOWFLAKE_ACCOUNT')) missing.push('SNOWFLAKE_ACCOUNT')
  if (!envUser()) missing.push('SNOWFLAKE_USERNAME or SNOWFLAKE_USER')
  if (!env('SNOWFLAKE_PASSWORD') && !env('SNOWFLAKE_PRIVATE_KEY_PATH')) {
    missing.push('SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY_PATH')
  }
  if (!IDENT.test(readRole())) missing.push('SNOWFLAKE_READ_ROLE (must be a plain identifier)')
  if (!IDENT.test(readWarehouse())) missing.push('SNOWFLAKE_READ_WAREHOUSE (must be a plain identifier)')
  return missing
}

export const snowflakeReadConfigured = () => snowflakeReadMissing().length === 0

let pool = null

function getPool() {
  if (!snowflakeReadConfigured()) {
    throw new Error(`Snowflake (read) is not configured: ${snowflakeReadMissing().join(', ')}`)
  }
  if (!pool) {
    const opts = {
      account: env('SNOWFLAKE_ACCOUNT'),
      username: envUser(),
      role: readRole(),
      warehouse: readWarehouse(),
      application: 'SWiSH_DemandForecast_read',
      clientSessionKeepAlive: true,
    }
    if (env('SNOWFLAKE_PRIVATE_KEY_PATH')) {
      opts.authenticator = 'SNOWFLAKE_JWT'
      opts.privateKeyPath = env('SNOWFLAKE_PRIVATE_KEY_PATH')
      if (env('SNOWFLAKE_PRIVATE_KEY_PASS')) opts.privateKeyPass = env('SNOWFLAKE_PRIVATE_KEY_PASS')
      if (!fs.existsSync(opts.privateKeyPath)) {
        throw new Error(`SNOWFLAKE_PRIVATE_KEY_PATH does not exist: ${opts.privateKeyPath}`)
      }
    } else {
      opts.password = env('SNOWFLAKE_PASSWORD')
    }
    pool = snowflake.createPool(opts, { max: 3, min: 0, evictionRunIntervalMillis: 60_000 })
  }
  return pool
}

function exec(conn, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => {
        if (err) {
          err.sql = sqlText.slice(0, 200)
          reject(err)
        } else resolve(rows ?? [])
      },
    })
  })
}

/** True for one SELECT / WITH statement and nothing else. */
export function isSingleSelect(sql) {
  const s = String(sql ?? '').trim().replace(/;\s*$/, '')
  if (!/^(select|with)\b/i.test(s)) return false
  // A second statement would need a semicolon outside a string literal.
  const outside = s.replace(/'(?:[^']|'')*'/g, "''")
  return !outside.includes(';')
}

/**
 * Run one SELECT under the read role, secondary roles off. Resolves to plain
 * row objects keyed by upper-case column name.
 */
export async function sfSelect(sql, binds = []) {
  if (!isSingleSelect(sql)) throw new Error('Snowflake reads are a single SELECT only')
  return getPool().use(async (conn) => {
    await exec(conn, 'USE SECONDARY ROLES NONE')
    return exec(conn, sql, binds)
  })
}
