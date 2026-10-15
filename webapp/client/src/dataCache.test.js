import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ENTRIES, TTL, acquire, drop, forgetCachedData, peek, sizeOf } from './dataCache.js'

/*
 * The browser-side cache, tested without a browser.
 *
 * Everything here is about the two ways a shared request goes wrong — serving
 * something that is not an answer, and one caller cancelling on another's
 * behalf — plus the rule that Refresh always reaches the network.
 */

/** A fetcher whose answer is settled by the test, not by a timer. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test.beforeEach(() => forgetCachedData())

test('an answer is held and served without asking again', async () => {
  const fetcher = () => {}
  let calls = 0
  const run = () => {
    calls += 1
    return Promise.resolve({ rows: [1, 2, 3] })
  }

  assert.equal(peek(fetcher, 'k'), null, 'nothing is held before the first ask')

  const first = acquire(fetcher, 'k', run)
  await first.promise
  first.release()

  assert.equal(calls, 1)
  assert.deepEqual(peek(fetcher, 'k').data, { rows: [1, 2, 3] })

  /*
   * The split of responsibility, stated as a test because it is the thing a
   * future reader is most likely to get wrong: `peek` is what avoids the
   * request, and `acquire` is what issues one. The hook asks in that order, and
   * a second visit therefore never reaches the fetcher at all.
   */
  const second = peek(fetcher, 'k')
  assert.ok(second, 'the second ask is answered from memory')
  assert.deepEqual(second.data, { rows: [1, 2, 3] })
  assert.equal(calls, 1, 'and issued no request')
})

test('a request still in flight is never served as an answer', async () => {
  const fetcher = () => {}
  const d = deferred()
  const held = acquire(fetcher, 'k', () => d.promise)

  /*
   * The entry is in the map at this point, carrying a promise and no data. The
   * bug this guards against returned it anyway, which published `undefined` to
   * the page as though the server had answered with nothing.
   */
  assert.equal(peek(fetcher, 'k'), null)

  d.resolve({ rows: [] })
  await held.promise
  assert.deepEqual(peek(fetcher, 'k').data, { rows: [] })
  held.release()
})

test('two callers asking at once make one request', async () => {
  const fetcher = () => {}
  let calls = 0
  const d = deferred()
  const run = () => {
    calls += 1
    return d.promise
  }

  const a = acquire(fetcher, 'k', run)
  const b = acquire(fetcher, 'k', run)
  assert.equal(calls, 1, 'the second caller joined the first request')
  assert.equal(a.promise, b.promise)

  d.resolve('answer')
  assert.equal(await a.promise, 'answer')
  assert.equal(await b.promise, 'answer')
  a.release()
  b.release()
})

test('one caller leaving does not cancel the request for the other', async () => {
  const fetcher = () => {}
  let signal
  const d = deferred()
  const a = acquire(fetcher, 'k', (s) => {
    signal = s
    return d.promise
  })
  const b = acquire(fetcher, 'k', () => d.promise)

  a.release()
  assert.equal(signal.aborted, false, 'the fetch survives the first caller walking away')

  d.resolve('answer')
  assert.equal(await b.promise, 'answer')
  b.release()
})

test('the last caller leaving does cancel the request', () => {
  const fetcher = () => {}
  let signal
  const d = deferred()
  const a = acquire(fetcher, 'k', (s) => {
    signal = s
    return d.promise
  })
  const b = acquire(fetcher, 'k', () => d.promise)

  a.release()
  b.release()
  assert.equal(signal.aborted, true)
  // Swallow the rejection the abort would produce in the real fetcher.
  d.resolve(null)
})

test('release is idempotent, because React calls cleanup and finally both', async () => {
  const fetcher = () => {}
  let signal
  const d = deferred()
  const a = acquire(fetcher, 'k', (s) => {
    signal = s
    return d.promise
  })
  const b = acquire(fetcher, 'k', () => d.promise)

  a.release()
  a.release()
  a.release()
  assert.equal(signal.aborted, false, 'three releases from one caller still count as one')

  d.resolve('answer')
  await b.promise
  b.release()
})

