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

/*
 * 22 Nov 2026 - THE RULE IS NOW THE READER'S PERIOD, NOT TODAY.
 *
 * The original rule above asked "did this article first appear in the last 30
 * days?", measured from the clock. It answered a question nobody on a reporting
 * page was asking: a buyer looking at October wants to know what was new IN
 * OCTOBER, and got an answer about this morning.
 *
 * So the window now comes from the date slicer, and the lookback moves with it:
 *
 *   reporting period   1-30 Oct 2026
 *   lookback           1 Oct 2025 .. 30 Sep 2026   (12 months, ending the day
 *                                                   before the period starts)
 *
 * Movement in the lookback means the article was already in circulation, and
 * that is the whole test. What separates the two flagged kinds is whether the
 * article existed BEFORE the lookback:
 *
 *   New        moved in the period, silent through the lookback, and the
 *              ledger holds no trace of it before the lookback either
 *   Returning  moved in the period, silent through the lookback, but the
 *              ledger first saw it before the lookback began - it is not new,
 *              it came back
 *   Existing   moved during the lookback (returned as no label at all)
 *
 * NOTHING ABOUT THIS IS STORED. The ledger keeps a FACT - the first date this
 * app ever saw an article - and the verdict is derived from it per period.
 * That is what lets the same article read New in October and Existing in
 * December without a single ledger row being rewritten, and it is why changing
 * the slicer cannot corrupt the history.
 */

/** How long an article must have been silent. Agreed 22 Nov 2026. */
const LOOKBACK_MONTHS = 12

/** How long an article stays new. The pre-22-Nov rule; kept for the ledger. */
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
 * The 12 months before a reporting period begins.
 *
 * Ends the day BEFORE the period starts, so the two never overlap: the period
 * decides which articles are evaluated, the lookback decides what they are.
 * A period spanning several months uses its own start, as agreed - a six-month
 * report asks one question about the whole report, not six.
 */
export function lookbackFor(from) {
  if (!from) return null
  const start = new Date(`${from}T00:00:00Z`)
  if (Number.isNaN(start.getTime())) return null

  const back = new Date(start)
  back.setUTCMonth(back.getUTCMonth() - LOOKBACK_MONTHS)
  const end = new Date(start.getTime() - 86_400_000)
  return { start: iso(back.toISOString()), end: iso(end.toISOString()) }
}

/**
 * One article's verdict, given its movement and what the ledger holds.
 *
 * Pure, and exported, so the rule can be tested without Power BI or Snowflake
 * behind it. Returns 'New', 'Returning', or null - and null covers three
 * genuinely different cases on purpose: it did not move in the period, it
 * moved during the lookback (Existing), or it moved too little to be believed.
 * The column shows a blank for all three, because none of them is a claim.
 */
export function verdictFor({ periodRows = 0, periodDays = 0, lookbackRows = 0, firstSeen = null, lookbackStart }) {
  if (!(periodRows > 0)) return null
  if (lookbackRows > 0) return null

  /*
   * QUALIFY is measured on the REPORTING PERIOD, not on the article's whole
   * life. On whole-life rows a Returning article passes by definition - it has
   * years of history - so the gate that exists to catch one-row corrections
   * would never fire for the half of the population most likely to hold them.
   */
  if (periodRows < QUALIFY.rows && periodDays < QUALIFY.days) return null

  return firstSeen && lookbackStart && firstSeen < lookbackStart
    ? RETURNING_ARTICLE_LABEL
    : NEW_ARTICLE_LABEL
}

/** Keep the ledger current. One cached run a day, whatever the slicer says. */
async function refreshLedger(today) {
  return cached(`first-seen-ledger:${today}`, async () => {
    await ensureFirstSeenTable()

    /*
     * TOPPING THE LEDGER UP MUST NOT DECIDE WHETHER THE PAGE WORKS.
     *
     * `firstTraces` is three FULL-HISTORY Power BI scans. They run inside a
     * page request that is already waiting on Power BI, behind the per-minute
     * pacing, and they can time out - which is the most likely explanation for
     * the blank page reported on 22 Nov: the lookup threw, every row became
     * "not new", and the New filter deleted the lot.
     *
     * The ledger is the authority in any case. If the top-up fails, the dates
     * already recorded are still true and still answer New vs Returning; only
     * articles first seen since the last successful run are missing, and they
     * will be added on the next one. So this degrades to "slightly stale"
     * rather than to "no answer".
     */
    let got = null
    try {
      got = await firstTraces()
      if (got) await recordUnseen(got.traces, got.starts)
    } catch (err) {
      console.warn(
        `  [first-seen-ledger] top-up failed, using the ledger as it stands: ${String(err.message).slice(0, 110)}`
      )
    }

    const seen = new Map()
    for (const r of await query(`SELECT ARTICLE_ID, TO_VARCHAR(FIRST_SEEN_DATE) AS D FROM ${T()}`)) {
      const d = iso(r.D)
      if (d) seen.set(String(r.ARTICLE_ID), d)
    }
    return { seen, starts: got?.starts ?? {} }
  }, { seconds: 3600 })
}

