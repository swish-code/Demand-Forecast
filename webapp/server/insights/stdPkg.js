/**
 * The standard package size an article is ordered in.
 *
 * Read from `'STD PKG'` in the FM SALES model, which a person maintains:
 *
 *   'STD PKG'[Article No.]    the article
 *   'STD PKG'[YIELD %]        how much one pack holds  <- the quantity
 *   'STD PKG'[ST.PACKAING]    what it is packed in     <- a unit, or a description
 *
 * THE ONE RULE THAT MATTERS: ONLY `YIELD %` IS A QUANTITY
 *
 * `ST.PACKAING` holds values like `35*45 PLASTIC BAG` and `30*40 PLASTIC BAG`.
 * Those are BAG DIMENSIONS IN CENTIMETRES. Reading a number out of them gives
 * 35 for Egyptian Bread and 30 for Slice Pita Bread, and rounding a bread
 * forecast up to a multiple of 35 because the bag is 35cm wide is a silent and
 * expensive mistake. Caught on 20 Sep 2026 while measuring this table, before
 * any of it reached a page.
 *
 * So a number is taken from `YIELD %` and from nowhere else. `ST.PACKAING` is
 * read only for a bare unit - `KG`, `EACH` - to tell us what `(24X1)` counts.
 * Anything containing `*` is ignored outright.
 *
 * WHAT YIELD LOOKS LIKE, AND WHAT EACH FORM MEANS
 *
 *   (24X1)        24 per pack; the unit comes from ST.PACKAING
 *   15 PCS        15 pieces
 *   5 KG          5 kilograms
 *   150 GM        150 grams   -> 0.15 KG
 *   18 PORTION    18 portions
 *   PORTION       a unit with no number  -> no rounding
 *   (blank)       -> no rounding
 *
 * UNITS HAVE TO AGREE WITH THE FORECAST
 *
 * The warehouse forecast is in the article's own base unit - Kilogram, Each or
 * Portion. A pack size in grams can round a Kilogram forecast, and pieces can
 * round an Each forecast, but 193 GM cannot round a forecast counted in Each
 * (TBL - Kunafa Jar) and 80 GM cannot round one counted in Portion (Yelo
 * Cookie). Those return null rather than a converted guess: nothing in any
 * model records what one portion weighs, so there is no honest conversion.
 *
 * COVERAGE, SO NOBODY IS SURPRISED BY A COLUMN OF DASHES
 *
 * Measured 20 Sep 2026: 67 rows, 30 of them articles the forecast actually
 * holds, 23 of those with a usable pack whose unit agrees. The other 1,189
 * articles - 93.4% of forecast volume - have no entry at all. The column is
 * therefore mostly blank today and fills in as the table is maintained; no code
 * change is needed for a new row to start working.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { cached } from '../cache.js'

const source = () => config.salesOnly?.find((b) => b.code === 'FM') ?? null

/** Grams are stored as grams and forecast in kilograms. */
const GRAMS_PER_KG = 1000

/**
 * Which forecast base units a pack unit may round.
 *
 * `EACH`, `PCS` and `PORTION` are all counts of whole things, and the sheet uses
 * them interchangeably - `(24X1)` against an Each forecast, `15 PCS` against
 * one counted in Portion. They are allowed to round each other. Weight may only
 * round weight.
 */
const COMPATIBLE = {
  KG: ['Kilogram'],
  GM: ['Kilogram'],
  PCS: ['Each', 'Portion'],
  EACH: ['Each', 'Portion'],
  PORTION: ['Portion', 'Each'],
  LOAF: ['Each'],
}

const UNIT = /\b(PORTION|PCS|EACH|KG|GM|LOAF)\b/i

/**
 * A pack size out of one `YIELD %` cell, or null.
 *
 * Deliberately narrow. Every form it accepts is one somebody actually typed;
 * anything else returns null and the article simply does not round, which is
 * the safe direction to fail in.
 */
