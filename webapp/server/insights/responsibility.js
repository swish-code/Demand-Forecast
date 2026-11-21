import { config } from '../config.js'
import { cached } from '../cache.js'
import { executeQuery } from '../powerbi/client.js'
import { warehouseToCostCentre } from '../powerbi/orderingChannel.js'
import { CHANNEL, classifyInbound, costCentreKind, isWarehouse, pathLabel } from './orderingChannel.js'
import { SOURCE } from './productionSource.js'

/**
 * Which department is RESPONSIBLE for an article, rather than where it last was.
 *
 * ESTABLISHED BY AUDIT, 18 NOV 2026, and measured before it was written.
 *
 * The site pages used to be pinned with `Prod_Source` alone, and that worked
 * only because they also carried `lockNodeTypes: ['PA','PREP']`. `Prod_Source`
 * means "the last PRODUCTION SITE to issue this" - which for a PA article is
 * where it was made, and for a RAW one is merely where it passed through. The
 * node-type lock hid the difference by keeping RAW off those pages entirely.
 *
 * Removing that lock exposed it. Measured over 2026-05-01..2026-10-31, pinning
 * on `Prod_Source` alone put `SPONGE PAD`, `SUGAR DARK BROWN`, `YIEST DRY
 * SAF-INSTANT` and `HP 106A CARTRIDGE` on the Bakery and Production pages - the
 * bakery handing on a sack of sugar is not the bakery making anything. So the
 * production test now asks for a PA row as well as the site, and those four
 * articles land on Stock Article alone, where the warehouse supplies them.
 *
 * THE THREE TESTS, and the evidence each one rests on:
 *
 *   Central Warehouse   the warehouse has EVER issued this article
 *                       (`warehouseSourcedArticles`, no time window - an
 *                       article it supplied last year is still its
 *                       responsibility), or a supplier delivers it straight to
 *                       a brand or store, which procurement still owns.
 *
 *   Central Kitchen     a PA row whose `Prod_Source` is the kitchen - it is
 *                       MADE there - or an article a supplier delivers into
 *                       CKU/CPU, which the kitchen buys for itself.
 *
 *   Swish Bakery        the same two tests, for the bakery.
 *
 * Nothing here reads a brand-to-brand transfer, so one brand lending stock to
 * another creates no departmental responsibility anywhere - which is what the
 * old "transferred from" reading got wrong, and why it is not used.
 *
 * AN ARTICLE CAN BELONG TO SEVERAL DEPARTMENTS, deliberately. `BBT WET BATTER`
 * is made at the bakery AND supplied by the warehouse, and both departments
 * genuinely have work to do about it. Measured: 24 articles carry more than one
 * responsibility. Their rows are therefore shown on more than one page and
 * MUST NOT be added across pages.
 */

export const DEPARTMENT = {
  WAREHOUSE: 'Central Warehouse',
  CK: 'Central Kitchen / CPU',
  BAKERY: 'Swish Bakery',
  OTHERS: 'Others',
}

/** Display order, and the set a request may legitimately name. */
export const DEPARTMENTS = [
  DEPARTMENT.WAREHOUSE,
  DEPARTMENT.CK,
  DEPARTMENT.BAKERY,
  DEPARTMENT.OTHERS,
]

/**
 * The cost centres each buying department receives its own deliveries at.
 *
 * Spelled as `fact_po_period_lifecycle[Cost Center]` holds them, which is the
 * rolled-up value `warehouseToCostCentre` resolves a receiving location to.
 */
const BUYS_AT = new Map([
  [DEPARTMENT.CK, 'CKU/CPU'],
  [DEPARTMENT.BAKERY, 'SWISH BAKERY'],
])

/** The production site each department's own output is classified under. */
const MAKES_AT = new Map([
  [DEPARTMENT.CK, SOURCE.CK],
  [DEPARTMENT.BAKERY, SOURCE.BAKERY],
])

