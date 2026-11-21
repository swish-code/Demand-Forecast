import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from './client.js'

/** A clock that only moves when the limiter sleeps. */
function fakeClock() {
  let t = 0
  const slept = []
  return {
    now: () => t,
    wait: async (ms) => {
      slept.push(ms)
      t += ms
    },
    slept,
    advance: (ms) => {
      t += ms
    },
  }
}

test('lets the first N requests through at once', async () => {
  const c = fakeClock()
  const rl = createRateLimiter(3, c)
  await rl.take()
  await rl.take()
  await rl.take()
  assert.equal(c.slept.length, 0)
  assert.equal(rl.size(), 3)
})

test('holds the next request until the oldest leaves the minute', async () => {
  const c = fakeClock()
  const rl = createRateLimiter(2, c)
  await rl.take() // t = 0
  c.advance(10_000)
  await rl.take() // t = 10s
  await rl.take() // must wait until t > 60s
  assert.equal(c.slept.length, 1)
  assert.ok(c.now() >= 60_000, `released at ${c.now()}`)
  assert.ok(c.now() < 61_000, `released too late at ${c.now()}`)
})

test('never lets more than N through inside any sixty seconds', async () => {
  const c = fakeClock()
  const rl = createRateLimiter(5, c)
  const times = []
  for (let i = 0; i < 23; i++) {
    await rl.take()
    times.push(c.now())
  }
  for (let i = 0; i < times.length; i++) {
    const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 60_000).length
    assert.ok(inWindow <= 5, `window starting ${times[i]} held ${inWindow}`)
  }
})

test('concurrent callers share the allowance', async () => {
  const c = fakeClock()
  const rl = createRateLimiter(4, c)
  await Promise.all(Array.from({ length: 10 }, () => rl.take()))
  // 10 requests at 4 a minute need at least two further windows.
  assert.ok(c.now() >= 120_000, `finished at ${c.now()}`)
})
