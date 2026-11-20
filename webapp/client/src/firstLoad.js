/**
 * How many FIRST loads are in flight, app-wide - 20 Nov 2026.
 *
 * The page loading card used to come down as soon as the page's CODE arrived,
 * which is the moment the page starts asking for its data rather than the
 * moment it has any. On a chart page that is most of the wait.
 *
 * So `useData` reports here whenever one of its instances is loading with
 * nothing yet to show, and the shell waits for the count to reach zero.
 *
 * FIRST loads only, and the distinction is the whole design. A refetch - a
 * changed slicer, the Refresh button, a poll - has data on screen already, and
 * covering it with a full-page card would hide the figures a reader is looking
 * at to tell them something is being fetched. Those keep the quieter in-place
 * treatments the pages already have.
 *
 * A plain module-level counter rather than context: `useData` is called from
 * dozens of places, several of them outside the page subtree, and threading a
 * provider through all of them to count to one number would be a lot of
 * plumbing for an integer.
 */

let pending = 0
const listeners = new Set()

function publish() {
  for (const fn of listeners) fn()
}

/** One first load has started. */
export function beginFirstLoad() {
  pending += 1
  publish()
}

/**
 * One first load has finished, or its component went away mid-flight.
 *
 * Floored at zero. An unmount during a load calls this from a cleanup that has
 * no way of knowing whether the load also resolved, and a count that can go
 * negative would leave the shell thinking it was idle while it was not.
 */
export function endFirstLoad() {
  pending = Math.max(0, pending - 1)
  publish()
}

/** For `useSyncExternalStore`. */
export const pendingFirstLoads = () => pending

export function subscribeFirstLoads(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
