/**
 * Raised when the session has gone (expired, revoked, or an admin suspended the
 * account). The shell listens for this and returns to the login screen instead
 * of showing a generic error.
 */
export class UnauthorizedError extends Error {}

/*
 * Telling "the server broke" apart from "the server was not there".
 *
 * The API answers a fault with {"error": "..."} and the message goes on screen.
 * Nothing answers at all when the server is between restarts — in development
 * the dev proxy replies 500 with a plain-text body, in production the platform
 * replies 502 or 503, and a dropped connection makes fetch reject outright.
 * All three used to arrive as the bare "Request failed (500)", which reads as a
 * fault in the data somebody has just selected and sends them looking in
 * entirely the wrong place.
 *
 * So a response with no error field in it is reported as what it is, and marked
 * for one retry.
 */
const UNREACHABLE = new Set([500, 502, 503, 504])
const UNREACHABLE_TEXT =
  'The server is not responding — it may be restarting. Press Retry in a moment.'

function unreachable(message) {
  const err = new Error(message)
  err.retryable = true
  return err
}

/**
 * What went wrong, in the console, in enough detail to act on.
 *
 * The banner on screen carries one sentence, which is right for the reader and
 * useless for anybody diagnosing it: it names neither the endpoint, nor the
 * status, nor the filters that produced it. Pressing F12 should answer "what
 * broke and with what" without having to reproduce anything.
 *
 * Grouped and collapsed so a page with three failing calls is three lines
 * until one is opened, and timed so a slow failure can be told from a fast one.
 */
function logFailure({ method, path, status, error, body, ms }) {
  /* eslint-disable no-console */
  try {
    console.groupCollapsed(
      `%c[API]%c ${method} /api${path} %c${status ?? 'network'}%c — ${error?.message ?? error}`,
      'color:#fff;background:#b3243f;padding:1px 5px;border-radius:3px',
      'font-weight:600',
      'color:#b3243f;font-weight:700',
      'color:inherit;font-weight:400'
    )
    console.log('endpoint   ', `${method} /api${path}`)
    console.log('status     ', status ?? '(no response — server unreachable)')
    console.log('took       ', `${ms} ms`)
    console.log('message    ', error?.message ?? String(error))
    if (body && typeof body === 'object') {
      console.log('brands     ', body.brands ?? '(none)')
      console.log('dates      ', body.dateFrom || body.dateTo ? `${body.dateFrom} .. ${body.dateTo}` : '(none)')
      const slicers = ['locations', 'products', 'articles', 'items', 'nodeTypes', 'prepStatus']
        .filter((k) => body[k]?.length)
        .map((k) => `${k}=${body[k].length}`)
      console.log('slicers    ', slicers.length ? slicers.join(' · ') : '(none)')
      console.log('full body  ', body)
    }
    if (error?.stack) console.log('stack      ', error.stack)
    console.log('what next  ', 'Check the server console for the matching [api] line, or webapp/data/error.log')
    console.groupEnd()
  } catch {
    /* a console that refuses must not break the request path */
  }
  /* eslint-enable no-console */
}

/*
 * Anything that escapes entirely still gets named.
 *
 * A render error or a stray rejection otherwise reaches the console as a bare
 * stack with no indication that it came from this application at all.
 */
if (typeof window !== 'undefined' && !window.__dfErrorHooks) {
  window.__dfErrorHooks = true
  window.addEventListener('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[app] uncaught error', { message: e.message, source: e.filename, line: e.lineno, error: e.error })
  })
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason?.name === 'AbortError') return // a superseded request, not a fault
    // eslint-disable-next-line no-console
    console.error('[app] unhandled promise rejection', e.reason)
  })
}

