import { config } from '../config.js'
import { getAccessToken } from './auth.js'
import { HttpError } from './errors.js'

/**
 * Run one DAX query against the BBT semantic model.
 *
 * The Power BI REST API accepts only one query per executeQueries request, so
 * callers that need several should Promise.all them - each is independently
 * cached upstream in cache.js. Under that concurrency Power BI intermittently
 * answers 500 "An error has occurred", so transient statuses are retried.
 *
 * @param {string} dax        a complete EVALUATE statement
 * @param {string} datasetId  which brand's semantic model to run it against
 * @returns {Promise<object[]>} rows with friendly keys (see normalizeRows)
 */
/** Power BI occasionally returns these under concurrent load; they retry cleanly. */
const TRANSIENT = new Set([429, 500, 502, 503, 504])
// A fourth attempt, and longer gaps: a throttle that clears in ten seconds
// should not cost the page its data.
const RETRY_DELAYS = [600, 1800, 4500, 9000]

/** No response at all: DNS, TCP, TLS or a socket that died mid-flight. */
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

/**
 * Bounds on how long one query may take.
 *
 * A healthy query against any of the nine models answers in about 300ms, so
 * these are generous. They exist because this network stalls intermittently —
 * whole loads have hung, at every concurrency level, on every model, which
 * points at the connection rather than at Power BI.
 *
 * The deadline is the important one. Per-attempt timeouts alone multiply: four
 * attempts at twelve seconds each, plus backoff, let a single stalled query
 * hold a page for over a minute. Capping the *total* time a query may consume
 * turns that into a bounded twenty seconds, after which the page says plainly
 * that Power BI could not be reached instead of appearing frozen.
 */
/**
 * Eight seconds is right for a query somebody is waiting on: past that, an
 * error they can retry beats a spinner. It is wrong for a bulk extract, which
 * legitimately takes half a minute to return forty thousand rows — so callers
 * doing that pass their own.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.PBI_TIMEOUT_MS) || 8_000
const BULK_TIMEOUT_MS = Number(process.env.PBI_BULK_TIMEOUT_MS) || 90_000
const REQUEST_DEADLINE_MS = Number(process.env.PBI_DEADLINE_MS) || 20_000

/**
 * Throttling gets its own, larger budget.
 *
 * The deadline above exists to bound a *hang*. A 429 is not a hang — it is the
 * service telling us exactly how long to wait, and giving up on that
 * instruction because a hang-budget expired is how a page that would have
 * loaded fine ends up showing "Power BI throttled the request". Waiting is the
 * correct response to being asked to wait.
 */
const THROTTLE_DEADLINE_MS = Number(process.env.PBI_THROTTLE_DEADLINE_MS) || 75_000

/** `fetch` buries the real reason one or two levels down in `cause`. */
function causeChain(err) {
  const out = []
  let e = err
  for (let depth = 0; e && depth < 5; depth++) {
    if (e.code) out.push(e.code)
    e = e.cause
  }
  return out
}

/**
 * Whether another attempt is worth making.
 *
 * This used to test `TRANSIENT.has(err.status)` alone, which quietly meant no
 * network failure was ever retried: `fetch` rejects with a TypeError carrying
 * no status, so a single dropped socket failed a whole page that a 600ms retry
 * would have fixed.
 */
/**
 * Power BI reports some transient conditions as 400 rather than 429.
 *
 * "The operation was throttled by Power BI because the server is under memory
 * pressure. Please try again later." arrives as a Bad Request, which is exactly
 * what it is not — the query was fine and the same query succeeds a minute
 * later. Left unretried it fails a page for a reason that has already passed.
 */
const TRANSIENT_TEXT = /throttled|memory pressure|try again later|temporarily unavailable|timeout/i

