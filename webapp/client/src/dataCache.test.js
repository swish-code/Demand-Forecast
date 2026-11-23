import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ENTRIES,
  SETTLED_TTL,
  TTL,
  acquire,
  drop,
  forgetCachedData,
  peek,
  sizeOf,
  ttlFor,
} from './dataCache.js'

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

/* ------------- how long an answer is held, by window (22 Nov 2026) -------- */

test('a finished window is held far longer than a live one', () => {
  /*
   * Navigation was the complaint. Leaving Stock Article for Procurement and
   * coming back three minutes later re-ran the whole pipeline for a month that
   * had not changed, because every entry expired after two minutes whatever it
   * was about.
   */
  const now = Date.parse('2026-11-22T12:00:00Z')
  assert.equal(ttlFor('{"dateFrom":"2026-10-01","dateTo":"2026-10-31"}', now), SETTLED_TTL)
  assert.equal(ttlFor('{"dateFrom":"2026-11-01","dateTo":"2026-11-22"}', now), TTL, 'today is live')
  assert.equal(ttlFor('{"dateTo":"2027-03-31"}', now), TTL, 'a planned year is live')
})

test('a key with no window is treated as live', () => {
  // An open-ended question includes today, so it gets the short life. Being
  // wrong this way costs a request; the other way costs the reader the truth.
  const now = Date.parse('2026-11-22T12:00:00Z')
  assert.equal(ttlFor('{"brand":"BBT"}', now), TTL)
  assert.equal(ttlFor('', now), TTL)
  assert.equal(ttlFor(null, now), TTL)
  assert.equal(ttlFor('{"dateTo":"not a date"}', now), TTL)
})

test('the browser never outlives the server it is quoting', () => {
  /*
   * The subset argument this file is built on. The server holds a finished
   * window for an hour; if the browser held one for longer it would become the
   * stalest thing in the system and Refresh would stop being the way to be
   * certain.
   */
  assert.ok(SETTLED_TTL < 3600_000, 'must expire well before the server entry does')
  assert.ok(SETTLED_TTL > TTL, 'and be worth having over the live one')
})

test('peek honours the window, not a single fixed lifetime', () => {
  /*
   * Built from the REAL clock, because `peek` below is called with it.
   *
   * This test hardcoded 2026-11-22 as "today" and started failing the moment
   * the date rolled over - the live key had quietly become a finished window.
   * A test about what "today" means must not pin today to a literal.
   */
  const day = (offset) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const key = `{"dateTo":"${day(-30)}"}`
  const live = `{"dateTo":"${day(0)}"}`
  const fetcher = () => {}
  forgetCachedData()
  // Five minutes old: too old for a live window, fine for a finished one.
  const five = 5 * 60_000
  acquire(fetcher, key, () => Promise.resolve({ ok: 1 }))
  acquire(fetcher, live, () => Promise.resolve({ ok: 2 }))
  return Promise.resolve().then(() => {
    assert.ok(peek(fetcher, key, Date.now() + five), 'a finished window survives five minutes')
    assert.equal(peek(fetcher, live, Date.now() + five), null, 'a live one does not')
  })
})
