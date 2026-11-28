/**
 * MC's recipes, captured and kept as dated versions - 26 Nov 2026, on request:
 *
 *   "Make sure each day's theoretical consumption uses the exact recipe
 *    version MC used when posting that day's sales ... The captured versions
 *    must be retained so that future recipe changes cannot overwrite
 *    historical information."
 *
 * WHY. MC posts each day's sales into DAILYTOTALS at about 06:00 Kuwait the
 * next morning, exploding them with the recipe in force at that moment.
 * MC stores only the CURRENT recipe: HISTORYINFO logs when a recipe was saved,
 * never what it held. So when a recipe is edited mid-month, MC's month keeps
 * the old recipe for the days before the edit, and nothing in MC can say what
 * it was. Measured 26 Nov 2026 for November: PAT 90.9% and MM 97.3% against MC,
 * almost all of it recipes edited on 12, 18, 22-24 Nov. From the day this
 * capture runs, the version in force at every posting is recorded here.
 *
 * WHAT IS CAPTURED - READ-ONLY, through `mcSelect` (SELECT only):
 *
 *   recipes    REC_EXPLOSION, REX_MIS = 1, summed per recipe and article: the
 *              lines MC posts (stop at PA), what `theoreticalDrivers.js` and
 *              the reconciliation rebuild with. One version = a recipe's whole
 *              set of lines; any change to any line, at any depth, is a new
 *              version of every recipe that contains it.
 *   products   PRODUKT: outlet, PLU, recipe or direct article and quantity.
 *              A product moving to another recipe is a new product version.
 *
 * HOW A CHANGE IS NOTICED. Every PROBE_MS a cheap signature is read: the save
 * log's latest time, PRODUKT's row count and latest change, and the count and
 * sum of the posted explosion. The sum catches edits the save log misses (SS's
 * Tahina portion, ~12 Oct 2026, has no save entry). A changed signature - or
 * the daily safety run before posting - triggers a full read and a diff.
 *
 * WHEN A VERSION STARTS. At MC's own save time for that recipe (or any
 * sub-recipe in it) when the save log has one inside the interval since the
 * last capture; otherwise at the capture time. Product changes use PRODUKT's
 * change time the same way. All times are Kuwait wall-clock text, as MC writes
 * them.
 *
 * RETENTION. Rows are only ever inserted, or closed by setting `valid_to`;
 * nothing is updated in place or deleted. Every change set is also appended to
 * an archive file under DATA_DIR/mc-recipe-versions, so the history survives
 * a lost database, and an empty database is refilled from it on start.
 *
 * WHAT IT CAN PROVE. `stateKnownAt(t)` is true only when the probes bracket t
 * closely enough to know the state at t. A posting time outside that is NOT
 * costed from here - the caller keeps its current method and says so.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { mcSelect, mcOracleConfigured } from './oracle.js'
import { canonArticle } from '../powerbi/consumption.js'

/** How often MC is probed for a change. The probe is three small aggregates. */
export const PROBE_MS = 10 * 60 * 1000

/** Two probes further apart than this, with a change between them, do not prove the state in between. */
export const MAX_GAP_MINUTES = 30

/** The safety run: a full capture shortly before MC's 06:00 posting. */
export const SAFETY_HOUR = 5
export const SAFETY_MINUTE = 40

/* ------------------------------------------------------------- time --- */

/** Kuwait wall-clock 'YYYY-MM-DD HH:MM:SS' (UTC+3, no daylight saving). */
export const kuwaitNow = (ms = Date.now()) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')

const toMs = (k) => Date.parse(`${k.replace(' ', 'T')}Z`) - 3 * 3_600_000
export const minutesBetween = (a, b) => (toMs(b) - toMs(a)) / 60_000

/** MC posts day d at 06:00 the next morning (Kuwait). */
export const POSTING_HOUR = 6
export function defaultPostingTime(day) {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return `${next} ${String(POSTING_HOUR).padStart(2, '0')}:00:00`
}

/* --------------------------------------------------- pure: the diff --- */

const hashOf = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16)

/** Recipe lines as a canonical list: [[article, qty]] sorted, qty rounded to 1e-9. */
export function canonLines(map) {
  return [...map]
    .filter(([a, q]) => a && Math.abs(q) > 1e-12)
    .map(([a, q]) => [a, Math.round(q * 1e9) / 1e9])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
}