/** Movement per article in the two windows, in one read. */
async function movementFor({ from, to, lookback }) {
  const w = config.warehouse
  if (!w?.datasetId || !w?.workspaceId) return null
  const d = (v) => {
    const [y, m, day] = v.split('-')
    return `DATE(${Number(y)},${Number(m)},${Number(day)})`
  }
  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
  "PeriodRows", CALCULATE(COUNTROWS(fact_outbound_line),
    DATESBETWEEN(fact_outbound_line[Request Created Date], ${d(from)}, ${d(to)})),
  "PeriodDays", CALCULATE(DISTINCTCOUNT(fact_outbound_line[Request Created Date]),
    DATESBETWEEN(fact_outbound_line[Request Created Date], ${d(from)}, ${d(to)})),
  "LookbackRows", CALCULATE(COUNTROWS(fact_outbound_line),
    DATESBETWEEN(fact_outbound_line[Request Created Date], ${d(lookback.start)}, ${d(lookback.end)}))
)`,
    w.datasetId,
    { bulk: true, workspace: w.workspaceId }
  )
  return rows ?? []
}

/**
 * Classify every article that moved in the reporting period.
 *
 * Returns `{ labels, lookback, stats }`, or null when the question cannot be
 * answered - null meaning UNKNOWN, so a caller leaves the column blank rather
 * than telling a reader that nothing is new.
 *
 * `labels` holds only New and Returning. Existing is deliberately absent: it
 * is the same blank as "could not be established", and a column that printed
 * "Existing" would be asserting a certainty this data does not have.
 */
export async function articleStatusForWindow({ from, to } = {}) {
  if (!snowflakeConfigured()) return null
  if (!from || !to || from > to) return null

  const lookback = lookbackFor(from)
  if (!lookback) return null
  const today = new Date().toISOString().slice(0, 10)

  return cached(`article-status:${from}:${to}:${today}`, async () => {
    const { seen, starts } = await refreshLedger(today)

    /*
     * BOUNDARY_DAYS, re-pointed at the WINDOW rather than at the article.
     *
     * The old test asked whether an article's first appearance sat too close
     * to its source's earliest record. Under a moving lookback the exposure is
     * larger and simpler: if the outbound history does not comfortably cover
     * the whole lookback, then EVERY article looks dormant through it, and the
     * rule would flag the lot. So the window itself must clear the start of
     * recorded history by the same margin, or nothing is classified.
     *
     * Returning null rather than calling everything Existing is the point: a
     * period we cannot judge must read as unknown, not as a clean bill.
     */
    const outboundStart = starts.outbound ?? null
    if (outboundStart && daysBetween(outboundStart, lookback.start) < BOUNDARY_DAYS) {
      console.log(
        `  [article-status] ${from}..${to}: lookback starts ${lookback.start}, ` +
          `outbound history starts ${outboundStart} - inside the ${BOUNDARY_DAYS}-day margin, not classified`
      )
      return {
        labels: new Map(),
        lookback,
        stats: { evaluated: 0, new: 0, returning: 0, existing: 0, failedQualify: 0, suppressed: true },
      }
    }

    const rows = await movementFor({ from, to, lookback })
    if (!rows) return null

    const labels = new Map()
    const stats = { evaluated: 0, new: 0, returning: 0, existing: 0, failedQualify: 0, suppressed: false }

    for (const r of rows) {
      const article = String(val(r, 'Article No.') ?? '').trim()
      const periodRows = Number(val(r, 'PeriodRows')) || 0
      if (!article || periodRows <= 0) continue
      stats.evaluated += 1

      const lookbackRows = Number(val(r, 'LookbackRows')) || 0
      if (lookbackRows > 0) {
        stats.existing += 1
        continue
      }

      const periodDays = Number(val(r, 'PeriodDays')) || 0
      const verdict = verdictFor({
        periodRows,
        periodDays,
        lookbackRows,
        firstSeen: seen.get(article) ?? null,
        lookbackStart: lookback.start,
      })
      if (!verdict) {
        stats.failedQualify += 1
        continue
      }
      labels.set(article, verdict)
      if (verdict === RETURNING_ARTICLE_LABEL) stats.returning += 1
      else stats.new += 1
    }

    console.log(
      `  [article-status] ${from}..${to} (lookback ${lookback.start}..${lookback.end}): ` +
        `${stats.evaluated} evaluated, ${stats.new} new, ${stats.returning} returning, ` +
        `${stats.existing} existing, ${stats.failedQualify} below the movement threshold`
    )
    return { labels, lookback, stats }
  }, { seconds: 3600 })
}

export const NEW_ARTICLE_LABEL = 'New'
export const RETURNING_ARTICLE_LABEL = 'Returning'
export { NEW_FOR_DAYS, LOOKBACK_MONTHS, QUALIFY, BOUNDARY_DAYS }
