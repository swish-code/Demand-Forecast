import { config } from './config.js'

const store = new Map()

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
  const promise = Promise.resolve()
    .then(fn)
    .then(
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

/** Run `fn` at most once per `key` per TTL window. */
export async function cached(key, fn) {
  if (!config.cacheTtl) return fn()

  const ttl = config.cacheTtl * 1000
  const now = Date.now()
  const hit = store.get(key)

  if (hit && hit.expires > now) return hit.value

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