/**
 * Prep steps belong to the two departments that do prep work.
 *
 * A prep step carries no article number in any of the nine models - 45,312 of
 * 45,312 rows blank, measured 3 Nov 2026 - so no movement can ever be joined to
 * it and no test below can place it. It is therefore placed by what it IS.
 *
 * THIS IS AN EXEMPTION, NOT AN ATTRIBUTION: nothing in the data says which of
 * the two sites made a given prep step, which is why the same step appears on
 * both pages and why their PREP totals must never be added together. The same
 * rule `PREP_SOURCES` has always applied, carried over unchanged.
 */
const PREP_DEPARTMENTS = [DEPARTMENT.CK, DEPARTMENT.BAKERY]

const norm = (v) => String(v ?? '').trim()
const eq = (a, b) => norm(a).toUpperCase() === norm(b).toUpperCase()
const val = (r, k) => r[k] ?? r[`[${k}]`]

/** The latest six WHOLE months - the window `productionSource.js` uses. */
function window6(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1))
  const iso = (d) => d.toISOString().slice(0, 10)
  return { from: iso(start), to: iso(end) }
}

const daxDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}

/**
 * article -> the cost centres a SUPPLIER delivered it to, in the window.
 *
 * One read of `fact_grn_line`, aggregated in the model to article x receiving
 * location - about 3,000 rows over six months, measured 18 Nov 2026. It is the
 * inbound half of what `channelsForWindow` already fetches, but it cannot share
 * that call: `channelsForWindow` reads the READER'S window, and page membership
 * has to stand on a fixed one or a short date selection would empty the pages.
 *
 * Cached on the window, so it is fetched once per process per month rather than
 * per request - the same treatment `productionSourceByArticle` gets.
 *
 * IT THROWS ON FAILURE RATHER THAN ANSWERING EMPTY - fixed 21 Nov 2026.
 *
 * The read used to catch its own error and return null, which this function
 * then turned into an empty Map. That is a successfully resolved answer as far
 * as `cached` is concerned, so the emptiness was STORED for the whole window:
 * one throttled minute and every article a site buys direct - TOMATO FRESH,
 * DILL LEAVES FRESH and the rest - silently stopped being that site's business
 * and moved to Others, for a month, with nothing on screen to say so.
 *
 * Throwing keeps the cache empty and lets the caller tell "nobody buys direct"
 * from "we could not ask", which is the distinction the whole guard rests on.
 */
