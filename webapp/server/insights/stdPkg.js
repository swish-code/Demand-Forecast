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

/**
 * Which operation's entries are trusted, from the sheet's `FROM` column.
 *
 * Confirmed on 26 Sep 2026: the central kitchen's rows are the reviewed ones.
 * A constant rather than a config value because it is a statement about the
 * sheet, and changing it should be a decision somebody makes on purpose.
 */
const SOURCE = 'CK'

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
/**
 * A pack size out of ONE cell, or null.
 *
 * Deliberately narrow. Every form it accepts is one somebody actually typed;
 * anything else returns null and the article simply does not round, which is
 * the safe direction to fail in.
 */
function quantityIn(cell, rawPackaging) {
  const y = String(cell ?? '').trim()
  if (!y) return null

  /*
   * A dimension or a rate is not a pack size, whichever column it turns up in.
   *
   * `35*45 PLASTIC BAG` is centimetres. `40 gm/por` is a per-portion weight
   * with no pack count behind it. Both contain a perfectly readable number and
   * neither is the number being asked for, so they are refused before any
   * pattern gets the chance to find something in them.
   */
  if (y.includes('*') || y.includes('/')) return null

  // `(24X1)` - a pack of 24. The unit is whatever ST.PACKAING says, because the
  // yield cell itself does not say.
  const grid = y.match(/\((\d+)\s*[xX]\s*(\d+)\)/)
  if (grid) {
    const n = Number(grid[1]) * Number(grid[2])
    if (!(n > 0)) return null
    return { pack: n, unit: unitOf(rawPackaging) ?? 'EACH' }
  }

  // `15 PCS`, `5 KG`, `150 GM`, `18 PORTION` - and the revised sheet's
  // lower-case `2.5 kg`, `500 gm`, which the /i flag already covered.
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
   * A bare unit with no number - `PORTION` or `por` on its own - means
   * "counted in portions", not "one portion per pack". No number, no rounding.
   *
   * And no fallback to "any digits anywhere": that is exactly what pulled 35
   * out of `35*45 PLASTIC BAG`.
   */
  return null
}

/**
 * The pack size for one row, from whichever cell carries it.
 *
 * `YIELD %` first, because where both are filled that is the original sheet and
 * the other cell is the container. `ST.PACKAING` second, which is where the
 * revised sheet puts it - and where the dimension guard above earns its keep.
 */
export function readYield(rawYield, rawPackaging) {
  return quantityIn(rawYield, rawPackaging) ?? quantityIn(rawPackaging, rawPackaging)
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
  'STD PKG'[FROM],
  'STD PKG'[ST.PACKAING],
  'STD PKG'[YIELD %]
)`,
      fm.datasetId,
      { bulk: true, workspace: fm.workspaceId || undefined }
    )

    /*
     * Only the rows the central kitchen maintains.
     *
     * The sheet gained a `FROM` column on 26 Sep 2026 saying which operation an
     * entry came from - CK 517 rows, BK 53, FCT 14 - and the business confirmed
     * that the CK entries are the reviewed ones. The others are left alone
     * rather than trusted: an unreviewed pack size does not rescue an article
     * that would otherwise show its plain forecast, and it can silently inflate
     * an order.
     *
     * This also settles the duplicates deterministically. Three articles carry
     * two rows each - 106400920, 106400921 and 106400662 - one CK with a real
     * quantity and one FCT with a bare `KG`. Without the filter the winner is
     * whichever row the query returns last, which is nothing anybody chose.
     */
    const out = new Map()
    let skippedSource = 0
    for (const r of rows) {
      const article = String(r['Article No.'] ?? '').trim()
      if (!article) continue
      if (String(r.FROM ?? '').trim().toUpperCase() !== SOURCE) {
        skippedSource += 1
        continue
      }
      const parsed = readYield(r['YIELD %'], r['ST.PACKAING'])
      if (!parsed) continue
      out.set(article, parsed)
    }
    console.log(
      `  [std-pkg] ${rows.length} rows, ${skippedSource} not ${SOURCE}, ${out.size} usable pack sizes`
    )
    return out.size ? out : null
  })
}