/**
 * Compare what is open with what MC holds now.
 *
 *   open      Map(key -> { hash })              the versions with no valid_to
 *   now       Map(key -> { hash, body })        this read of MC
 *   startOf   key -> 'YYYY-MM-DD HH:MM:SS'       when a change to `key` took effect
 *
 * Returns { close: [{ key, at }], insert: [{ key, hash, body, at }] }. A key
 * that disappeared from MC is closed; nothing is ever deleted.
 */
export function diffVersions(open, now, startOf) {
  const close = []
  const insert = []
  for (const [key, cur] of now) {
    const was = open.get(key)
    if (was && was.hash === cur.hash) continue
    const at = startOf(key)
    if (was) close.push({ key, at })
    insert.push({ key, hash: cur.hash, body: cur.body, at })
  }
  for (const key of open.keys()) if (!now.has(key)) close.push({ key, at: startOf(key) })
  return { close, insert }
}

/**
 * When a change to a recipe took effect: the latest save of any recipe in its
 * tree inside (since, at], else `at`. `tree` is rez -> Set(rez and its sub-recipes).
 */
export function recipeStart({ rez, tree, saves, since, at }) {
  let best = null
  for (const id of tree.get(rez) ?? [rez]) {
    for (const t of saves.get(id) ?? []) if ((!since || t > since) && t <= at && (!best || t > best)) best = t
  }
  return best ?? at
}

/*
 * ZERO BASE-UNIT SUB-RECIPE LINES - found 26 Nov 2026.
 *
 * A recipe line holds its quantity twice: in the line's own unit
 * (RZT_ISTMENGE) and in base units (RZT_ISTMENGEGE). MC POSTS FROM THE BASE
 * UNITS; REC_EXPLOSION IS BUILT FROM THE OTHER. Where a sub-recipe line has a
 * quantity but 0 base units, the explosion still carries everything beneath it
 * and MC posts none of it. Measured: SS "1 Beef Arayes Sandwich For Grilled
 * Sandwiches Combo" and "Shakir 2 Beef Arayes For 3.5 Arayes Meal" hold "Meat
 * Arayes Sandwich" at 1 and 2, base units 0; the explosion gives 3,329 sleeves
 * and Egyptian bread for November, MC posted none, and that is exactly SS's
 * November gap on both articles (40,139 rebuilt vs 36,810 posted). Article
 * lines are not affected - the explosion already follows base units there
 * (TBL Sweet Corn: 8 = 8). The Recipe File's own SQL uses base units, which is
 * why the file always agreed with MC on these.
 *
 * So an explosion row is dropped when the sub-recipe that holds it
 * (REZ_SUB_ID) can be reached from its top recipe only through such a line.
 * A sub-recipe also reached through a normal line is kept.
 *
 *   rows   [{ rez, sub, art, qty }]          REC_EXPLOSION, REX_MIS = 1
 *   edges  [{ parent, child, ge }]           sub-recipe lines (RZT_TYP = 2)
 */
export function dropZeroPaths(rows, edges) {
  const live = new Map()
  const all = new Map()
  let anyZero = false
  const link = (m, p, c) => {
    const l = m.get(p) ?? []
    l.push(c)
    m.set(p, l)
  }
  for (const e of edges) {
    const p = String(e.parent)
    const c = String(e.child)
    link(all, p, c)
    if (Number(e.ge) !== 0) link(live, p, c)
    else anyZero = true
  }
  if (!anyZero) return { rows, dropped: 0 }
  const memo = new Map()
  const reach = (graph, tag, top) => {
    const k = `${tag}|${top}`
    let s = memo.get(k)
    if (s) return s
    s = new Set([top])
    const stack = [top]
    while (stack.length) for (const c of graph.get(stack.pop()) ?? []) if (!s.has(c)) (s.add(c), stack.push(c))
    memo.set(k, s)
    return s
  }
  let dropped = 0
  const out = rows.filter((r) => {
    const sub = r.sub === null || r.sub === undefined || r.sub === '' ? null : String(r.sub)
    const top = String(r.rez)
    if (!sub || sub === top) return true
    // Dropped only when the zero line is the ONLY way to it; a sub-recipe linked otherwise is kept.
    if (reach(all, 'a', top).has(sub) && !reach(live, 'l', top).has(sub)) {
      dropped += 1
      return false
    }
    return true
  })
  return { rows: out, dropped }
}

