import { useEffect, useRef, useState } from 'react'
import { acquire, drop, forgetCachedData, peek } from './dataCache.js'

/** Strip UI-only keys and empties so the server sees a clean filter payload. */
/*
 * `need` is exempt from the empty-array rule, and has to be.
 *
 * Everywhere else an empty array is the same as no filter, so dropping it keeps
 * the request — and the cache key — clean. `need` is the opposite: it names the
 * dropdown lists this page wants fetched, and an empty one means "none yet".
 * Stripped, it arrived as no key at all, which the server reads as "all of
 * them" — seventy-odd live queries for lists nobody had opened.
 */
const KEEP_EMPTY = new Set(['need'])

export function toPayload(filters) {
  const out = {}
  for (const [k, v] of Object.entries(filters)) {
    if (k === 'defaultFrom' || k === 'defaultTo') continue
    if (v === null || v === undefined || v === '') continue
    if (Array.isArray(v) && v.length === 0 && !KEEP_EMPTY.has(k)) continue
    out[k] = v
  }
  return out
}

export { forgetCachedData }

/*
 * A session that ended takes the answers with it.
 *
 * The cache is keyed on filters, which say nothing about who was asking, and
 * the scope the server applies comes from the session rather than the payload.
 * Signing out and signing back in as somebody else must therefore not find the
 * previous account's rows sitting here under an identical key.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('df:unauthorized', forgetCachedData)
}

/**
 * Run `fetcher(payload)` whenever the filters change, with a short debounce so
 * ticking several slicer boxes issues one request. Stale responses are dropped.
 *
 * An answer already in hand is published without either the debounce or the
 * request — see `dataCache.js` for what is held and for how long.
 *
 * `nonce` forces a refetch without changing the filters (the Refresh button).
 * `onLoaded` fires after each successful load, for the "updated N mins ago" label.
 */
export function useData(fetcher, filters, { enabled = true, debounce = 250, nonce = 0, onLoaded } = {}) {
  const key = JSON.stringify(toPayload(filters))

  /*
   * The first render already knows the answer, when the answer is held.
   *
   * Starting at `loading: true` and filling in from an effect costs a spinner
   * and two renders for data sitting in memory, which is the whole difference
   * between a tab switch that flickers and one that does not.
   */
  const [state, setState] = useState(() => {
    const held = enabled ? peek(fetcher, key) : null
    return held
      ? { data: held.data, error: null, loading: false }
      : { data: null, error: null, loading: enabled }
  })
  const [selfNonce, setSelfNonce] = useState(0)
  const seq = useRef(0)
  const loadedRef = useRef(onLoaded)
  loadedRef.current = onLoaded

  /*
   * Which question this mount has already answered from the cache.
   *
   * Without it the effect cannot tell "the filters changed" from "React ran the
   * effect again", and a cached render would re-publish the same state — and
   * re-fire `onLoaded` — on every pass.
   */
  const servedRef = useRef(null)

  useEffect(() => {
    if (!enabled) return undefined
    const id = ++seq.current

    /*
     * Refresh means refresh. A nonce from the button, or `reload()`, drops the
     * entry first so neither the cache nor an in-flight request can answer it.
     */
    const forced = nonce !== 0 || selfNonce !== 0
    if (forced) drop(fetcher, key)

    const held = forced ? null : peek(fetcher, key)
    if (held) {
      // Published synchronously: there is nothing to wait for, so a timer here
      // would only add a flash of "loading" to an answer already in hand.
      if (servedRef.current !== key) {
        servedRef.current = key
        setState({ data: held.data, error: null, loading: false })
        loadedRef.current?.()
      }
      return undefined
    }
    servedRef.current = null
    setState((s) => ({ ...s, loading: true }))

    /*
     * Superseded requests are abandoned, not just ignored.
     *
     * Stale answers were already dropped, but the request itself ran to
     * completion: ticking four brands in turn left three full dashboard queries
     * running on the server, each fanning out over every brand already
     * selected, all of them for an answer nobody would ever see. The debounce
     * only helps when the clicks are close together.
     *
     * An aborted fetch rejects, and that rejection is not an error worth
     * showing anyone — it is this effect tidying up after itself.
     */
    let cancelled = false
    let handle = null

    const timer = setTimeout(() => {
      handle = acquire(fetcher, key, (signal) => fetcher(JSON.parse(key), { signal }))

      handle.promise
        .then((data) => {
          if (cancelled || seq.current !== id) return
          setState({ data, error: null, loading: false })
          loadedRef.current?.()
        })
        .catch((error) => {
          if (cancelled || error?.name === 'AbortError') return
          if (seq.current === id) setState({ data: null, error, loading: false })
        })
        .finally(() => handle?.release())
    }, debounce)

    return () => {
      cancelled = true
      clearTimeout(timer)
      handle?.release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the serialised filter state
  }, [key, enabled, nonce, selfNonce])

  return { ...state, reload: () => setSelfNonce((n) => n + 1) }
}
