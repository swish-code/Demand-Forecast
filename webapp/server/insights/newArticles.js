import { config } from '../config.js'
import { cached } from '../cache.js'
import { executeQuery } from '../powerbi/client.js'
import { query, table, snowflakeConfigured } from '../costing/snowflake.js'

/**
 * Which articles are NEW - 21 Nov 2026.
 *
 * THERE IS NO CREATION DATE ANYWHERE. `dim_item` holds 2,489 articles with a
 * category, a group and a storage type, and no dates; neither do the brand
 * models. So "new" has to be inferred from an article's FIRST APPEARANCE in
 * the transaction history, and that inference has three traps. All three are
 * handled here, and each is the reason for a rule that would otherwise look
 * like over-engineering.
 *
 * TRAP 1: THE SYSTEM'S OWN START LOOKS LIKE A LAUNCH. Outbound history begins
 * in 2021 but only properly fills from 2024 (645 articles) and 2025 (2,293);
 * purchase orders are worse - 680 articles in all, 545 of them first appearing
 * in the last four months, which is a coverage artefact and not a wave of new
 * products. An article alive before its source began recording looks newborn
 * on the day that source started. So a first appearance inside `BOUNDARY_DAYS`
 * of a source's own earliest record is not trusted.
 *
 * TRAP 2: A TYPO LOOKS LIKE A PRODUCT. Of the 117 articles first seen since
 * 1 September, 28 have two or fewer movement rows in their entire life. A
 * genuine launch moves: the top of that list has 1,102 rows since 15 Sep. So
 * an article must have earned its flag - see `QUALIFY`.
 *
 * TRAP 3: THE ANSWER MOVES WHEN THE DATA DOES. Computing first-seen on every
 * read means a re-extract, a refresh gap or a widened window can shift an
 * article's "first" date, so a flag could appear, vanish and reappear. The
 * date is therefore WRITTEN ONCE to Snowflake and never updated: the first
 * time this app sees an article is the first time, permanently.
 */

/** How long an article stays new. Agreed 21 Nov 2026. */
const NEW_FOR_DAYS = 30

/** A first appearance this close to a source's own start is not a launch. */
const BOUNDARY_DAYS = 60

/** What an article must do before its first appearance counts. */
const QUALIFY = { rows: 3, days: 2 }

const T = () => table('ARTICLE_FIRST_SEEN')
const val = (r, k) => r[k] ?? r[`[${k}]`]
const iso = (v) => (v ? String(v).slice(0, 10) : null)
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

let ensured = null

/** Create the ledger if it is not there. Safe to call repeatedly. */
export function ensureFirstSeenTable() {
  if (!ensured) {
    ensured = query(`CREATE TABLE IF NOT EXISTS ${T()} (
      ARTICLE_ID VARCHAR(64) NOT NULL,
      FIRST_SEEN_DATE DATE NOT NULL,
      FIRST_SEEN_SOURCE VARCHAR(40) NOT NULL,
      MOVEMENT_ROWS NUMBER(38,0),
      DISTINCT_DAYS NUMBER(38,0),
      RECORDED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
      CONSTRAINT PK_ARTICLE_FIRST_SEEN PRIMARY KEY (ARTICLE_ID)
    )`).catch((err) => {
      ensured = null // let the next call try again
      throw err
    })
  }
  return ensured
}

/**
 * Each article's earliest trace, and how much it has moved since.
 *
 * Three reads rather than one join: the facts live in separate tables with no
 * shared grain, and asking each for its own minimum is both simpler and
 * cheaper than making the model join them.
 *
 * `rows` and `days` come from the OUTBOUND table alone, because that is what
 * "movement" means - a receipt is stock arriving, not the article being used.
 */
async function firstTraces() {
  const w = config.warehouse
  if (!w?.datasetId || !w?.workspaceId) return null
  const ask = (dax) => executeQuery(dax, w.datasetId, { bulk: true, workspace: w.workspaceId })

  const [outbound, grn, po] = await Promise.all([
    ask(`EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
  "First", MIN(fact_outbound_line[Request Created Date]),
  "Rows", COUNTROWS(fact_outbound_line),
  "Days", DISTINCTCOUNT(fact_outbound_line[Request Created Date])
)`),
    ask(`EVALUATE
SUMMARIZECOLUMNS(
  fact_grn_line[Article No.],
  "First", MIN(fact_grn_line[GRN Delivery Date])
)`),
    ask(`EVALUATE
SUMMARIZECOLUMNS(
  fact_po_line[Article],
  "First", MIN(fact_po_line[PO Date])
)`),
  ])

  /** The earliest record each SOURCE holds - trap 1's reference point. */
  const starts = {}
  const out = new Map()

  const fold = (rows, key, source) => {
    let earliest = null
    for (const r of rows ?? []) {
      const article = String(val(r, key) ?? '').trim()
      const first = iso(val(r, 'First'))
      if (!article || !first) continue
      if (!earliest || first < earliest) earliest = first
      const held = out.get(article) ?? { first: null, source: null, rows: 0, days: 0 }
      if (!held.first || first < held.first) {
        held.first = first
        held.source = source
      }
      if (source === 'outbound') {
        held.rows = Number(val(r, 'Rows')) || 0
        held.days = Number(val(r, 'Days')) || 0
      }
      out.set(article, held)
    }
    starts[source] = earliest
  }

  fold(outbound, 'Article No.', 'outbound')
  fold(grn, 'Article No.', 'grn')
  fold(po, 'Article', 'po')

  return { traces: out, starts }
}

