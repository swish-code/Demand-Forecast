import fs from 'node:fs'
import path from 'node:path'
import { pg } from './accounts.js'
import { DATA_DIR } from './driver.js'

/**
 * A backup of the things a person typed.
 *
 * WHY THIS EXISTS
 *
 * The database splits cleanly in two, and until 7 Oct 2026 it was treated as
 * one thing. Eighteen `cube_*` tables are DERIVED — 1.5 million rows the
 * extract rebuilds from Power BI on its own — and a handful of small tables are
 * ENTERED, by somebody at a keyboard, and exist nowhere else.
 *
 * All the value at risk is in the second group, and it is perhaps thirty rows.
 * Yet the only recovery path for it was a one-time migration from the old
 * SQLite file, which covers ten tables, has never held `cube_sales_plan`, and
 * stopped being written on 25 Aug 2026 when the local engine took over. It was
 * a migration path mistaken for a backup.
 *
 * Four database failures later — 2 Sep, 9 Sep, 29 Sep and 7 Oct 2026 — this
 * writes the entered tables to a small JSON file that a rebuild can read back.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 *   cube_*          except the sales plan: derived, and restoring them would
 *                   fight the extract that owns them.
 *   mail_consents   a PKCE verifier in flight, alive for ten minutes. Restoring
 *                   an expired one is worse than restoring nothing.
 *   sessions        a signed-in browser is not worth preserving across a
 *                   rebuild, and restoring them hands out live sessions.
 *   login_events,
 *   audit_log,
 *   digests, alerts history rather than configuration, and the largest of the
 *                   entered tables by far. The SQLite migration still carries
 *                   them where it can; losing them costs nothing operational.
 */

/**
 * Entered, not derived. In dependency order, so a restore can insert them in
 * sequence without tripping a foreign key.
 *
 * `users` first: `user_scopes` and `email_recipients` both reference it.
 */
export const ENTERED_TABLES = [
  'users',
  'user_scopes',
  'email_recipients',
  'mail_identity',
  'cube_sales_plan',
]

/**
 * Where the backups live.
 *
 * Inside the data directory, which is gitignored — and that is on purpose.
 * `mail_identity` holds the mailbox REFRESH TOKEN, a live credential; this file
 * must never be committed or emailed. It is small enough to copy somewhere safe
 * by hand, which is the point.
 */
export const BACKUP_DIR = path.join(DATA_DIR, 'backup')

/**
 * A second copy, deliberately OUTSIDE the data directory.
 *
 * A backup that lives beside the database it protects is not a backup. Lose the
 * folder, the disk or the deployment and both go together - which is the single
 * point of failure this whole exercise exists to remove.
 *
 * Defaults to a `backups` folder beside the repository. Point
 * `BACKUP_MIRROR_DIR` at a network share, OneDrive or a mounted volume and the
 * copy becomes genuinely off-machine with no code change - which is the step
 * that makes this survive losing the machine, not just the database.
 */
export const MIRROR_DIRS = (
  process.env.BACKUP_MIRROR_DIR || path.join(DATA_DIR, '..', '..', 'backups')
)
  .split(';')
  .map((d) => d.trim())
  .filter(Boolean)

/** The first mirror, for callers that want one name to report. */
export const MIRROR_DIR = MIRROR_DIRS[0]

const LATEST = 'entered-latest.json'

/** How many timestamped copies to keep beside the latest. */
const KEEP = 10

const stamp = () =>
  new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')

/**
 * Write every entered table to one JSON file.
 *
 * Returns a summary rather than throwing on a missing table: a database that
 * has not finished its migrations yet should still produce a backup of what it
 * does have, and the caller logs the counts.
 */
