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

async function request(method, path, body) {
  let res
  try {
    res = await fetch(
      `/api${path}`,
      method === 'GET'
        ? undefined
        : {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          }
    )
  } catch {
    // fetch rejects only when the request never reached a server at all.
    throw unreachable(UNREACHABLE_TEXT)
  }

  const json = await res.json().catch(() => null)

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('df:unauthorized'))
    throw new UnauthorizedError(json?.error || 'Session expired')
  }
  if (!res.ok) {
    if (json?.error) throw new Error(json.error)
    if (UNREACHABLE.has(res.status)) throw unreachable(`${UNREACHABLE_TEXT} (${res.status})`)
    throw new Error(`Request failed (${res.status})`)
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
async function read(method, path, body) {
  try {
    return await request(method, path, body)
  } catch (err) {
    if (!err.retryable) throw err
    await new Promise((r) => setTimeout(r, 900))
    return request(method, path, body)
  }
}

/** Reads a JSON endpoint, routing an expired session back to the login screen. */
const get = (path) => read('GET', path)

/** POST/PATCH/DELETE share one path so they share one set of error rules. */
const send = (method, path, body) => request(method, path, body)

const post = (path, body) => send('POST', path, body)

/** The report queries: reads, whatever verb carries their filters. */
const query = (path, body) => read('POST', path, body)

export const api = {
  me: async () => {
    const res = await fetch('/api/auth/me')
    if (res.status === 401) return null
    if (!res.ok) throw new Error(`Could not read session (${res.status})`)
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
  slicers: (filters) => query('/slicers', filters),
  summary: (filters) => query('/summary', filters),
  context: (filters) => query('/context', filters),
  productLevel: (filters) => query('/product-level', filters),
  componentLevel: (filters) => query('/component-level', filters),
  productionPlan: (filters) => query('/production-plan', filters),
  // Tomorrow's totals without tomorrow's rows, for the Overview card.
  productionPlanKpis: (filters) => query('/production-plan/kpis', filters),
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