/* --------------------------------------------- pure: what was in force --- */

/**
 * The version of each key in force at time t, from rows { key, valid_from,
 * valid_to, ... }: valid_from <= t and (valid_to null or valid_to > t).
 */
export function inForce(rows, t) {
  const out = new Map()
  for (const r of rows) if (r.valid_from <= t && (!r.valid_to || r.valid_to > t)) out.set(r.key, r)
  return out
}

/**
 * True when the probe log proves MC's recipe state at time t: two consecutive
 * successful probes p1 <= t <= p2 that either read the same signature (nothing
 * changed in between) or are at most MAX_GAP_MINUTES apart (a change between
 * them is dated by the save log or to within that gap).
 */
export function stateKnownAt(probes, t, { uncertainBetween } = {}) {
  const ok = probes.filter((p) => p.ok).sort((a, b) => (a.at < b.at ? -1 : 1))
  for (let i = 0; i + 1 < ok.length; i++) {
    const p1 = ok[i]
    const p2 = ok[i + 1]
    if (!(p1.at <= t && t <= p2.at)) continue
    if (p1.sig === p2.sig || minutesBetween(p1.at, p2.at) <= MAX_GAP_MINUTES) return true
    /*
     * A long gap (the server was off overnight - 28 Nov 2026) is still proven
     * when the full re-read at p2 found no recipe or product content changed
     * (the signature can move on a save that changes nothing), or when every
     * version that started inside the gap carries MC's own save or change time
     * rather than the capture time - then the state at t is known exactly.
     */
    if (Number(p2.changed) === 0) return true
    return uncertainBetween ? !uncertainBetween(p1.at, p2.at) : false
  }
  return false
}

/** True for a probe that read MC in full (rows from before the `full` column: a start, safety or changing run). */
const wasFull = (p) =>
  p.ok && (p.full === true || ((p.full === null || p.full === undefined) && (p.kind === 'start' || p.kind === 'safety' || Number(p.changed) > 0)))

/**
 * Versions MC's logs did not date (valid_from = capture time): the change
 * could have happened any time after the previous FULL read, so the moment it
 * took effect lies in (previous full read, capture]. One window per version:
 * { kind: 'recipe' | 'product', key, from, to }. The very first capture has no
 * "before" and gives none.
 */
export function unloggedWindows({ recipes, products, probes }) {
  const fulls = probes.filter(wasFull).map((p) => p.at).sort()
  const prevFull = (t) => {
    let best = null
    for (const f of fulls) if (f < t) best = f
    return best
  }
  const out = []
  for (const [kind, list] of [
    ['recipe', recipes],
    ['product', products],
  ]) {
    for (const r of list) {
      if (r.valid_from !== r.captured) continue
      const from = prevFull(r.captured)
      if (from) out.push({ kind, key: r.key, from, to: r.captured })
    }
  }
  return out
}

/**
 * True when some version started inside (a, b] at its capture time - a change
 * MC's logs did not date, so the moment it took effect is unknown.
 */
export function uncertainIn(store, a, b) {
  for (const list of [store.recipes, store.products]) for (const r of list) if (r.valid_from > a && r.valid_from <= b && r.valid_from === r.captured) return true
  return false
}

/* -------------------------------------------------------- the reads --- */

/*
 * THE SIGNATURE IS A CHECKSUM OF CONTENT - 28 Nov 2026. It was a sum of
 * quantities, which an article swap at the same quantity leaves unchanged: on
 * 26-27 Nov MC replaced TBL's "Honey ww Burger Buns" (102700049) with "Honey
 * WW Burger Bun -MXS" (102700050) in 16 recipes, unlogged, and the probes saw
 * nothing until the next full read. Now every posted explosion row, every
 * recipe line (with its base-unit quantity, which is what MC posts from) and
 * every product is hashed. About 2.7 s per probe, measured.
 */
