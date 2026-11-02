/**
 * The articles that belong to FM, and whether a recipe names them.
 *
 * WHY THIS EXISTS
 *
 * FM is a separate company. It has no forecast model, no sales series and no
 * product table here, so nothing the nine brands' recipe explosion produces
 * ever mentions an FM-only article. The page therefore appended those articles
 * from outbound and stamped them "No recipe - from outbound", which reads as
 * "no recipe exists for this" and is simply untrue: measured 22 Oct 2026, 37 of
 * the 87 FM articles ARE in the recipe master, under groups like
 * "FM Finished Item" that belong to no forecast brand.
 *
 * So two facts are read here, and nothing else changes:
 *
 *   fmOnlyArticles()       articles shipped to FM and to NO forecast brand
 *   recipeMasterArticles() every article number the recipe workbook names
 *
 * WHY "FM ONLY" AND NOT "ANY FM"
 *
 * Ten of the 87 also ship to a forecast brand - BISCUIT LOTUS CRUMBLE to YP,
 * CUTLLERY SET to SS, BAKING PAPER to BUR. Marking those FM would overwrite a
 * real brand on the row, and splitting them into a second FM row would
 * double-count FM's outbound, which the brand merge already includes once
 * (see calculations.js, "destinations belonging to no forecast brand ... are
 * bucketed and added once"). Decided 22 Oct 2026: leave those ten alone.
 */
import { config } from '../config.js'
import { executeQuery } from './client.js'

const val = (r, k) => r[k] ?? r[`[${k}]`]
const isConfigured = () => Boolean(config.warehouse?.datasetId && config.warehouse?.workspaceId)
const lit = (values) => values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(', ')

export const FM = 'FM'

let fmCache = null

/**
 * Articles that reach FM and no forecast brand at all.
 *
 * Membership, not quantity, and over all time - the same shape
 * `warehouseSourcedArticles` uses, for the same reason: which company an
 * article belongs to is not a question about the window on screen.
 */
export async function fmOnlyArticles() {
  if (!isConfigured()) return null
  if (fmCache) return fmCache

  const work = (async () => {
    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
  fact_outbound_line[Mapped Transfer To],
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${lit(config.warehouse.statuses)}}
  ),
  "Qty", SUM(fact_outbound_line[Action Base Qty])
)`,
      config.warehouse.datasetId,
      { bulk: true, workspace: config.warehouse.workspaceId }
    )

    const brands = new Set(config.brands.map((b) => b.chain ?? b.code))
    const toFm = new Set()
    const toBrand = new Set()
    for (const r of rows) {
      const article = String(val(r, 'Article No.') ?? '').trim()
      if (!article) continue
      // A line that moved nothing is not a shipment - the same test the
      // outbound copy applies, so the two agree about what counts.
      if (!((Number(val(r, 'Qty')) || 0) > 0)) continue
      const dest = String(val(r, 'Mapped Transfer To') ?? '').trim()
      if (dest === FM) toFm.add(article)
      else if (brands.has(dest)) toBrand.add(article)
    }
    for (const a of toBrand) toFm.delete(a)
    return toFm
  })()

  fmCache = work
  work.catch(() => {
    fmCache = null
  })
  return work
}

let recipeCache = null

/**
 * Every article number the recipe workbook names, whoever owns the recipe.
 *
 * Read from ONE brand model on purpose. 'RECIPE TABLE' is a single shared
 * Excel master loaded identically into all nine - verified 28 Sep 2026, the
 * same ~262,000 rows in each - so asking nine times would cost nine queries
 * for one answer.
 *
 * Deliberately NOT filtered by recipe group. The question here is "does a
 * recipe name this article at all", which is exactly what the FM articles need
 * answered: theirs sit under FM and Love bird groups that belong to no
 * forecast brand, and that is why the explosion never produced them.
 */
export async function recipeMasterArticles() {
  if (recipeCache) return recipeCache

  const brand = config.brands[0]
  if (!brand?.datasetId) return null

  const work = (async () => {
    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS('RECIPE TABLE'[Item No.])`,
      brand.datasetId,
      { bulk: true }
    )
    const out = new Set()
    for (const r of rows) {
      const raw = String(val(r, 'Item No.') ?? '').trim()
      if (!raw) continue
      out.add(raw)
      // The workbook stores the number as an integer and the warehouse as
      // text, so "0102000003" and "102000003" are the same article. Both forms
      // are held rather than guessed at on lookup.
      const asNumber = Number(raw)
      if (Number.isFinite(asNumber)) out.add(String(asNumber))
    }
    return out
  })()

  recipeCache = work
  work.catch(() => {
    recipeCache = null
  })
  return work
}

/** Dropped with the other warehouse caches when the extract refreshes. */
export function forgetFmArticles() {
  fmCache = null
  recipeCache = null
}