export async function exportEntered() {
  const out = { takenAt: new Date().toISOString(), tables: {} }
  const counts = {}

  for (const table of ENTERED_TABLES) {
    try {
      const rows = await pg.all(`SELECT * FROM ${table}`)
      out.tables[table] = rows
      counts[table] = rows.length
    } catch (err) {
      // A table that does not exist yet is not a failure worth losing the rest
      // of the backup over.
      out.tables[table] = null
      counts[table] = `skipped (${String(err.message).slice(0, 60)})`
    }
  }

  const body = JSON.stringify(out, null, 1)
  const rows = Object.values(counts).reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0)

  /*
   * An emptier backup never replaces a fuller one.
   *
   * This runs on clean shutdown, and a FRESH database shutting down cleanly has
   * nothing in it. Without this guard that empty export would overwrite
   * `entered-latest.json` - the file a rebuild reads - and the protection would
   * destroy exactly what it exists to keep. It is not hypothetical: the rebuild
   * on 7 Oct 2026 started an empty database, and had a backup existed this code
   * would have wiped it on the next restart.
   *
   * The dated copy is still written either way, so nothing is hidden and a
   * deliberate emptying is still recoverable by naming the file. Only the
   * pointer that restore follows is protected.
   */
  const prev = readLatest()
  const prevRows = prev
    ? Object.values(prev.data?.tables ?? {}).reduce(
        (n, t) => n + (Array.isArray(t) ? t.length : 0),
        0
      )
    : 0
  const regression = prevRows > 0 && rows < prevRows

  fs.mkdirSync(BACKUP_DIR, { recursive: true })

  /*
   * Written to a temporary name and renamed into place.
   *
   * A backup half-written when the process dies is worse than no backup, and
   * this runs on shutdown — exactly when the process is dying. Rename is atomic
   * on both platforms, so the latest file is either the old one or the new one
   * and never a truncated mixture.
   */
  const dated = `entered-${stamp()}.json`
  // The dated copy always. It is the record, and it is never overwritten.
  fs.writeFileSync(path.join(BACKUP_DIR, dated), body)

  if (!regression) {
    const tmp = path.join(BACKUP_DIR, `.${LATEST}.tmp`)
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, path.join(BACKUP_DIR, LATEST))
  } else {
    console.warn(
      `  [backup] kept the previous latest: this export holds ${rows} row(s) against ` +
        `${prevRows} already saved. The smaller one is in ${dated} if it is wanted.`
    )
  }

  /*
   * The mirror, best-effort.
   *
   * A share that is offline, full or not mounted must never fail the backup
   * that has already been written locally - one copy is better than none, and
   * the next run will catch up.
   */
  const mirrored = []
  for (const dir of MIRROR_DIRS) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, dated), body)
      if (!regression) {
        const mt = path.join(dir, `.${LATEST}.tmp`)
        fs.writeFileSync(mt, body)
        fs.renameSync(mt, path.join(dir, LATEST))
      }
      mirrored.push(dir)
      prune(dir)
    } catch (err) {
      // One unreachable share must not stop the others, nor fail a backup that
      // is already safely written locally.
      console.warn(`  [backup] mirror unavailable: ${dir} (${String(err.message).slice(0, 50)})`)
    }
  }

  prune(BACKUP_DIR)

  return { counts, rows, bytes: body.length, dir: BACKUP_DIR, mirrors: mirrored, regression }
}

/** Keep the most recent `KEEP` dated copies; the latest file is never pruned. */
function prune(dir) {
  try {
    const dated = fs
      .readdirSync(dir)
      .filter((f) => /^entered-\d{8}-\d{6}\.json$/.test(f))
      .sort()
    for (const f of dated.slice(0, Math.max(0, dated.length - KEEP))) {
      fs.unlinkSync(path.join(dir, f))
    }
  } catch {
    // Pruning is housekeeping; never fail a backup over it.
  }
}

/** The newest backup, or null. */
/**
 * The newest usable backup: the local copy, or the mirror when the local one is
 * missing or unreadable.
 *
 * The mirror is the answer to "the data directory is gone" - the case where the
 * local copy went with the database. Reading it needs no intervention, so a
 * rebuild on a wiped disk restores itself as long as the share is reachable.
 */
export function readLatest() {
  for (const dir of [BACKUP_DIR, ...MIRROR_DIRS]) {
    const file = path.join(dir, LATEST)
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data?.tables) return { file, data }
    } catch {
      // Try the next location.
    }
  }
  return null
}

/**
 * Put the entered tables back, into a database that does not have them.
 *
 * ONLY INTO AN EMPTY TABLE, which is the same rule the SQLite migration follows
 * and for the same reason: this must never overwrite something that has since
 * changed. A rebuild restores; a running system is left alone.
 *
 * Identity sequences are reset afterwards. Rows carry their original ids so the
 * foreign keys between them still line up, and inserting explicit ids leaves
 * the sequence at 1 — the next insert would collide with the first row.
 */
export async function restoreEntered({ file = null } = {}) {
  const held = file
    ? { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) }
    : readLatest()
  if (!held?.data?.tables) return { restored: null, reason: 'no backup file' }

  const restored = {}
  for (const table of ENTERED_TABLES) {
    const rows = held.data.tables[table]
    if (!Array.isArray(rows) || !rows.length) {
      restored[table] = 0
      continue
    }

    let existing = 0
    try {
      existing = Number((await pg.get(`SELECT COUNT(*)::int AS n FROM ${table}`))?.n ?? 0)
    } catch {
      restored[table] = 'table missing'
      continue
    }
    if (existing > 0) {
      restored[table] = `skipped — ${existing} row(s) already present`
      continue
    }

    const cols = Object.keys(rows[0])
    const list = cols.map((c) => `"${c}"`).join(', ')
    const marks = cols.map(() => '?').join(', ')
    await pg.tx(async () => {
      for (const r of rows) {
        await pg.run(
          `INSERT INTO ${table} (${list}) VALUES (${marks})`,
          cols.map((c) => r[c] ?? null)
        )
      }
    })
    restored[table] = rows.length
  }

  await resetSequences()
  return { restored, takenAt: held.data.takenAt, file: held.file }
}

/**
 * Put every identity sequence past the largest id it now holds.
 *
 * Without this the next insert collides with a restored row — the failure the
 * SQLite migration documents and guards against in exactly the same way.
 */
async function resetSequences() {
  for (const table of ENTERED_TABLES) {
    try {
      await pg.run(
        `SELECT setval(
           pg_get_serial_sequence('${table}', 'id'),
           COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1,
           false
         )
         WHERE pg_get_serial_sequence('${table}', 'id') IS NOT NULL`
      )
    } catch {
      // Tables without an `id` sequence — cube_sales_plan, mail_identity — have
      // nothing to reset, and saying so is not worth a log line.
    }
  }
}
