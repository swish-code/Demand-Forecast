import { config } from './config.js'
import { data } from './data/index.js'
import { previousWindow } from './routes/api.js'

/**
 * Keeping the cache warm, so nobody waits for the capacity.
 *
 * The Power BI capacity answers a burst of queries with 429 and a sixty-second
 * Retry-After. Nine brands selected is twenty-seven queries at once, which is
 * exactly the burst that trips it — and it trips while somebody is watching a
 * spinner.
 *
 * This fetches the same views ahead of time, one query at a time with a pause
 * between each, so the quota gets spent while nobody is waiting. It uses the
 * same cache the requests do, so a warmed view is served in milliseconds.
 *
 * Deliberately slow. A warmer that raced would be the burst it exists to
 * prevent.
 */

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ENABLED = process.env.PBI_PREWARM !== '0'
const GAP_MS = Number(process.env.PBI_PREWARM_GAP_MS) || 2_500
const FIRST_RUN_MS = Number(process.env.PBI_PREWARM_DELAY_MS) || 45_000

/** Half the cache lifetime, so a warmed entry is refreshed before it expires. */
const cycleMs = () => Math.max(5 * 60_000, (config.cacheTtl || 1800) * 500)

let running = false
let lastRun = null
let lastError = null
let warmed = 0

/**
 * The window the dashboard opens on: thirty days ending yesterday.
 *
 * It has to match what the client asks for exactly, because the cache is keyed
 * on the filters — a window one day out would warm an entry nobody requests.
 */
function defaultWindow(range) {
  if (!range?.max) return null
  const today = range.today && range.today <= range.max ? range.today : range.max
  const end = iso(Math.max(Date.parse(today) - DAY, Date.parse(range.min)))
  const from = iso(Math.max(Date.parse(end) - 29 * DAY, Date.parse(range.min)))
  return { dateFrom: from, dateTo: end }
}

async function warmBrand(brand) {
  const base = { brand: brand.code, ...(brand.chain ? { brands: [brand.chain] } : {}) }

  // The calendar first: every other query needs the window it defines.
  const slicers = await data.slicers(base, brand.datasetId, [])
  await sleep(GAP_MS)

  const window = defaultWindow(slicers?.dateRange)
  if (!window) return

  const f = { ...base, ...window }

  // The same queries /summary fans out to, in the same shape, so these land on
  // the cache keys the real request will look for. The window and the top-N
  // come from the route's own code for that reason.
  const prev = previousWindow(f)
  const spanning = prev ? { ...f, dateFrom: prev.dateFrom } : f

  const jobs = [
    // Overview
    () => data.trend(spanning, brand.datasetId),
    () => data.topProducts(f, 0, brand.datasetId),
    () => data.byLocation(f, brand.datasetId),
    // Tomorrow's Prep - no date filter, the measures resolve their own dates
    () => data.productionPlan(base, brand.datasetId),
    () => data.productionPlanKpis(base, brand.datasetId),
    // Products, and the previous window its "demand vs prev" column compares to
    () => data.productLevel(f, brand.datasetId),
    () => (prev ? data.productLevel(prev, brand.datasetId) : null),
    // Ingredients
    () => data.componentLevel(f, brand.datasetId),
  ]

  for (const job of jobs) {
    try {
      await job()
      warmed++
    } catch {
      // A failure here costs nothing — the request path will fetch it itself,
      // and one throttled brand should not stop the other eight being warmed.
    }
    await sleep(GAP_MS)
  }
}

export async function warmOnce() {
  if (running) return
  running = true
  const started = Date.now()
  warmed = 0
  try {
    for (const brand of config.brands) await warmBrand(brand)
    lastError = null
  } catch (err) {
    lastError = err.message
  } finally {
    running = false
    lastRun = { at: Date.now(), seconds: Math.round((Date.now() - started) / 1000), warmed }
  }
}

export const warmState = () => ({ enabled: ENABLED, running, lastRun, lastError })

export function startPrewarm() {
  if (!ENABLED || config.demoMode) return false
  setTimeout(() => {
    warmOnce()
    setInterval(warmOnce, cycleMs())
  }, FIRST_RUN_MS).unref?.()
  return true
}
