/**
 * Raised when the session has gone (expired, revoked, or an admin suspended the
 * account). The shell listens for this and returns to the login screen instead
 * of showing a generic error.
 */
export class UnauthorizedError extends Error {}

/** Reads a JSON endpoint, routing an expired session back to the login screen. */
async function get(path) {
  const res = await fetch(`/api${path}`)
  const json = await res.json().catch(() => ({}))
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('df:unauthorized'))
    throw new UnauthorizedError(json.error || 'Session expired')
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`)
  return json
}

/** POST/PATCH/DELETE share one path so they share one set of error rules. */
async function send(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const json = await res.json().catch(() => ({}))
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('df:unauthorized'))
    throw new UnauthorizedError(json.error || 'Session expired')
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`)
  return json
}

const post = (path, body) => send('POST', path, body)

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
  slicers: (filters) => post('/slicers', filters),
  summary: (filters) => post('/summary', filters),
  context: (filters) => post('/context', filters),
  productLevel: (filters) => post('/product-level', filters),
  componentLevel: (filters) => post('/component-level', filters),
  productionPlan: (filters) => post('/production-plan', filters),
  clearCache: () => post('/cache/clear'),

  admin: {
    users: () => get('/admin/users'),
    analytics: (days) => get(`/admin/analytics${days ? `?days=${days}` : ''}`),
    audit: () => get('/admin/audit'),
    createUser: (body) => post('/admin/users', body),
    updateUser: (id, body) => send('PATCH', `/admin/users/${id}`, body),
    resetPassword: (id, password) => post(`/admin/users/${id}/password`, password ? { password } : {}),
    deleteUser: (id) => send('DELETE', `/admin/users/${id}`),
    insights: () => get('/admin/insights'),
    runInsights: () => post('/admin/insights/run'),
    ackInsights: (day) => post('/admin/insights/ack', { day }),
    alerts: () => get('/admin/alerts'),
    modelReview: (refresh) => get(`/admin/model-review${refresh ? '?refresh=1' : ''}`),
    cube: () => get('/cube'),
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