async function readSignature() {
  const [h, p, x, l] = await Promise.all([
    mcSelect(`SELECT TO_CHAR(MAX(his_date), 'YYYY-MM-DD HH24:MI:SS') AS t FROM historyinfo`),
    mcSelect(
      `SELECT COUNT(*) AS n,
              SUM(ORA_HASH(pro_id || '|' || kst_id || '|' || NVL(rez_nr, 0) || '|' || NVL(art_nr, 0) || '|' || pro_plu || '|' || TO_CHAR(NVL(pro_menge, 0)))) AS h
         FROM produkt`
    ),
    mcSelect(
      `SELECT COUNT(*) AS n,
              SUM(ORA_HASH(rez_id || '|' || NVL(rez_sub_id, 0) || '|' || art_id || '|' || TO_CHAR(ROUND(rex_pot_qty_bu, 9)))) AS h
         FROM rec_explosion WHERE rex_mis = 1`
    ),
    mcSelect(
      `SELECT COUNT(*) AS n,
              SUM(ORA_HASH(rez_id || '|' || rzt_pos || '|' || rzt_typ || '|' || NVL(art_nr, 0) || '|' || NVL(rez_nr, 0) || '|' || TO_CHAR(ROUND(NVL(rzt_istmengege, 0), 9)))) AS h
         FROM rezepturitem`
    ),
  ])
  return [h[0]?.T, p[0]?.N, p[0]?.H, x[0]?.N, x[0]?.H, l[0]?.N, l[0]?.H].join('|')
}

async function readMc(since) {
  const [rexRaw, edges, tree, prod, saves] = await Promise.all([
    mcSelect(
      `SELECT x.rez_id, x.rez_sub_id, a.art_nummer, SUM(x.rex_pot_qty_bu) AS qty
         FROM rec_explosion x JOIN artikel a ON a.art_id = x.art_id
        WHERE x.rex_mis = 1
        GROUP BY x.rez_id, x.rez_sub_id, a.art_nummer`
    ),
    mcSelect(`SELECT rez_id, rez_nr, rzt_istmengege AS ge FROM rezepturitem WHERE rzt_typ = 2 AND rez_nr IS NOT NULL`),
    mcSelect(`SELECT DISTINCT rez_id, rez_sub_id FROM rec_explosion WHERE rez_sub_id IS NOT NULL`),
    mcSelect(
      `SELECT p.pro_id, p.kst_id, TRIM(TO_CHAR(p.pro_plu)) AS plu, p.rez_nr, a.art_nummer, p.pro_menge,
              TO_CHAR(GREATEST(NVL(p.chg_zeit, p.new_zeit), p.new_zeit), 'YYYY-MM-DD HH24:MI:SS') AS changed
         FROM produkt p LEFT JOIN artikel a ON a.art_id = p.art_nr`
    ),
    since
      ? mcSelect(
          `SELECT his_id, TO_CHAR(his_date, 'YYYY-MM-DD HH24:MI:SS') AS t FROM historyinfo WHERE his_date > TO_DATE(:s, 'YYYY-MM-DD HH24:MI:SS')`,
          { s: since }
        )
      : Promise.resolve([]),
  ])
  const { rows: rex, dropped } = dropZeroPaths(
    rexRaw.map((r) => ({ rez: r.REZ_ID, sub: r.REZ_SUB_ID, art: r.ART_NUMMER, qty: r.QTY, REZ_ID: r.REZ_ID, ART_NUMMER: r.ART_NUMMER, QTY: r.QTY })),
    edges.map((e) => ({ parent: e.REZ_ID, child: e.REZ_NR, ge: e.GE }))
  )
  if (dropped) console.log(`  [mc-recipes] ${dropped} explosion rows under sub-recipe lines with 0 base units left out, as MC posts them`)
  const lines = new Map()
  for (const r of rex) {
    const id = String(r.REZ_ID)
    const art = canonArticle(r.ART_NUMMER)
    if (!art) continue
    const m = lines.get(id) ?? new Map()
    m.set(art, (m.get(art) ?? 0) + (Number(r.QTY) || 0))
    lines.set(id, m)
  }
  // A recipe whose every posted line was dropped keeps a version with no lines: MC posts nothing for it.
  for (const r of rexRaw) if (!lines.has(String(r.REZ_ID))) lines.set(String(r.REZ_ID), new Map())
  const recipes = new Map()
  for (const [id, m] of lines) {
    const body = canonLines(m)
    recipes.set(id, { hash: hashOf(body), body })
  }
  const treeMap = new Map()
  for (const t of tree) {
    const id = String(t.REZ_ID)
    const s = treeMap.get(id) ?? new Set([id])
    s.add(String(t.REZ_SUB_ID))
    treeMap.set(id, s)
  }
  const products = new Map()
  const changed = new Map()
  for (const p of prod) {
    const rez = p.REZ_NR && String(p.REZ_NR) !== '0' ? String(p.REZ_NR) : null
    const body = {
      kst: String(p.KST_ID ?? ''),
      plu: String(p.PLU ?? '').trim(),
      rez,
      art: rez ? null : canonArticle(p.ART_NUMMER) || null,
      qty: rez ? null : Number(p.PRO_MENGE) || 1,
    }
    products.set(String(p.PRO_ID), { hash: hashOf(body), body })
    changed.set(String(p.PRO_ID), p.CHANGED)
  }
  const saveMap = new Map()
  for (const s of saves) {
    const id = String(s.HIS_ID)
    const l = saveMap.get(id) ?? []
    l.push(s.T)
    saveMap.set(id, l)
  }
  return { recipes, products, tree: treeMap, saves: saveMap, changed }
}

