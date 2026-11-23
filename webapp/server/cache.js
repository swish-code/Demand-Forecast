import { config } from './config.js'
import { note, timed } from './perf.js'

const store = new Map()

/*
 * What a key is ABOUT, for the timing ledger.
 *
 * The ledger counts Power BI calls and copy queries, which answers "where did
 * the time go" at the level of the layer and not at the level of the question.
 * A request logging `pbi 32x33806ms` says a third of a minute went to Power BI
 * and nothing whatever about which thirty-two lookups those were, so there is
 * no way to tell a lookup worth caching harder from one that is simply slow.
 *
 * Keys here are colon-separated and start either with a dataset id - a GUID, of
 * no interest - or with the name of the thing. So: drop a leading GUID, take
 * the next segment, and leave the rest, which is the window or the brand and
 * would turn one counter into hundreds.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i

function labelFor(key) {
  const parts = String(key).split(':')
  const name = GUID.test(parts[0]) ? parts[1] : parts[0]
  return `miss:${name || 'other'}`
}

/**
 * How far past its TTL a value may still be served while a refresh runs behind
 * it. Four windows — two hours at the current setting.
 *
 * This exists because the capacity answers 429 with a sixty-second Retry-After.
 * Obeying that is correct, but blocking a page on it is not: the forecast is
 * rebuilt once a day, so an hour-old figure is the same figure. The choice is
 * never "stale data or fresh data", it is "stale data now or the same data
 * after a minute of staring at a spinner".
 */
const STALE_WINDOWS = 4

/** Fetch, then publish the result — or keep the old one if the fetch failed. */
function refresh(key, fn, ttl) {
  const prev = store.get(key)

  // Promise.resolve, not fn().then: some producers are synchronous now that the
  // local copy answers straight out of SQLite, and calling .then on an array
  // throws.
  const promise = timed(labelFor(key), () => Promise.resolve().then(fn)).then(
    (value) => {
      store.set(key, { value, settled: value, hasSettled: true, expires: Date.now() + ttl })
      return value
    },
    (err) => {
      // A throttle must not also empty the cache. Losing the last good value
      // here would mean the next request has nothing to fall back on and takes
      // the full sixty seconds too.
      if (prev?.hasSettled) store.set(key, { ...prev, value: prev.settled })
      else store.delete(key)
      throw err
    }
  )

  // Keep the original expiry. It has already passed — that is why we are here —
  // and overwriting it with zero would make every stale entry look infinitely
  // old, so callers arriving mid-refresh would fail the staleness test and join
  // this promise instead of being served the value sitting right beside it.
  store.set(key, { ...prev, value: promise, refreshing: true })
  return promise
}

/**
 * Run `fn` at most once per `key` per TTL window.
 *
 * `seconds` overrides the configured lifetime for entries that mean something
 * different — a figure labelled "live" cannot sit in a half-hour cache and still
 * be called live, but it cannot be fetched fresh on every request either, which
 * is how the capacity gets a burst it answers with a sixty-second refusal.
 */
export async function cached(key, fn, { seconds = null } = {}) {
  if (!config.cacheTtl && !seconds) return fn()

  const ttl = (seconds ?? config.cacheTtl) * 1000
  const now = Date.now()
  const hit = store.get(key)

  if (hit && hit.expires > now) {
    note('cache', 0)
    return hit.value
  }

  // Usable stale value: answer from it and bring the entry up to date behind
  // the request.
  //
  // This is checked before joining an in-flight refresh, and the order matters.
  // A refresh that is going to fail must not take these callers down with it —
  // they have a perfectly good figure sitting right here, and joining the
  // promise would hand them a throttle error instead.
  if (hit?.hasSettled && now - hit.expires < ttl * (STALE_WINDOWS - 1)) {
    if (!hit.refreshing) {
      // The catch is not indifference — the error already reached whoever
      // triggered the refresh; without it Node calls this an unhandled
      // rejection and takes the process down.
      refresh(key, fn, ttl).catch(() => {})
    }
    note('cache-stale', 0)
    return hit.settled
  }

  // Nothing usable to fall back on, so share one in-flight promise rather than
  // issuing a second identical query.
  if (hit?.refreshing) return hit.value

  return refresh(key, fn, ttl)
}

export function clearCache() {
  store.clear()
}

/**
 * How long an answer about a FINISHED window stays good - 22 Nov 2026.
 *
 * Measured over 1-22 Nov across 4,351 requests: 78.3% of cache lookups missed,
 * and those misses accounted for essentially all of the 100,478 seconds spent
 * inside requests. Power BI alone was 71,622s of it, and two thirds of THAT
 * was `pbi-wait` - not querying, just queueing behind the per-minute pacing.
 *
 * The queue is the thing to shorten, and the only way to shorten it is to ask
 * fewer questions. The heaviest lookups - site outbound, store stock, the
 * component explosion, future demand, non-recipe - all ran on the 120-second
 * default, so a reader moving between pages re-asked the same question about
 * the same finished month every two minutes.
 *
 * WHY THIS IS SAFE, AND WHERE IT IS NOT
 *
 * A window whose last day is in the past is settled: the sales happened, the
 * stock moved. It can still CHANGE - a delivery note posted today against last
 * week's date backdates into a finished month - so this is not "it cannot
 * change", it is "it changes rarely and the page self-heals". `cached` already
 * serves a stale value while refreshing behind the request, so a reader is at
 * most one TTL behind and the next reader is current.
 *
 * An hour, not a day, for exactly that reason. A late posting should not take
 * a shift to appear.
 *
 * A window that includes today keeps the short default: those figures move
 * while people watch them, and that is the case where staleness is noticed.
 */
export const SETTLED_TTL = 3600

/**
 * The TTL for a lookup keyed on a date window.
 *
 * `dateTo` absent means "no window", which is the live case - an open-ended
 * question includes today by definition, so it gets the short default rather
 * than the long one. Being wrong in that direction costs a query; being wrong
 * in the other costs a reader the truth.
 */
export function ttlForWindow(dateTo, { settled = SETTLED_TTL } = {}) {
  const end = String(dateTo ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return null
  const today = new Date().toISOString().slice(0, 10)
  return end < today ? settled : null
}