test('a settled answer survives its last waiter tidying up', async () => {
  const fetcher = () => {}
  const handle = acquire(fetcher, 'k', () => Promise.resolve('answer'))
  await handle.promise
  handle.release()
  /*
   * `release` deletes the in-flight entry, and after settling the map holds the
   * ANSWER under that same key. Deleting by key rather than by identity threw
   * the result away the moment the only caller cleaned up, which made the cache
   * silently do nothing at all.
   */
  assert.equal(peek(fetcher, 'k')?.data, 'answer')
})

test('a failed request is not cached', async () => {
  const fetcher = () => {}
  const handle = acquire(fetcher, 'k', () => Promise.reject(new Error('boom')))
  await assert.rejects(handle.promise, /boom/)
  handle.release()
  assert.equal(peek(fetcher, 'k'), null)
})

test('an answer expires', async () => {
  const fetcher = () => {}
  const handle = acquire(fetcher, 'k', () => Promise.resolve('answer'))
  await handle.promise
  handle.release()

  assert.ok(peek(fetcher, 'k', Date.now() + TTL - 1), 'still fresh just inside the window')
  assert.equal(peek(fetcher, 'k', Date.now() + TTL + 1), null, 'gone just outside it')
})

test('Refresh reaches the network', async () => {
  const fetcher = () => {}
  let calls = 0
  const run = () => {
    calls += 1
    return Promise.resolve(calls)
  }

  const a = acquire(fetcher, 'k', run)
  await a.promise
  a.release()

  drop(fetcher, 'k')
  assert.equal(peek(fetcher, 'k'), null)

  const b = acquire(fetcher, 'k', run)
  assert.equal(await b.promise, 2, 'the second answer is a fresh one')
  b.release()
})

test('two endpoints do not collide on an identical payload', async () => {
  const one = () => {}
  const two = () => {}
  const a = acquire(one, 'same', () => Promise.resolve('from one'))
  const b = acquire(two, 'same', () => Promise.resolve('from two'))
  await Promise.all([a.promise, b.promise])
  a.release()
  b.release()

  assert.equal(peek(one, 'same').data, 'from one')
  assert.equal(peek(two, 'same').data, 'from two')
})

test('sign-out forgets everything', async () => {
  const fetcher = () => {}
  const handle = acquire(fetcher, 'k', () => Promise.resolve('answer'))
  await handle.promise
  handle.release()

  forgetCachedData()
  assert.equal(peek(fetcher, 'k'), null)
})

test('the cache is bounded', async () => {
  const fetcher = () => {}
  for (let i = 0; i < MAX_ENTRIES + 10; i++) {
    const handle = acquire(fetcher, `k${i}`, () => Promise.resolve(i))
    // eslint-disable-next-line no-await-in-loop -- sequential is the point here
    await handle.promise
    handle.release()
  }
  assert.ok(sizeOf(fetcher) <= MAX_ENTRIES, `held ${sizeOf(fetcher)} entries`)
  assert.equal(peek(fetcher, 'k0'), null, 'the oldest went first')
  assert.ok(peek(fetcher, `k${MAX_ENTRIES + 9}`), 'the newest is still there')
})

test('eviction never drops a request somebody is waiting on', async () => {
  const fetcher = () => {}
  const d = deferred()
  const waiting = acquire(fetcher, 'in-flight', () => d.promise)

  for (let i = 0; i < MAX_ENTRIES + 10; i++) {
    const handle = acquire(fetcher, `k${i}`, () => Promise.resolve(i))
    // eslint-disable-next-line no-await-in-loop -- sequential is the point here
    await handle.promise
    handle.release()
  }

  d.resolve('answer')
  assert.equal(await waiting.promise, 'answer')
  waiting.release()
})