/* ------------------------------------------------------- the store --- */

let store = null // { pg } once ready
const memo = { rows: null } // versions loaded for reading, cleared on change

const DDL = `
CREATE TABLE IF NOT EXISTS mc_recipe_version (
  rez_id     TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  hash       TEXT NOT NULL,
  lines      TEXT NOT NULL,
  captured   TEXT NOT NULL,
  PRIMARY KEY (rez_id, valid_from)
);
CREATE INDEX IF NOT EXISTS mc_recipe_version_open ON mc_recipe_version (rez_id) WHERE valid_to IS NULL;
CREATE TABLE IF NOT EXISTS mc_product_version (
  pro_id     TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  hash       TEXT NOT NULL,
  kst_id     TEXT,
  plu        TEXT,
  rez_id     TEXT,
  art        TEXT,
  qty        DOUBLE PRECISION,
  captured   TEXT NOT NULL,
  PRIMARY KEY (pro_id, valid_from)
);
CREATE INDEX IF NOT EXISTS mc_product_version_open ON mc_product_version (pro_id) WHERE valid_to IS NULL;
CREATE TABLE IF NOT EXISTS mc_recipe_probe (
  at      TEXT NOT NULL,
  ok      BOOLEAN NOT NULL,
  sig     TEXT,
  kind    TEXT NOT NULL,
  changed INTEGER,
  error   TEXT
);
CREATE TABLE IF NOT EXISTS mc_posting (
  brand      TEXT NOT NULL,
  day        TEXT NOT NULL,
  sold       DOUBLE PRECISION NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  reposted   TEXT,
  PRIMARY KEY (brand, day)
);`

const archiveDir = (dataDir) => path.join(dataDir, 'mc-recipe-versions')

/** Append one change set to the archive. Never rewrites an existing file. */
function archive(dataDir, at, change) {
  try {
    const dir = archiveDir(dataDir)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${at.replace(/[: ]/g, '').replace(/-/g, '')}.json.gz`)
    if (fs.existsSync(file)) return
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(change)), { flag: 'wx' })
  } catch (err) {
    console.warn(`  [mc-recipes] archive write failed: ${String(err.message).slice(0, 100)}`)
  }
}

const BATCH = 400
async function insertRows(pg, table, cols, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH)
    const marks = part.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')
    await pg.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${marks} ON CONFLICT DO NOTHING`, part.flat())
  }
}

/** Apply a change set: close, then insert. One transaction. */
async function applyChange(pg, change) {
  await pg.tx(async () => {
    for (const c of change.recipes.close)
      await pg.run(`UPDATE mc_recipe_version SET valid_to = ? WHERE rez_id = ? AND valid_to IS NULL`, [c.at, c.key])
    for (const c of change.products.close)
      await pg.run(`UPDATE mc_product_version SET valid_to = ? WHERE pro_id = ? AND valid_to IS NULL`, [c.at, c.key])
    await insertRows(
      pg,
      'mc_recipe_version',
      ['rez_id', 'valid_from', 'hash', 'lines', 'captured'],
      change.recipes.insert.map((r) => [r.key, r.at, r.hash, JSON.stringify(r.body), change.at])
    )
    await insertRows(
      pg,
      'mc_product_version',
      ['pro_id', 'valid_from', 'hash', 'kst_id', 'plu', 'rez_id', 'art', 'qty', 'captured'],
      change.products.insert.map((p) => [p.key, p.at, p.hash, p.body.kst, p.body.plu, p.body.rez, p.body.art, p.body.qty, change.at])
    )
  })
}