export async function purchasesByArticle({ now = new Date() } = {}) {
  const w = config.warehouse
  if (!w?.datasetId || !w?.workspaceId) return new Map()
  const { from, to } = window6(now)

  return cached(`responsibility:purchases:${from}:${to}`, async () => {
    const mapping = await warehouseToCostCentre().catch(() => null)
    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS(
  fact_grn_line[Article No.],
  fact_grn_line[Warehouse],
  FILTER(
    ALL(fact_grn_line[GRN Delivery Date]),
    fact_grn_line[GRN Delivery Date] >= ${daxDate(from)}
      && fact_grn_line[GRN Delivery Date] <= ${daxDate(to)}
  ),
  "LastQty",
    VAR d = CALCULATE(MAX(fact_grn_line[GRN Delivery Date]),
      FILTER(fact_grn_line, fact_grn_line[GRN Base Qty] <> 0))
    RETURN CALCULATE(SUM(fact_grn_line[GRN Base Qty]),
      fact_grn_line[GRN Delivery Date] = d)
)`,
      w.datasetId,
      { bulk: true, workspace: w.workspaceId }
    )

    const out = new Map()
    for (const r of rows ?? []) {
      const article = norm(val(r, 'Article No.'))
      if (!article) continue
      const where = norm(val(r, 'Warehouse')).toLowerCase()
      const cc = mapping?.get(where) ?? null
      // An unmapped receiving location is not evidence of a purchase; the
      // Transaction Type column surfaces it as Needs Review instead.
      if (!cc) continue
      /*
       * The SAME test the Transaction Type column applies, so the two can never
       * disagree about what a Purchase is. It excludes deliveries into the
       * warehouse itself, which are ordinary purchasing rather than a direct
       * supply, and negative lines, which are returns.
       */
      if (classifyInbound({ costCentre: cc, qty: Number(val(r, 'LastQty')) || 0 }) !== CHANNEL.DIRECT)
        continue
      if (!out.has(article)) out.set(article, new Set())
      out.get(article).add(pathLabel(cc))
    }

    console.log(`  [responsibility] purchases ${from}..${to}: ${out.size} articles`)
    return out
  })
}

/** The two directions, and the value shown when an article did both. */
export const DIRECTION = { IN: 'Inbound', OUT: 'Outbound' }
export const DIRECTIONS = [DIRECTION.IN, DIRECTION.OUT]

/**
 * article -> { from: Set(costCentre), to: Set(costCentre) } over the window.
 *
 * Added 21 Nov 2026, for the inbound half of the three department pages.
 *
 * WHY THIS IS ITS OWN READ rather than `channelsForWindow`'s data, which
 * already holds both ends of every transfer: that function reads the READER'S
 * window and keeps only the LATEST movement. Page membership cannot depend on
 * either - a one-week date selection would empty the pages, and an article's
 * owner is not decided by whichever movement happened to be last. So this asks
 * the same fixed six whole months the rest of the rule uses, and keeps every
 * movement in it rather than the last.
 *
 * One aggregated read, article x source x destination: 3,989 rows for October
 * alone, measured 21 Nov 2026, so roughly 20,000 over six months. Cached on
 * the window like its neighbours, so it is fetched once per process per month.
 *
 * Throws rather than resolving empty, for the reason `purchasesByArticle`
 * does: an empty map cached for a month would quietly unclaim every article a
 * facility only receives.
 */
export async function transfersByArticle({ now = new Date() } = {}) {
  const w = config.warehouse
  if (!w?.datasetId || !w?.workspaceId) return new Map()
  const { from, to } = window6(now)

  return cached(`responsibility:transfers:${from}:${to}`, async () => {
    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
  fact_outbound_line[Mapped Cost Center/Store],
  fact_outbound_line[Mapped Transfer To],
  DATESBETWEEN(dim_date[Date], ${daxDate(from)}, ${daxDate(to)}),
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${(w.statuses ?? []).map((s) => `"${s}"`).join(', ')}}
  ),
  "Qty", SUM(fact_outbound_line[Action Base Qty])
)`,
      w.datasetId,
      { bulk: true, workspace: w.workspaceId }
    )

    const out = new Map()
    for (const r of rows ?? []) {
      const article = norm(val(r, 'Article No.'))
      if (!article) continue
      // A zero or negative line is a correction, not a movement.
      if (!((Number(val(r, 'Qty')) || 0) > 0)) continue
      const src = norm(val(r, 'Mapped Cost Center/Store'))
      const dst = norm(val(r, 'Mapped Transfer To'))
      /*
       * PAIRS, not two sets - 21 Nov 2026.
       *
       * This held `{ from: Set, to: Set }`, which answers "did it ever leave
       * here" and "did it ever arrive here" and nothing else. The moment the
       * two ends are filed separately, the fact that `CKU/CPU -> Central
       * Warehouse` was ONE movement is gone, so a row reading "Inbound +
       * Outbound" could not say where the inbound came from. Keeping the pair
       * costs one object per movement and answers both questions.
       */
      if (!src && !dst) continue
      if (!out.has(article)) out.set(article, [])
      out.get(article).push({ from: src, to: dst })
    }

    console.log(`  [responsibility] transfers ${from}..${to}: ${out.size} articles`)
    return out
  })
}

/** Is this cost centre the department's own facility? */
function isFacility(cc, dept) {
  if (!cc) return false
  // The warehouse arrives under several spellings; `isWarehouse` knows them.
  if (dept === DEPARTMENT.WAREHOUSE) return isWarehouse(cc)
  return eq(cc, MOVES_AS.get(dept))
}