function isRetryable(err) {
  if (TRANSIENT.has(err.status)) return true
  if (err.status === 400 && TRANSIENT_TEXT.test(err.message ?? '')) return true
  if (err.status) return false // a real HTTP answer we have already classified
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
  return causeChain(err).some((code) => NETWORK_CODES.has(code)) || err.name === 'TypeError'
}

/** Something a person can act on, instead of the bare "fetch failed". */
function describeNetworkError(err, attempts) {
  const codes = causeChain(err)
  const code = codes[codes.length - 1] ?? codes[0]
  const detail =
    err.name === 'TimeoutError'
      ? `it did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? 'the address could not be resolved — check DNS or the network connection'
        : code === 'ECONNRESET'
          ? 'the connection was reset mid-request'
          : code === 'UND_ERR_CONNECT_TIMEOUT'
            ? 'the connection could not be established'
            : code
              ? `the connection failed (${code})`
              : 'the connection failed'
  return `Could not reach Power BI — ${detail}. Tried ${attempts} time${attempts === 1 ? '' : 's'}.`
}

/**
 * Power BI rate-limits executeQueries per capacity, and a page load fans out
 * several queries per selected brand. Without a cap those all land together and
 * the whole page fails with 429.
 *
 * Eight, raised from three once nine brands became selectable: that is 45
 * queries a load, and a gate of three serialised them into fifteen rounds.
 * Sweeping 3 to 16 against the live capacity produced no throttling at any
 * level, so this is set to the point where the gate stops being the limit
 * rather than to the point where the service complains.
 */
const MAX_IN_FLIGHT = Number(process.env.PBI_MAX_CONCURRENCY) || 8
const MIN_IN_FLIGHT = 2

/**
 * The gate adapts rather than sitting at a fixed number.
 *
 * A fixed limit cannot be right: the capacity's spare headroom depends on what
 * else is running on it, so a number that sweeps cleanly on a quiet afternoon
 * throttles at nine brands on a busy one. On a 429 the gate halves; after a run
 * of clean responses it creeps back up one at a time.
 *
 * Halve down, step up — the usual asymmetry. Backing off has to be immediate
 * because the service is already unhappy; recovering has to be gradual or it
 * just walks back into the wall.
 */
let limit = MAX_IN_FLIGHT
let inFlight = 0
let cleanRun = 0
const waiting = []

function throttled() {
  limit = Math.max(MIN_IN_FLIGHT, Math.floor(limit / 2))
  cleanRun = 0
}

function succeeded() {
  if (limit >= MAX_IN_FLIGHT) return
  cleanRun++
  // Twenty clean responses before widening, so one lucky answer does not undo
  // a back-off that was correct.
  if (cleanRun >= 20) {
    limit++
    cleanRun = 0
  }
}

function acquire() {
  if (inFlight < limit) {
    inFlight++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function release() {
  // Only hand the slot on if the gate has not narrowed underneath us.
  if (inFlight <= limit && waiting.length) {
    waiting.shift()()
    return
  }
  inFlight--
  if (inFlight < limit && waiting.length) {
    inFlight++
    waiting.shift()()
  }
}

/** For diagnostics: what the gate has settled on. */
export const concurrency = () => ({ limit, inFlight, waiting: waiting.length })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function executeQuery(dax, datasetId, { bulk = false } = {}) {
  await acquire()
  try {
    let lastError
    const started = Date.now()

    // Retries are bounded by time, not by a fixed count. A throttle that lasts
    // twenty-five seconds needs more than four attempts two seconds apart, and
    // stopping early there is exactly how a page that would have loaded fine
    // ends up showing "Power BI throttled the request".
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await runQuery(dax, datasetId, bulk)
        succeeded()
        return rows
      } catch (err) {
        lastError = err
        // A memory-pressure 400 means the capacity is struggling just as much
        // as a 429 does, so it narrows the gate and gets the longer budget.
        const overloaded =
          err.status === 429 || (err.status === 400 && TRANSIENT_TEXT.test(err.message ?? ''))
        if (overloaded) throttled()

        const budget = overloaded
          ? THROTTLE_DEADLINE_MS
          : bulk
            ? BULK_TIMEOUT_MS * 3
            : REQUEST_DEADLINE_MS
        const wait = err.retryAfterMs ?? RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]
        const spent = Date.now() - started

        if (!isRetryable(err) || spent + wait >= budget) {
          // Rewrite transport failures on the way out: "fetch failed" tells
          // nobody anything, and this error is shown to end users.
          if (!err.status) {
            throw new HttpError(503, describeNetworkError(err, attempt + 1), { cause: err })
          }
          throw err
        }

        // Logged because a slow page is otherwise indistinguishable from a
        // broken one, and this is the difference an operator needs to see.
        console.warn(
          `  [pbi] ${err.status === 429 ? 'throttled' : 'retrying'} attempt ${attempt + 1}, waiting ${wait}ms` +
            `${err.status ? ` (${err.status})` : ` (${err.message.slice(0, 60)})`} · gate ${limit}`
        )
        await sleep(wait)
      }
    }
  } finally {
    release()
  }
}

async function runQuery(dax, datasetId, bulk = false) {
  const token = await getAccessToken()
  const { workspaceId } = config.pbi
  const url = `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/datasets/${datasetId}/executeQueries`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      queries: [{ query: dax }],
      serializerSettings: { includeNulls: true },
    }),
    signal: AbortSignal.timeout(bulk ? BULK_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
  })

  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new HttpError(res.status || 502, `Power BI returned a non-JSON response: ${text.slice(0, 400)}`)
  }

  if (!res.ok) {
    const err = new HttpError(res.status, describeError(res.status, json), { dax })
    const retryAfter = Number(res.headers.get('retry-after'))
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000
    throw err
  }

  const rows = json?.results?.[0]?.tables?.[0]?.rows ?? []
  return normalizeRows(rows)
}

/**
 * Power BI returns column keys as "Table[Column]" or "[Measure]". Strip them
 * down to the bare name so the client sees Actual_Qty, LocationID, Date, etc.
 * Names that collide across tables keep their table prefix.
 */
export function normalizeRows(rows) {
  if (!rows.length) return []

  const keys = Object.keys(rows[0])
  const shortOf = (k) => {
    const match = /\[([^\]]+)\]\s*$/.exec(k)
    return match ? match[1] : k
  }
  const counts = {}
  for (const k of keys) {
    const s = shortOf(k)
    counts[s] = (counts[s] || 0) + 1
  }
  const rename = {}
  for (const k of keys) {
    const s = shortOf(k)
    rename[k] = counts[s] === 1 ? s : k
  }

  return rows.map((row) => {
    const out = {}
    for (const k of keys) out[rename[k]] = row[k]
    return out
  })
}

function describeError(status, json) {
  const detail =
    json?.error?.['pbi.error']?.details?.[0]?.detail?.value ||
    json?.error?.message ||
    json?.Message ||
    'unknown error'

  if (status === 401) {
    return `Power BI rejected the token (401). Check PBI_CLIENT_ID/PBI_CLIENT_SECRET and that the service principal has access to the workspace. Detail: ${detail}`
  }
  if (status === 403) {
    return `Power BI denied the request (403). The service principal needs Member/Contributor on the workspace, and the tenant settings "Service principals can use Fabric APIs" plus "Dataset Execute Queries REST API" must be enabled. Detail: ${detail}`
  }
  if (status === 404) {
    return `Semantic model not found (404). Check PBI_WORKSPACE_ID and PBI_DATASET_ID. Detail: ${detail}`
  }
  if (status === 429) {
    return `Power BI throttled the request (429). It should clear on its own — press Retry. Raise CACHE_TTL or lower PBI_MAX_CONCURRENCY in .env if it keeps happening. Detail: ${detail}`
  }
  return `Power BI query failed (${status}): ${detail}`
}