async function openVersions(pg) {
  const [r, p] = await Promise.all([
    pg.all(`SELECT rez_id AS key, hash FROM mc_recipe_version WHERE valid_to IS NULL`),
    pg.all(`SELECT pro_id AS key, hash FROM mc_product_version WHERE valid_to IS NULL`),
  ])
  return { recipes: new Map(r.map((x) => [x.key, x])), products: new Map(p.map((x) => [x.key, x])) }
}

/** Refill an empty store from the archive, oldest first. */
async function replayArchive(pg, dataDir) {
  const { n } = (await pg.get(`SELECT COUNT(*)::int AS n FROM mc_recipe_version`)) ?? { n: 0 }
  if (n) return 0
  const dir = archiveDir(dataDir)
  if (!fs.existsSync(dir)) return 0
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json.gz')).sort()
  for (const f of files) await applyChange(pg, JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString()))
  if (files.length) console.log(`  [mc-recipes] restored ${files.length} change sets from the archive`)
  return files.length
}

/* ----------------------------------------------------- the capture --- */

let running = null
let lastSig = null

/** One probe; a full capture when the signature moved, or when `force`. */
export async function probeAndCapture({ force = false, kind = 'probe' } = {}) {
  if (!store || !mcOracleConfigured()) return null
  if (running) return running
  running = (async () => {
    const { pg, dataDir } = store
    const at = kuwaitNow()
    try {
      const sig = await readSignature()
      if (lastSig === null) lastSig = (await pg.get(`SELECT sig FROM mc_recipe_probe WHERE ok ORDER BY at DESC LIMIT 1`))?.sig ?? ''
      const { n: have } = (await pg.get(`SELECT COUNT(*)::int AS n FROM mc_recipe_version`)) ?? { n: 0 }
      let changed = 0
      const full = force || sig !== lastSig || !have
      if (full) {
        const since = (await pg.get(`SELECT MAX(at) AS t FROM mc_recipe_probe WHERE ok`))?.t ?? null
        const mc = await readMc(since)
        const open = await openVersions(pg)
        const first = !have
        const recipes = diffVersions(open.recipes, mc.recipes, (rez) =>
          first ? at : recipeStart({ rez, tree: mc.tree, saves: mc.saves, since, at })
        )
        const products = diffVersions(open.products, mc.products, (pro) => {
          const t = mc.changed.get(pro)
          return !first && t && (!since || t > since) && t <= at ? t : at
        })
        changed = recipes.insert.length + recipes.close.length + products.insert.length + products.close.length
        if (changed) {
          const change = { at, recipes, products }
          await applyChange(pg, change)
          archive(dataDir, at, change)
          memo.rows = null
          console.log(
            `  [mc-recipes] ${at}: ${recipes.insert.length} recipe and ${products.insert.length} product versions recorded` +
              ` (${recipes.close.length + products.close.length} closed)`
          )
        }
      }
      // The signature is re-read after a capture so a change during the read is not mistaken for none.
      const after = changed ? await readSignature() : sig
      await pg.run(`INSERT INTO mc_recipe_probe (at, ok, sig, kind, changed, full_read) VALUES (?, TRUE, ?, ?, ?, ?)`, [kuwaitNow(), after, kind, changed, full])
      lastSig = after
      await writeStatus(pg, dataDir).catch(() => {})
      return { at, changed }
    } catch (err) {
      console.warn(`  [mc-recipes] ${kind} failed: ${String(err.message).slice(0, 140)}`)
      await pg.run(`INSERT INTO mc_recipe_probe (at, ok, kind, error) VALUES (?, FALSE, ?, ?)`, [at, kind, String(err.message).slice(0, 300)]).catch(() => {})
      return null
    } finally {
      running = null
    }
  })()
  return running
}

