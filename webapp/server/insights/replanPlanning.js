/**
 * Safety stock policy, per article, from the replenishment planning sheet.
 *
 * WHAT THE SOURCE ACTUALLY HOLDS
 *
 * `'Replan Planning'[SS]` in the FM sales model. It is described as a safety
 * stock quantity and it is not one — audited 16 Sep 2026, it is a number of
 * DAYS, with two policy words standing in for the exceptions. Eight distinct
 * values across 2,246 rows:
 *
 *   "OnDemand"  608 rows      "15"  the bulk of the numerics
 *   "NoNeed"    447 rows      "10"   44      "3"  43
 *   "0"           2 rows      "5"    30      "7"   4
 *
 * The column is typed Text, 1,055 of its rows are words rather than numbers,
 * and no numeric value exceeds 15 with a median of 15. That range is what gives
 * it away: Clear Sauce Container moves 922,500 Each a month and its SS is 15.
 * Fifteen containers of cover against a million a month is meaningless; fifteen
 * DAYS is entirely sensible, and comes to 461,250 units.
 *
 * `Target Cover` beside it settles the reading. Its values are "30", "15",
 * "120", "10", "8" - plainly day counts - and it carries the same OnDemand /
 * NoNeed words in exactly the same 608 / 447 split. Two columns sharing one
 * vocabulary of day counts and policy words.
 *
 * So both figures are published: the policy as it is written, and the quantity
 * it implies. Neither is presented as the other.
 *
 * THE KEY
 *
 * `[Code]`, an integer holding the nine-digit article number. 2,224 distinct
 * values of which 2,154 match the article master - 97%. `[CODE.1]` is not a
 * key despite the name: it has exactly one distinct value, the literal string
 * "Unique". 22 rows carry no Code at all and are dropped.
 *
 * One row per article: 2,225 distinct codes across 2,246 rows.
 *
 * LEAD TIME AND DELIVERY FREQUENCY
 *
 * Asked for the same day, and read from the same sheet in the same pass.
 *
 * `[LEAD TIME]` is the clean one: typed Text but every row a number, seven
 * distinct values - 3 (1,147 rows), 7 (400), 15 (353), 30 (277), 90 (66), 5 (2)
 * - and one blank. Plainly days, and no policy words at all.
 *
 * `[DeliveryFreq]` shares the SS vocabulary exactly: the same "OnDemand" 608 and
 * "NoNeed" 447, then counts 0-10 with 1 the commonest at 928 rows. It is a count
 * of deliveries, not a span of days, so it is shown as the sheet writes it and
 * no unit is asserted over it - nothing in the model says per week or per month,
 * and guessing would put a wrong word on 1,190 rows.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { cached } from '../cache.js'

/** The sheet lives in the sales-only model, which is where it was built. */
const source = () => config.salesOnly?.find((b) => b.code === 'FM') ?? null

/**
 * A policy cell, read as a number of days plus the word it was written as.
 *
 * `NoNeed` is a decision, not a gap: the article is deliberately held without
 * safety stock, so it means zero days. `OnDemand` is the opposite - there is no
 * standing cover because it is ordered when needed - and zero would misreport
 * that as a policy of none, so it stays null and the quantity stays blank.
 */
export function readPolicy(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { text: '', days: null, policy: null }
  if (/^noneed$/i.test(text)) return { text, days: 0, policy: 'NoNeed' }
  if (/^ondemand$/i.test(text)) return { text, days: null, policy: 'OnDemand' }
  const n = Number(text.replace(/[,\s]/g, ''))
  return Number.isFinite(n) && n >= 0
    ? { text, days: n, policy: null }
    : // Anything else is a word nobody has told us the meaning of. Carried
      // through as written so it can be seen, and left out of the arithmetic.
      { text, days: null, policy: text }
}

/**
 * Article number to its planning policy: safety stock, lead time, delivery
 * frequency. One query, because all three sit on the same row of the same sheet.
 *
 * Null when the model is not configured, so the caller leaves the columns off
 * rather than showing a page of blanks that look like missing data.
 */
export async function safetyStockByArticle() {
  const fm = source()
  if (!fm?.datasetId) return null

  /*
   * Cached on nothing but itself: no window, no brand, one entry for everyone.
   * A safety stock policy changes when somebody revises the planning sheet,
   * which is nothing like per request.
   */
  return cached('replan:safety-stock', async () => {
    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS(
  'Replan Planning'[Code],
  'Replan Planning'[SS],
  'Replan Planning'[LEAD TIME],
  'Replan Planning'[DeliveryFreq],
  'Replan Planning'[last Supplier Name],
  'Replan Planning'[PURCH UNIT],
  'Replan Planning'[BASE UNIT]
)`,
      fm.datasetId,
      { bulk: true, workspace: fm.workspaceId || undefined }
    )

    const out = new Map()
    for (const r of rows) {
      const article = String(r.Code ?? '').trim()
      // 22 rows carry no article number and cannot be matched to anything.
      if (!article) continue
      const held = {
        ss: readPolicy(r.SS),
        lead: readPolicy(r['LEAD TIME']),
        freq: readPolicy(r.DeliveryFreq),
        /*
         * Descriptive, not calculated. The replenishment table shows who last
         * supplied the article and the two units it is counted in, and this
         * sheet is the only place in any of our models that carries them - so
         * they ride along on the query that was already being made rather than
         * becoming a second source.
         */
        supplier: String(r['last Supplier Name'] ?? '').trim() || null,
        purchaseUnit: String(r['PURCH UNIT'] ?? '').trim() || null,
        baseUnit: String(r['BASE UNIT'] ?? '').trim() || null,
      }
      /*
       * Only if the row says something. An article listed on the sheet with all
       * three cells empty is on it in name only, and stamping blanks over it
       * would be indistinguishable from stamping nothing.
       */
      if (!held.ss.text && !held.lead.text && !held.freq.text) continue
      out.set(article, held)
    }
    return out
  })
}

/**
 * The quantity a policy of `days` implies, at the rate the window forecasts.
 *
 * Deliberately derived from the WH forecast rather than from outbound: the
 * forecast is what the rest of the row is planned against, and outbound is the
 * thing being judged. Using the judged figure to size a buffer against itself
 * would move the buffer every time the warehouse had a bad month.
 *
 * Null rather than zero when there is nothing to derive from. No forecast means
 * no daily rate, and a policy of "OnDemand" means no standing cover - reporting
 * either as 0 would read as "no safety stock needed", which is a different
 * statement from "not known".
 */
export function safetyStockQty(days, windowForecast, windowDays) {
  if (days === null || days === undefined) return null
  /*
   * Nought days of cover is nought units whatever the rate, and saying so needs
   * no forecast. Answered before the guards below, or a `NoNeed` article with no
   * forecast this window would come back blank - "not known" - when the policy
   * has in fact told us the answer exactly.
   */
  if (days === 0) return 0
  const forecast = Number(windowForecast)
  const span = Number(windowDays)
  if (!Number.isFinite(forecast) || forecast <= 0 || !Number.isFinite(span) || span <= 0) return null
  return days * (forecast / span)
}
