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
 * A user's grants, kept as brand-and-branch pairs rather than two flat lists.
 *
 * The rows are stored as pairs and always were. Reading them into one set of
 * brands and one set of branches threw the pairing away, and two real faults
 * came straight out of that.
 *
 * The first: the Add-user form writes one row for the brand itself — (BBT,
 * null) — and one row per branch chosen — (BBT, SAD). Flattened, that null read
 * as "every branch", so granting one branch of a brand silently granted all
 * fourteen of them. The grant that was meant to be the restriction was the
 * thing that removed it.
 *
 * The second: branch codes are not unique across brands. ARD, JHR, KHR, MNF and
 * SAL each exist in more than one chain, so a user holding (BBT, SAD) and
 * (MM, ARD) would, on BBT, be allowed BBT's own ARD — a branch nobody granted
 * them.
 *
 * So: per brand, the branches named for that brand are the grant. A brand with
 * no branch named against it means every branch of that brand, which is what
 * ticking a brand and no branches is asking for.
 *
 *   brands    Set of brand codes, or null for every brand
 *   locations the union, for callers that only want to know if it is unlimited
 *   byBrand   Map of brand code to a Set of branches, or null for all of them
 *   anyBrand  branches granted without a brand, or null for all of them
 */
export async function loadScope(userId, role) {
  if (role === 'admin') return { brands: null, locations: null, byBrand: null, anyBrand: null }

  const rows = await pg.all('SELECT brand_code, location_id FROM user_scopes WHERE user_id = ?', [userId])
  // No grants means nothing, never everything.
  if (!rows.length) return { brands: new Set(), locations: new Set(), byBrand: new Map(), anyBrand: new Set() }

  const brands = new Set()
  const collected = new Map()
  const anyBrand = new Set()
  let allBrands = false
  let anyBrandUnlimited = false

  for (const r of rows) {
    const brand = r.brand_code || null
    const location = r.location_id || null

    if (!brand) {
      // A row with no brand grants every brand; its branch, if it names one,
      // applies wherever no brand-specific grant does.
      allBrands = true
      if (location) anyBrand.add(location)
      else anyBrandUnlimited = true
      continue
    }

    brands.add(brand)
    if (!collected.has(brand)) collected.set(brand, new Set())
    if (location) collected.get(brand).add(location)
  }

  const byBrand = new Map()
  for (const [brand, set] of collected) byBrand.set(brand, set.size ? set : null)

  // The union, and whether anything in it is unrestricted.
  const union = new Set()
  let unlimited = anyBrandUnlimited
  for (const set of byBrand.values()) {
    if (!set) unlimited = true
    else for (const l of set) union.add(l)
  }
  for (const l of anyBrand) union.add(l)

  return {
    brands: allBrands ? null : brands,
    locations: unlimited ? null : union,
    byBrand,
    anyBrand: anyBrandUnlimited ? null : anyBrand,
  }
}

/**
 * The branches a user may see *within one brand*. null means all of them.
 *
 * A brand the user holds an explicit grant for answers from that grant alone —
 * another brand's branches never widen it. A brand reached only through an
 * all-brands grant falls back to whatever that grant named.
 */
export function locationsForBrand(scope, brandCode) {
  if (!scope || !scope.byBrand) return scope?.locations ?? null
  if (brandCode && scope.byBrand.has(brandCode)) return scope.byBrand.get(brandCode)
  return scope.anyBrand ?? null
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
export function applyLocationScope(filters, scope, brandCode = null) {
  const granted = locationsForBrand(scope, brandCode)
  if (!granted) return { filters, denied: false }

  const allowed = [...granted]
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