/**
 * A small status file beside the archive, rewritten after every probe, so the
 * capture can be checked without opening the database (which only the running
 * server may hold): the last probes, how many versions are kept, and for each
 * recent day whether its posting moment is proven - i.e. whether that day is
 * costed from captured recipes.
 */
async function writeStatus(pg, dataDir) {
  const [probes, counts, posting] = await Promise.all([
    pg.all(`SELECT at, ok, sig, kind, changed, full_read AS "full", error FROM mc_recipe_probe WHERE at >= ? ORDER BY at`, [kuwaitNow(Date.now() - 12 * 86_400_000)]),
    pg.get(`SELECT (SELECT COUNT(*)::int FROM mc_recipe_version) AS recipes, (SELECT COUNT(*)::int FROM mc_product_version) AS products,
                   (SELECT MIN(at) FROM mc_recipe_probe WHERE ok) AS first_probe`),
    pg.all(`SELECT brand, day, reposted FROM mc_posting WHERE reposted IS NOT NULL`),
  ])
  const versions = {
    recipes: await pg.all(`SELECT rez_id AS key, valid_from, captured FROM mc_recipe_version WHERE valid_from >= ?`, [kuwaitNow(Date.now() - 12 * 86_400_000)]),
    products: await pg.all(`SELECT pro_id AS key, valid_from, captured FROM mc_product_version WHERE valid_from >= ?`, [kuwaitNow(Date.now() - 12 * 86_400_000)]),
  }
  const windows = unloggedWindows({ ...versions, probes })
  const today = kuwaitNow().slice(0, 10)
  const days = []
  for (let i = 10; i >= 1; i--) {
    const day = new Date(Date.parse(`${today}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10)
    const t = defaultPostingTime(day)
    const unsure = windows.filter((w) => w.from < t && t <= w.to)
    days.push({
      day,
      posting: t,
      proven: t <= kuwaitNow() && stateKnownAt(probes, t, { uncertainBetween: (a, b) => uncertainIn(versions, a, b) }) && !unsure.length,
      // The page judges each brand on its own recipes; here any unlogged change at all is counted.
      unloggedChangesAround: unsure.length,
    })
  }
  const failed = probes.filter((p) => !p.ok)
  const status = {
    written: kuwaitNow(),
    firstProbe: counts?.first_probe ?? null,
    versionsKept: { recipes: counts?.recipes ?? 0, products: counts?.products ?? 0 },
    probes: {
      last12Days: probes.length,
      failed: failed.length,
      lastOk: probes.filter((p) => p.ok).pop()?.at ?? null,
      // Every probe, oldest first: when the capture could and could not reach MC, and why.
      timeline: probes.map((p) => `${p.at} ${p.ok ? 'ok' : 'FAILED'} ${p.kind}${p.changed ? ` changed=${p.changed}` : ''}${p.error ? ` - ${String(p.error).slice(0, 90)}` : ''}`),
    },
    days,
    repostedDays: posting,
  }
  const dir = archiveDir(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status, null, 2))
}

/* ----------------------------------------------------- the reading --- */

/** Every version and every probe, held in memory until the next change. */
export async function versionStore() {
  if (!store) return null
  if (memo.rows) return memo.rows
  const { pg } = store
  const [recipes, products, probes, posting] = await Promise.all([
    pg.all(`SELECT rez_id AS key, valid_from, valid_to, lines, captured FROM mc_recipe_version`),
    pg.all(`SELECT pro_id AS key, valid_from, valid_to, kst_id, plu, rez_id, art, qty, captured FROM mc_product_version`),
    pg.all(`SELECT at, ok, sig, changed, kind, full_read AS "full" FROM mc_recipe_probe ORDER BY at`),
    pg.all(`SELECT brand, day, reposted FROM mc_posting`),
  ])
  for (const r of recipes) r.lines = new Map(JSON.parse(r.lines))
  const reposted = new Map(posting.filter((p) => p.reposted).map((p) => [`${p.brand}|${p.day}`, p.reposted]))
  memo.rows = { recipes, products, probes, reposted, loaded: Date.now() }
  // Probes are appended every ten minutes; the coverage they prove is re-read at most every ten.
  setTimeout(() => {
    if (memo.rows && Date.now() - memo.rows.loaded >= PROBE_MS) memo.rows = null
  }, PROBE_MS).unref?.()
  return memo.rows
}

/**
 * When MC posted (or last re-posted) one brand's day: the repost time when
 * the posting watch saw that day's total move, else 06:00 the next morning.
 */
export function postingTime(reposted, brand, day) {
  return reposted?.get(`${brand}|${day}`) ?? defaultPostingTime(day)
}

/* ---------------------------------------------------- the posting watch --- */

/**
 * Record each day's MC sold total per brand, and mark a day RE-POSTED when a
 * later read finds its total moved by more than REPOST_TOLERANCE after it was
 * first seen. A re-posted day is costed with the recipe in force at the time
 * the move was seen. `totals` is Map('BRAND|YYYY-MM-DD' -> sold).
 */
export const REPOST_TOLERANCE = 0.001
export function postingUpdates(existing, totals, at) {
  const out = []
  for (const [k, sold] of totals) {
    const [brand, day] = k.split('|')
    const was = existing.get(k)
    if (!was) out.push({ brand, day, sold, first_seen: at, last_seen: at, reposted: null, isNew: true })
    else {
      const moved = Math.abs(sold - was.sold) > Math.max(1, Math.abs(was.sold) * REPOST_TOLERANCE)
      out.push({ brand, day, sold, first_seen: was.first_seen, last_seen: at, reposted: moved ? at : was.reposted, isNew: false, moved })
    }
  }
  return out
}

export async function watchPosting(readDailyTotals) {
  if (!store) return null
  const { pg } = store
  try {
    const totals = await readDailyTotals()
    const existing = new Map((await pg.all(`SELECT * FROM mc_posting`)).map((r) => [`${r.brand}|${r.day}`, r]))
    const at = kuwaitNow()
    const ups = postingUpdates(existing, totals, at)
    await pg.tx(async () => {
      for (const u of ups) {
        if (u.isNew) await pg.run(`INSERT INTO mc_posting (brand, day, sold, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [u.brand, u.day, u.sold, u.first_seen, u.last_seen])
        else await pg.run(`UPDATE mc_posting SET sold = ?, last_seen = ?, reposted = ? WHERE brand = ? AND day = ?`, [u.sold, u.last_seen, u.reposted, u.brand, u.day])
      }
    })
    const moved = ups.filter((u) => u.moved)
    if (moved.length) {
      memo.rows = null
      console.log(`  [mc-posting] re-posted by MC: ${moved.map((u) => `${u.brand} ${u.day}`).join(', ')}`)
    }
    return { days: ups.length, reposted: moved.length }
  } catch (err) {
    console.warn(`  [mc-posting] failed: ${String(err.message).slice(0, 140)}`)
    return null
  }
}