/** Did anything arrive at / leave this department's facility? */
const movedInto = (moves, dept) => (moves ?? []).some((m) => isFacility(m.to, dept))
const movedOutOf = (moves, dept) => (moves ?? []).some((m) => isFacility(m.from, dept))

/**
 * Who this facility received from, or sent to.
 *
 * `direction` is 'in' or 'out'. Returns the OTHER end of each movement the
 * facility was part of - which is the question "Inbound + Outbound" raises and
 * could not answer while the two ends were filed in separate sets.
 *
 * Spelled with `pathLabel`, so the warehouse reads "Central Warehouse" here
 * exactly as it does in the Path column rather than "MAIN WAREHOUSE".
 */
export function counterpartiesFor(article, dept, transfers, direction) {
  if (!dept || dept === DEPARTMENT.OTHERS) return []
  const moves = transfers?.get(norm(article))
  if (!moves?.length) return []
  const out = new Map()
  for (const m of moves) {
    const mine = direction === 'in' ? m.to : m.from
    const theirs = direction === 'in' ? m.from : m.to
    if (!isFacility(mine, dept) || !theirs) continue
    // A facility moving stock to itself is a re-bin, not a counterparty.
    if (isFacility(theirs, dept)) continue
    const label = pathLabel(theirs)
    if (label) out.set(label.toUpperCase(), label)
  }
  return [...out.values()].sort()
}

/**
 * Which way an article moved, from one department's point of view.
 *
 * Returns 'Inbound', 'Outbound', 'Inbound + Outbound', or null where that
 * facility neither sent nor received it - which is normal for an article it
 * only buys or only makes, and is shown as a dash rather than as a direction.
 *
 * `Others` has no facility, so it has no direction either.
 */
export function transferTypeFor(article, dept, transfers) {
  if (!dept || dept === DEPARTMENT.OTHERS) return null
  const moves = transfers?.get(norm(article))
  if (!moves?.length) return null
  const out = movedOutOf(moves, dept)
  const into = movedInto(moves, dept)
  if (out && into) return `${DIRECTION.IN} + ${DIRECTION.OUT}`
  if (into) return DIRECTION.IN
  if (out) return DIRECTION.OUT
  return null
}

/**
 * Which departments are responsible for ONE row.
 *
 * Per row rather than per article, because an article can be a PA line in one
 * recipe and a RAW line in another, and only the PA line is the kitchen's
 * output. Taking the article's node types in aggregate would put the raw
 * reading on a production page too.
 *
 * Returns a Set, possibly holding several departments - see the header.
 */
export function departmentsForRow({
  article,
  nodeType,
  whSupplied,
  prodSource,
  purchases,
  transfers,
}) {
  const type = norm(nodeType).toUpperCase()
  // Placed by what it is, because nothing can look it up - see PREP_DEPARTMENTS.
  if (type === 'PREP') return new Set(PREP_DEPARTMENTS)

  const id = norm(article)
  if (!id) return new Set([DEPARTMENT.OTHERS])

  const boughtAt = purchases?.get(id) ?? null
  const moved = transfers?.get(id) ?? null
  const held = new Set()

  // The warehouse: it supplies the article, or procurement buys it straight in.
  if (whSupplied?.has(id)) held.add(DEPARTMENT.WAREHOUSE)
  else if (boughtAt && [...boughtAt].some((cc) => costCentreKind(cc) === 'brand'))
    held.add(DEPARTMENT.WAREHOUSE)

  // The two making departments: they make it, or they buy it for themselves.
  for (const dept of MAKES_AT.keys()) {
    const makes = type === 'PA' && prodSource?.get(id) === MAKES_AT.get(dept)
    const buys = boughtAt && [...boughtAt].some((cc) => eq(cc, BUYS_AT.get(dept)))
    if (makes || buys) held.add(dept)
  }

  /*
   * RECEIVING IT IS RESPONSIBILITY TOO - 21 Nov 2026, on request.
   *
   * Every test above asks what a facility SENDS OUT, MAKES or BUYS. An article
   * transferred INTO it - the warehouse restocking the kitchen, the kitchen
   * sending a prep to the bakery - belonged to nobody by those tests, so the
   * receiving facility never saw it.
   *
   * Measured over October 2026: 339 articles reached the kitchen and left it
   * again by no route it owned, and 148 reached the bakery. Both pages were
   * simply missing them. (The warehouse was missing one, because almost
   * everything it receives it also issues.)
   *
   * Deliberately NOT applied to brand-to-brand movements: `isFacility` only
   * matches the three Swish facilities, so one brand sending stock to another
   * still creates no responsibility anywhere. That rule is unchanged.
   */
  if (moved) {
    for (const dept of [DEPARTMENT.WAREHOUSE, ...MAKES_AT.keys()]) {
      if (movedInto(moved, dept)) held.add(dept)
    }
  }

  if (!held.size) held.add(DEPARTMENT.OTHERS)
  return held
}