async function request(method, path, body, { signal } = {}) {
  const started = Date.now()
  let res
  try {
    res = await fetch(
      `/api${path}`,
      method === 'GET' && !signal
        ? undefined
        : {
            method,
            signal,
            ...(method === 'GET'
              ? {}
              : {
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body ?? {}),
                }),
          }
    )
  } catch (err) {
    // A caller that walked away is not a failure to report — the effect that
    // started this has already been replaced by a newer one.
    if (err?.name === 'AbortError') throw err
    // fetch rejects only when the request never reached a server at all.
    logFailure({ method, path, status: null, error: err, body, ms: Date.now() - started })
    throw unreachable(UNREACHABLE_TEXT)
  }

  const json = await res.json().catch(() => null)

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('df:unauthorized'))
    throw new UnauthorizedError(json?.error || 'Session expired')
  }
  if (!res.ok) {
    const err = json?.error
      ? new Error(json.error)
      : UNREACHABLE.has(res.status)
        ? unreachable(`${UNREACHABLE_TEXT} (${res.status})`)
        : new Error(`Request failed (${res.status})`)
    logFailure({ method, path, status: res.status, error: err, body, ms: Date.now() - started })
    throw err
  }
  return json ?? {}
}

/**
 * One retry, for reads only.
 *
 * A restart takes a second or two, and a page that fails for the whole of it
 * makes the reader press Retry for something they did not cause. Reads are safe
 * to repeat; writes are not, so they go through `send` and fail on the spot
 * rather than risk sending an email or creating a user twice.
 */
async function read(method, path, body, options) {
  try {
    return await request(method, path, body, options)
  } catch (err) {
    if (!err.retryable) throw err
    // Not worth retrying something nobody is waiting for any more.
    if (options?.signal?.aborted) throw err
    await new Promise((r) => setTimeout(r, 900))
    return request(method, path, body, options)
  }
}

/** Reads a JSON endpoint, routing an expired session back to the login screen. */
const get = (path) => read('GET', path)

/** POST/PATCH/DELETE share one path so they share one set of error rules. */
const send = (method, path, body) => request(method, path, body)

const post = (path, body) => send('POST', path, body)

/** The report queries: reads, whatever verb carries their filters. */
const query = (path, body, options) => read('POST', path, body, options)

