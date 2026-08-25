import { pg } from '../db/accounts.js'
import { config } from '../config.js'
import { COOKIE_NAME, readCookie, resolveSession } from './sessions.js'

/**
 * Authentication, roles, and — most importantly — data scoping.
 *
 * The scope is read from the database against the session, never from the
 * request body. If it came from the client, a store user could edit the payload
 * and read another branch's numbers.
 */

/**
 * Attaches req.user when a valid session cookie is present. Never rejects.
 *
 * A failure here is a failure to read the accounts database, which is not the
 * visitor's fault and must not become a 500 on every route: the request carries
 * on unauthenticated and whatever needed a session says so itself.
 */
export async function attachUser(req, res, next) {
  req.sessionToken = readCookie(req, COOKIE_NAME)
  try {
    req.user = await resolveSession(req.sessionToken)
  } catch (err) {
    console.warn(`  [auth] could not read the session (${err.message})`)
    req.user = null
  }
  next()
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' })
  next()
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' })
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' })
    next()
  }
}

/**
 * A user's grants.
 *   brands    Set of brand codes, or null for every brand
 *   locations Set of location ids, or null for every location
 */
export async function loadScope(userId, role) {
  if (role === 'admin') return { brands: null, locations: null }

  const rows = await pg.all('SELECT brand_code, location_id FROM user_scopes WHERE user_id = ?', [userId])
  if (!rows.length) return { brands: new Set(), locations: new Set() } // no grants = nothing

  const brands = new Set()
  const locations = new Set()
  let allBrands = false
  let allLocations = false

  for (const r of rows) {
    if (r.brand_code) brands.add(r.brand_code)
    else allBrands = true
    if (r.location_id) locations.add(r.location_id)
    else allLocations = true
  }

  return {
    brands: allBrands ? null : brands,
    locations: allLocations ? null : locations,
  }
}

/** Brands this user may select, in the configured order. */
export function allowedBrands(scope) {
  return config.brands.filter((b) => !scope.brands || scope.brands.has(b.code))
}

/**
 * Resolve the requested brand against what the user may see. Returns null when
 * the user has no brands at all, which callers must treat as a refusal rather
 * than as "show everything".
 */
export function resolveScopedBrand(scope, requested) {
  const allowed = allowedBrands(scope)
  if (!allowed.length) return null
  return allowed.find((b) => b.code.toLowerCase() === String(requested || '').toLowerCase()) || allowed[0]
}

/**
 * Several brands at once, narrowed to what the user may see.
 *
 * Anything the caller asks for that they have no grant to is dropped rather
 * than refused — the same forgiving behaviour as the location filter, so a
 * stale bookmark degrades to their own brands instead of erroring. An empty
 * request falls back to the first brand they can see.
 */
export function resolveScopedBrands(scope, requested) {
  const allowed = allowedBrands(scope)
  if (!allowed.length) return []

  const asked = (Array.isArray(requested) ? requested : requested ? [requested] : [])
    .map((c) => String(c).toLowerCase())
  if (!asked.length) return [allowed[0]]

  const picked = allowed.filter((b) => asked.includes(b.code.toLowerCase()))
  return picked.length ? picked : [allowed[0]]
}

/**
 * Narrow the location filter to the user's grants.
 *
 * A store user asking for locations outside their grant gets the intersection,
 * not an error, so a stale bookmark degrades to their own data rather than
 * failing. An empty intersection means they asked only for branches they cannot
 * see, and the caller refuses.
 */
export function applyLocationScope(filters, scope) {
  if (!scope.locations) return { filters, denied: false }

  const allowed = [...scope.locations]
  if (!allowed.length) return { filters, denied: true }

  const requested = Array.isArray(filters.locations) ? filters.locations.map(String) : []
  const narrowed = requested.length ? allowed.filter((l) => requested.includes(String(l))) : allowed

  if (!narrowed.length) return { filters, denied: true }
  return { filters: { ...filters, locations: narrowed }, denied: false }
}

/**
 * Location ids that actually exist for a brand, read live from the semantic
 * model. Hierarchy is looked up live rather than synced, so a scope always
 * reflects the model as it is right now.
 *
 * Fails closed: if Power BI cannot be reached we return null and the caller
 * refuses the request, rather than serving unscoped data.
 */
export async function liveLocations(dataApi, filters, datasetId) {
  try {
    const slicers = await dataApi.slicers(filters, datasetId)
    return (slicers?.locations ?? []).map(String)
  } catch {
    return null
  }
}