/* ------------------------------------------------------- the schedule --- */

/**
 * Start capturing. `pg` is the app database; `dataDir` holds the archive.
 * `readDailyTotals` feeds the posting watch (see `datedPm.js`).
 */
export async function startRecipeCapture({ pg, dataDir, readDailyTotals }) {
  if (!mcOracleConfigured()) return false
  await pg.exec(DDL)
  await pg.exec(`ALTER TABLE mc_recipe_probe ADD COLUMN IF NOT EXISTS full_read BOOLEAN`)
  store = { pg, dataDir }
  await replayArchive(pg, dataDir)
  const tick = async () => {
    const k = kuwaitNow()
    const hm = k.slice(11, 16)
    const safety = `${String(SAFETY_HOUR).padStart(2, '0')}:${String(SAFETY_MINUTE).padStart(2, '0')}`
    // The safety run: within one probe interval after 05:40 Kuwait, a forced full capture.
    const force = hm >= safety && minutesBetween(`${k.slice(0, 10)} ${safety}:00`, k) < PROBE_MS / 60_000
    await probeAndCapture({ force, kind: force ? 'safety' : 'probe' })
    // The posting watch once a day, mid-morning, after MC's 06:00 posting has settled.
    if (hm >= '09:00' && minutesBetween(`${k.slice(0, 10)} 09:00:00`, k) < PROBE_MS / 60_000 && readDailyTotals) await watchPosting(readDailyTotals)
  }
  setTimeout(() => {
    probeAndCapture({ force: true, kind: 'start' }).then(() => readDailyTotals && watchPosting(readDailyTotals))
  }, 20_000).unref?.()
  setInterval(tick, PROBE_MS).unref?.()
  return true
}
