import { useEffect, useRef, useState } from 'react'

/** Strip UI-only keys and empties so the server sees a clean filter payload. */
export function toPayload(filters) {
  const out = {}
  for (const [k, v] of Object.entries(filters)) {
    if (k === 'defaultFrom' || k === 'defaultTo') continue
    if (v === null || v === undefined || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

/**
 * Run `fetcher(payload)` whenever the filters change, with a short debounce so
 * ticking several slicer boxes issues one request. Stale responses are dropped.
 *
 * `nonce` forces a refetch without changing the filters (the Refresh button).
 * `onLoaded` fires after each successful load, for the "updated N mins ago" label.
 */
export function useData(fetcher, filters, { enabled = true, debounce = 250, nonce = 0, onLoaded } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled })
  const [selfNonce, setSelfNonce] = useState(0)
  const seq = useRef(0)
  const loadedRef = useRef(onLoaded)
  loadedRef.current = onLoaded

  const key = JSON.stringify(toPayload(filters))

  useEffect(() => {
    if (!enabled) return undefined
    const id = ++seq.current
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
    const control = new AbortController()

    const timer = setTimeout(() => {
      fetcher(JSON.parse(key), { signal: control.signal })
        .then((data) => {
          if (seq.current !== id) return
          setState({ data, error: null, loading: false })
          loadedRef.current?.()
        })
        .catch((error) => {
          if (control.signal.aborted || error?.name === 'AbortError') return
          if (seq.current === id) setState({ data: null, error, loading: false })
        })
    }, debounce)

    return () => {
      clearTimeout(timer)
      control.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the serialised filter state
  }, [key, enabled, nonce, selfNonce])

  return { ...state, reload: () => setSelfNonce((n) => n + 1) }
}
