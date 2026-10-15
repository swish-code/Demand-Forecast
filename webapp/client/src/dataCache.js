/*
 * What the browser already asked for, so it does not ask again.
 *
 * Every page here is built from `useData`, and until now it held nothing: open
 * Stock Article, switch to Warehouse Insights, switch back, and the second
 * visit cost exactly what the first did — the pages unmount, so the answer went
 * with them. The server pipeline behind /component-level fans out over every
 * selected brand and then runs ten enrichment passes over the result, so that
 * is not a cheap thing to repeat for data nobody changed.
 *
 * Two mechanisms, with different safety arguments.
 *
 * DEDUPE is unconditional and needs no argument at all: two callers asking the
 * same question at the same moment get one request and the same answer. The
 * Procurement page does this to itself — a month per request, several at once —
 * and so does any page mounting two components that read the same endpoint.
 *
 * The CACHE is bounded by `TTL`, and the figure it serves is chosen to be one
 * the server would have given anyway: the server holds its own answers for
 * CACHE_TTL, currently thirty minutes, so a browser-side entry that expires in
 * two cannot show anything a fresh request would not have returned. It is a
 * strict subset of the staleness the application already accepts.
 *
 * Refresh is the escape hatch and deliberately ignores all of this — the
 * Refresh button and `reload()` both drop the entry and go to the network.
 * Anybody who wants to be certain has a button that is certain.
 *
 * This lives apart from the hook so it can be tested without a DOM: the hook is
 * the React wiring, and everything that could get the ANSWER wrong is here.
 */

/** How long a settled answer may be served without asking again. */
export const TTL = 120_000

/** Bounded, so a long session cannot grow this without limit. */
export const MAX_ENTRIES = 48

/*
 * Per-fetcher, so two endpoints cannot collide on an identical payload.
 *
 * A plain Map rather than a WeakMap: the keys are the handful of functions on
 * the `api` object, which live for the lifetime of the tab anyway, and this way
 * the whole thing can actually be emptied on sign-out.
 */
const caches = new Map()

function cacheFor(fetcher) {
  let map = caches.get(fetcher)
  if (!map) {
    map = new Map()
    caches.set(fetcher, map)
  }
  return map
}

/*
 * Oldest first, which is what `Map` iteration gives. Re-setting a key on every
 * read would make this least-recently-USED, and that is the wrong policy here:
 * these entries expire on a timer, so the oldest is also the one closest to
 * being useless. A request still in flight is never evicted — somebody is
 * waiting on it.
 */
function trim(map) {
  for (const [key, entry] of map) {
    if (map.size <= MAX_ENTRIES) return
    if (!entry.promise) map.delete(key)
  }
}

/**
 * A fresh, SETTLED answer, or nothing. Expired entries are dropped as they are
 * found.
 *
 * The `promise` test is not a detail. One map holds both the answers and the
 * requests still in flight, and an entry of the second kind has no `data` on it
 * at all — returned from here it would publish `undefined` to the page as
 * though the server had answered with nothing.
 */
export function peek(fetcher, key, now = Date.now()) {
  const map = cacheFor(fetcher)
  const entry = map.get(key)
  if (!entry || entry.promise) return null
  if (now - entry.at > TTL) {
    map.delete(key)
    return null
  }
  return { data: entry.data }
}

/** Forget one answer — what Refresh does before it asks again. */
export function drop(fetcher, key) {
  cacheFor(fetcher).delete(key)
}

/**
 * Everything the browser is holding, forgotten.
 *
 * Called when the thing underneath the answers changes — a sign-out — because
 * a key built from filters alone cannot know that the scope those filters are
 * resolved against has been replaced.
 */
export function forgetCachedData() {
  caches.clear()
}

/**
 * Join the request for `key`, or start it, and say how to let go of it again.
 *
 * `invoke(signal)` issues the real request. It is called only when nothing is
 * already in flight for this key.
 *
 * The obvious way to share a request is to hand out the first caller's promise,
 * and it is wrong: that caller owns the AbortController, so the first one to
 * walk away cancels the fetch out from under everybody still waiting on it, who
 * then hang on a rejection they are written to ignore. So the fetch gets its
 * own controller and a count of who is waiting, and it is aborted only when the
 * last of them has gone. That keeps the cancellation this code was given — an
 * abandoned query really is dropped — without letting one caller cancel on
 * another's behalf.
 *
 * `release` is idempotent, because React calls effect cleanups independently of
 * the promise settling and both paths end up here.
 */
export function acquire(fetcher, key, invoke) {
  const map = cacheFor(fetcher)
  let entry = map.get(key)

  if (!entry?.promise) {
    const control = new AbortController()
    const started = { waiters: 0, control, at: Date.now() }
    started.promise = invoke(control.signal).then(
      (data) => {
        // Record the answer only if this is still the request anybody is
        // waiting on — a Refresh may have dropped it in the meantime.
        if (map.get(key) === started) {
          map.set(key, { data, at: Date.now() })
          trim(map)
        }
        return data
      },
      (err) => {
        if (map.get(key) === started) map.delete(key)
        throw err
      }
    )
    map.set(key, started)
    entry = started
  }

  entry.waiters += 1
  let done = false
  return {
    promise: entry.promise,
    release() {
      if (done) return
      done = true
      entry.waiters -= 1
      if (entry.waiters > 0) return
      entry.control.abort()
      // Only if it is still the in-flight entry. Once it has settled the map
      // holds the ANSWER under this key, and deleting that would throw away a
      // perfectly good result the moment its last waiter tidied up.
      if (map.get(key) === entry) map.delete(key)
    },
  }
}

/**
 * One cached call, for callers that are not a `useData`.
 *
 * The Procurement page issues a request per month and folds the answers
 * together, which does not fit a hook that owns one question — so it fetched
 * directly and was the only page in the application with no cache at all.
 * Leaving and returning to it re-ran every month.
 *
 * Returns the same `{ promise, release }` pair as `acquire`, and `release` must
 * be called when the caller walks away, exactly as the hook does on cleanup.
 * `payload` is sent to the fetcher untouched, so this changes what is cached
 * and never what is asked.
 */
export function fetchCached(fetcher, payload) {
  const key = JSON.stringify(payload)
  const held = peek(fetcher, key)
  if (held) return { promise: Promise.resolve(held.data), release() {} }
  return acquire(fetcher, key, (signal) => fetcher(payload, { signal }))
}

/** Test seam: how many entries one fetcher is holding. */
export function sizeOf(fetcher) {
  return cacheFor(fetcher).size
}
