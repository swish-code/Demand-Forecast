import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { claimDirectory, bootedAt } from './driver.js'

/**
 * The lock on the local database directory.
 *
 * Two real failures are pinned here, both from 8 Oct 2026:
 *
 *   A laptop restart left `owner.pid` behind, Windows handed that pid number to
 *   an unrelated process, and the server then refused to start on EVERY attempt
 *   because the pid looked alive. The lock has to be able to tell a leftover
 *   from a holder.
 *
 *   A `node --watch` restart began while the outgoing process was still closing,
 *   and the single look at the lock lost the race. The start failed, so --watch
 *   stopped and waited for a file change, leaving the app down. A live holder
 *   has to be waited for, not refused.
 */

/** A throwaway directory per test, so one test cannot see another's lock. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-lock-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const lockOf = (dir) => path.join(dir, 'owner.pid')
const readLock = (dir) => JSON.parse(fs.readFileSync(lockOf(dir), 'utf8'))

/**
 * A pid that is certainly gone.
 *
 * Spawned and waited on rather than invented: a made-up number can be out of
 * range, and the platforms disagree about what they raise for one of those,
 * which would test the error code rather than the behaviour.
 */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const { pid } = child
  await new Promise((resolve) => child.once('exit', resolve))
  return pid
}

/**
 * A live process that is definitely NOT Node, for the recycled-pid case.
 *
 * It has to be something the image-name check can rule out, which is the whole
 * point of that check: after a reboot the number belongs to anything at all.
 */
function liveStranger(t) {
  const child =
    process.platform === 'win32'
      ? spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore' })
      : spawn('sleep', ['60'], { stdio: 'ignore' })
  t.after(() => {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  })
  return child
}

test('claims a directory nobody holds, and records the boot', async (t) => {
  const dir = tempDir(t)
  await claimDirectory(dir)

  const held = readLock(dir)
  assert.equal(held.pid, process.pid)
  assert.ok(
    Math.abs(held.bootedAt - bootedAt()) < 60_000,
    'the lock should carry this boot, so a later boot can tell it is stale'
  )
})

test('takes over a lock whose process is gone', async (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(lockOf(dir), JSON.stringify({ pid: await deadPid(), bootedAt: bootedAt() }))

  await claimDirectory(dir, { waitMs: 0 })
  assert.equal(readLock(dir).pid, process.pid)
})

test('takes over a lock written before this boot, whose pid is now a stranger', async (t) => {
  const dir = tempDir(t)
  const stranger = liveStranger(t)
  // Alive, and stamped with a boot three days ago: nothing running now can have
  // taken a lock before the machine started, so the number has been recycled.
  fs.writeFileSync(
    lockOf(dir),
    JSON.stringify({ pid: stranger.pid, bootedAt: bootedAt() - 3 * 24 * 3600 * 1000 })
  )

  await claimDirectory(dir, { waitMs: 0 })
  assert.equal(
    readLock(dir).pid,
    process.pid,
    'a post-reboot leftover must not keep the server from starting'
  )
})

test('refuses when a live process from this boot holds it', async (t) => {
  const dir = tempDir(t)
  const holder = liveStranger(t)
  fs.writeFileSync(lockOf(dir), JSON.stringify({ pid: holder.pid, bootedAt: bootedAt() }))

  await assert.rejects(
    () => claimDirectory(dir, { waitMs: 300 }),
    /already open in process/,
    'two copies of the app against one directory is still an error, not a takeover'
  )
  // And it left the holder's lock alone.
  assert.equal(readLock(dir).pid, holder.pid)
})

test('waits for a handover instead of losing the race', async (t) => {
  const dir = tempDir(t)
  // A real Node process that lets go shortly, which is what the outgoing side of
  // a --watch restart looks like.
  const outgoing = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], {
    stdio: 'ignore',
  })
  t.after(() => {
    try {
      outgoing.kill()
    } catch {
      // Already gone.
    }
  })
  fs.writeFileSync(lockOf(dir), JSON.stringify({ pid: outgoing.pid, bootedAt: bootedAt() }))

  const started = Date.now()
  await claimDirectory(dir, { waitMs: 15000 })

  assert.equal(readLock(dir).pid, process.pid)
  assert.ok(
    Date.now() - started >= 1000,
    'it should have waited for the outgoing process rather than claimed immediately'
  )
})

test('still understands the old bare-pid lock file', async (t) => {
  const dir = tempDir(t)
  // The shape written before 8 Oct 2026. An upgrade must not refuse to start.
  fs.writeFileSync(lockOf(dir), String(await deadPid()))

  await claimDirectory(dir, { waitMs: 0 })
  assert.equal(readLock(dir).pid, process.pid)
})