/**
 * Record any article we have not recorded before, and never touch the rest.
 *
 * An INSERT guarded by NOT EXISTS rather than a MERGE that updates: the whole
 * value of the ledger is that a date already written cannot move. A MERGE with
 * an UPDATE clause would be one careless edit away from undoing that.
 */
async function recordUnseen(traces, starts) {
  const [{ N } = {}] = await query(`SELECT COUNT(*) AS N FROM ${T()}`)
  const known = new Set()
  if (Number(N) > 0) {
    for (const r of await query(`SELECT ARTICLE_ID FROM ${T()}`)) known.add(String(r.ARTICLE_ID))
  }

  const fresh = []
  for (const [article, t] of traces) {
    if (known.has(article)) continue
    if (!t.first || !t.source) continue
    fresh.push([article, t.first, t.source, t.rows, t.days])
  }
  if (!fresh.length) return 0

  /*
   * In batches, because Snowflake's statement size is finite and this inserts
   * every article the app has ever seen on its very first run - about 3,700.
   */
  const SIZE = 500
  for (let i = 0; i < fresh.length; i += SIZE) {
    const batch = fresh.slice(i, i + SIZE)
    const values = batch.map(() => '(?, TO_DATE(?), ?, ?, ?)').join(', ')
    await query(
      `INSERT INTO ${T()} (ARTICLE_ID, FIRST_SEEN_DATE, FIRST_SEEN_SOURCE, MOVEMENT_ROWS, DISTINCT_DAYS)
       VALUES ${values}`,
      batch.flat()
    )
  }
  console.log(`  [new-articles] recorded ${fresh.length} first-seen dates`)
  return fresh.length
}

/**
 * The articles that are NEW right now.
 *
 * Returns a Set of article numbers, or null when it cannot be worked out -
 * null meaning "unknown", so a caller leaves the column blank rather than
 * asserting that nothing is new.
 *
 * Cached for an hour: the answer changes at most once a day, and the Power BI
 * reads behind it are three full-history scans.
 */
export async function newArticles({ now = new Date() } = {}) {
  if (!snowflakeConfigured()) return null
  const today = now.toISOString().slice(0, 10)

  return cached(`new-articles:${today}`, async () => {
    await ensureFirstSeenTable()

    const got = await firstTraces()
    if (got) await recordUnseen(got.traces, got.starts)

    /*
     * Read the flag back FROM THE LEDGER, not from what we just computed.
     * The ledger is the authority - an article recorded months ago keeps the
     * date it was recorded with, even if the sources no longer agree.
     */
    const rows = await query(
      `SELECT ARTICLE_ID, TO_VARCHAR(FIRST_SEEN_DATE) AS D, FIRST_SEEN_SOURCE AS S,
              MOVEMENT_ROWS AS R, DISTINCT_DAYS AS DD
         FROM ${T()}
        WHERE FIRST_SEEN_DATE >= DATEADD(day, -${NEW_FOR_DAYS}, CURRENT_DATE())`
    )

    const starts = got?.starts ?? {}
    const out = new Set()
    for (const r of rows) {
      const first = iso(r.D)
      if (!first) continue

      // Trap 1: too close to the source's own earliest record to be a launch.
      const start = starts[String(r.S)]
      if (start && daysBetween(start, first) < BOUNDARY_DAYS) continue

      // Trap 2: it has to have actually moved.
      const movedEnough =
        (Number(r.R) || 0) >= QUALIFY.rows || (Number(r.DD) || 0) >= QUALIFY.days
      if (!movedEnough) continue

      out.add(String(r.ARTICLE_ID))
    }

    console.log(`  [new-articles] ${out.size} articles are new (first seen in ${NEW_FOR_DAYS} days)`)
    return out
  }, { seconds: 3600 })
}

export const NEW_ARTICLE_LABEL = 'New'
export { NEW_FOR_DAYS, QUALIFY, BOUNDARY_DAYS }