/**
 * Does this row belong on a page pinned to `wanted`?
 *
 * `wanted` is a Set of department names. An empty set means "nothing is
 * permitted", which is what an account with no qualifying grant resolves to -
 * and it must answer no rather than yes, or a restriction would open the page
 * it was meant to close.
 */
export function rowBelongs(departments, wanted) {
  if (!wanted) return true
  for (const d of departments) if (wanted.has(d)) return true
  return false
}

/**
 * The cost centre each department appears as in a Path cell.
 *
 * `Others` is absent deliberately: it is the absence of a department, so there
 * is no leg that belongs to it and nothing to narrow its paths to.
 */
const MOVES_AS = new Map([
  [DEPARTMENT.WAREHOUSE, 'Central Warehouse'],
  [DEPARTMENT.CK, 'CKU/CPU'],
  [DEPARTMENT.BAKERY, 'SWISH BAKERY'],
])

/** Said where the article moved in the window, but never through this page's own site. */
const noLegLine = (department) => `No ${department} movement in this window`

/**
 * The Path cell, narrowed to the legs the PAGE'S OWN department took part in.
 *
 * WHY THIS EXISTS - 18 NOV 2026, on the user seeing it.
 *
 * The Path column is the article's LATEST movement in the reader's date range;
 * page membership is departmental responsibility, which has no date range at
 * all (see the header). The two therefore disagree constantly and legitimately:
 * an article the warehouse supplies, whose most recent movement happened to be
 * `SS → SS-PLC`, is correctly on Stock Article and printed a leg belonging to
 * nobody on that page. Read down the column it looks like a leaking filter.
 *
 * So the cell is narrowed to legs with this department at one end or the other.
 * BOTH ends count: `SWISH BAKERY → Central Warehouse` is stock arriving into
 * the warehouse, which is exactly the warehouse's business to see.
 *
 * NOTHING IS DROPPED FROM THE PAGE by this - it is a column, not a filter. An
 * article whose every leg belonged to another department keeps its row and is
 * told so in words, because a cell emptied by a rule reads as missing data.
 * That was measured on the Transaction Type column on 5 Nov and is the same
 * mistake `pathsForBrand` fixed with its own note line.
 *
 * The notes `pathsForBrand` already added - "Not transferred to BBT" - carry no
 * arrow and are about the row's BRAND, not about any department. They are kept
 * whatever happens here; narrowing by department must not answer a question
 * about a brand.
 */
export function pathsForDepartment(paths, department) {
  const site = MOVES_AS.get(department)
  const list = (paths ?? []).filter(Boolean).map(String)
  if (!site || !list.length) return list

  const want = norm(site).toUpperCase()
  const legs = list.filter((p) => p.includes('→'))
  const notes = list.filter((p) => !p.includes('→'))
  // No leg at all means nothing moved; there is nothing to narrow or to report.
  if (!legs.length) return list

  const kept = legs.filter((p) =>
    p.split('→').some((end) => norm(end).toUpperCase() === want)
  )
  return kept.length ? [...kept, ...notes] : [noLegLine(department), ...notes]
}