export function readYield(rawYield, rawPackaging) {
  const y = String(rawYield ?? '').trim()
  if (!y) return null

  // `(24X1)` - a pack of 24. The unit is whatever ST.PACKAING says, because the
  // yield cell itself does not say.
  const grid = y.match(/\((\d+)\s*[xX]\s*(\d+)\)/)
  if (grid) {
    const n = Number(grid[1]) * Number(grid[2])
    if (!(n > 0)) return null
    return { pack: n, unit: unitOf(rawPackaging) ?? 'EACH' }
  }

  // `15 PCS`, `5 KG`, `150 GM`, `18 PORTION`.
  const withUnit = y.match(/^(\d+(?:\.\d+)?)\s*(PORTION|PCS|EACH|KG|GM|LOAF)\b/i)
  if (withUnit) {
    const n = Number(withUnit[1])
    if (!(n > 0)) return null
    const unit = withUnit[2].toUpperCase()
    // Grams are converted here so everything downstream is in the forecast's
    // own unit and no caller has to remember which it got.
    return unit === 'GM' ? { pack: n / GRAMS_PER_KG, unit: 'KG' } : { pack: n, unit }
  }

  /*
   * A bare unit with no number - `PORTION` on its own - means "counted in
   * portions", not "one portion per pack". No number, no rounding.
   *
   * And no fallback to "any digits anywhere": that is exactly what pulled 35
   * out of `35*45 PLASTIC BAG`.
   */
  return null
}

/** A unit out of ST.PACKAING, ignoring anything that looks like a dimension. */
function unitOf(rawPackaging) {
  const p = String(rawPackaging ?? '').trim()
  // `35*45 PLASTIC BAG` is a size in centimetres, not a package unit.
  if (!p || p.includes('*')) return null
  const m = p.match(UNIT)
  return m ? m[1].toUpperCase() : null
}

/** Can this pack unit round a forecast counted in `baseUnit`? */
export function canRound(unit, baseUnit) {
  if (!unit || !baseUnit) return false
  return (COMPATIBLE[unit] ?? []).includes(String(baseUnit))
}

/**
 * Round a forecast up to whole packs.
 *
 * Up, not to nearest: a part pack cannot be ordered, and ordering less than the
 * forecast is the one direction that causes a stockout. Zero stays zero - an
 * article that needs nothing does not need one pack of nothing.
 */
export function roundToPack(qty, pack) {
  /*
   * A missing quantity has no rounded answer, and must not become zero.
   *
   * Checked before Number(), because `Number(null)` is 0 and `Number('')` is 0
   * — both of which would sail through the finite check below and report "order
   * nothing" for an article whose forecast is simply unknown.
   */
  if (qty === null || qty === undefined || qty === '') return null
  const n = Number(qty)
  const p = Number(pack)
  if (!Number.isFinite(n) || !Number.isFinite(p) || p <= 0) return null
  if (n <= 0) return 0
  return Math.ceil(n / p) * p
}

/**
 * Article number to `{ pack, unit }`, or null when there is no model to ask.
 *
 * Null rather than an empty Map so the caller can leave the column off entirely
 * rather than show a page of dashes that look like missing data when the real
 * answer is "this model was not reachable".
 */
export async function packByArticle() {
  const fm = source()
  if (!fm?.datasetId) return null

  /*
   * Cached on nothing but itself. A standard package size changes when somebody
   * edits the sheet, which is nothing like per-request.
   */
  return cached('std-pkg', async () => {
    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS(
  'STD PKG'[Article No.],
  'STD PKG'[ST.PACKAING],
  'STD PKG'[YIELD %]
)`,
      fm.datasetId,
      { bulk: true, workspace: fm.workspaceId || undefined }
    )

    const out = new Map()
    for (const r of rows) {
      const article = String(r['Article No.'] ?? '').trim()
      if (!article) continue
      const parsed = readYield(r['YIELD %'], r['ST.PACKAING'])
      if (!parsed) continue
      out.set(article, parsed)
    }
    return out.size ? out : null
  })
}