export const api = {
  /*
   * The session check, with a deadline.
   *
   * This is the first request the application makes and nothing renders until
   * it answers, so a request that never answers is a spinner that never stops.
   * That is not hypothetical: the server restarts on every code change and
   * spends a moment opening a two-gigabyte local database before it listens, and
   * anybody who reloads inside that window waited for ever on "Checking your
   * session".
   *
   * Eight seconds, then an error the shell can act on — offering to try again is
   * a far better answer than a spinner, and much better than silently deciding
   * the visitor is signed out when the truth is the server was busy.
   */
  me: async () => {
    let res
    try {
      res = await fetch('/api/auth/me', { signal: AbortSignal.timeout(8000) })
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      // eslint-disable-next-line no-console
      console.error('[app] session check failed', { timedOut, error: err })
      throw unreachable(
        timedOut
          ? 'The server did not answer in time — it may still be starting up.'
          : UNREACHABLE_TEXT
      )
    }
    if (res.status === 401) return null
    if (!res.ok) {
      if (UNREACHABLE.has(res.status)) throw unreachable(`${UNREACHABLE_TEXT} (${res.status})`)
      throw new Error(`Could not read session (${res.status})`)
    }
    return res.json()
  },
  logout: () => post('/auth/logout'),
  brands: async () => {
    const res = await fetch('/api/brands')
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('df:unauthorized'))
      throw new UnauthorizedError('Session expired')
    }
    if (!res.ok) throw new Error(`Could not load brands (${res.status})`)
    return res.json()
  },
  health: async () => {
    const res = await fetch('/api/health')
    if (!res.ok) throw new Error(`Server not reachable (${res.status})`)
    return res.json()
  },
  slicers: (filters, options) => query('/slicers', filters, options),
  summary: (filters, options) => query('/summary', filters, options),
  context: (filters, options) => query('/context', filters, options),
  productLevel: (filters, options) => query('/product-level', filters, options),
  componentLevel: (filters, options) => query('/component-level', filters, options),
  productionPlan: (filters, options) => query('/production-plan', filters, options),
  // Tomorrow's totals without tomorrow's rows, for the Overview card.
  productionPlanKpis: (filters, options) => query('/production-plan/kpis', filters, options),
  clearCache: () => post('/cache/clear'),

  admin: {
    users: () => get('/admin/users'),
    analytics: (days) => get(`/admin/analytics${days ? `?days=${days}` : ''}`),
    audit: () => get('/admin/audit'),
    createUser: (body) => post('/admin/users', body),
    updateUser: (id, body) => send('PATCH', `/admin/users/${id}`, body),
    deleteUser: (id) => send('DELETE', `/admin/users/${id}`),
    insights: () => get('/admin/insights'),
    runInsights: () => post('/admin/insights/run'),
    ackInsights: (day) => post('/admin/insights/ack', { day }),
    alerts: () => get('/admin/alerts'),
    modelReview: (refresh) => get(`/admin/model-review${refresh ? '?refresh=1' : ''}`),
    nonRecipeForecast: (refresh) => get(`/admin/non-recipe-forecast${refresh ? '?refresh=1' : ''}`),
    cube: () => get('/cube'),
    // Deliberately the admin route, not the read-only one: this starts work.
    rebuildCube: () => post('/admin/cube/backfill'),
    emailTransport: () => get('/admin/email/transport'),
    connectMailbox: () => get('/admin/email/mailbox/connect'),
    disconnectMailbox: () => post('/admin/email/mailbox/disconnect'),
    resolveAlert: (id) => post(`/admin/alerts/${id}/resolve`),
    resolveAllAlerts: () => post('/admin/alerts/resolve-all'),
    emailRecipients: () => get('/admin/email/recipients'),
    createRecipient: (body) => post('/admin/email/recipients', body),
    updateRecipient: (id, body) => send('PATCH', `/admin/email/recipients/${id}`, body),
    deleteRecipient: (id) => send('DELETE', `/admin/email/recipients/${id}`),
    // Two calls, same body: without `commit` the server only says what it would do.
    importRecipients: (text, commit = false) => post('/admin/email/recipients/import', { text, commit }),
    setRecipientsActive: (active) => post('/admin/email/recipients/active', { active }),
    emailCheck: () => get('/admin/email/check'),
    sendEmail: (opts) => post('/admin/email/send', opts ?? {}),
  },
}

// --- formatting -------------------------------------------------------------

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export const fmtInt = (v) => (v === null || v === undefined || v === '' ? '–' : nf0.format(Math.round(Number(v))))

export const fmtNum = (v) => (v === null || v === undefined || v === '' ? '–' : nf2.format(Number(v)))

/** Compact axis label: 60000 -> '60k'. */
export const compactInt = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}m`
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k`
  return nf0.format(n)
}

export const fmtPct = (v, digits = 1) =>
  v === null || v === undefined || Number.isNaN(Number(v))
    ? '–'
    : `${(Number(v) * 100).toFixed(digits)}%`

export const fmtSignedPct = (v, digits = 1) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '–'
  const n = Number(v) * 100
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export const fmtDate = (iso) => {
  if (!iso) return '–'
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })
}

export const fmtLongDate = (iso) => {
  if (!iso) return '–'
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** Download an array of row objects as CSV. */
export function downloadCsv(filename, rows, columns) {
  if (!rows?.length) return
  const cols = columns ?? Object.keys(rows[0]).map((key) => ({ key, label: key }))
  const escape = (v) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [
    cols.map((c) => escape(c.label)).join(','),
    ...rows.map((r) => cols.map((c) => escape(r[c.key])).join(',')),
  ].join('\n')

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
