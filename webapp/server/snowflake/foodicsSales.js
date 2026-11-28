/**
 * BBT and Yelo sales, read directly from Foodics data in Snowflake - 25 Nov 2026.
 *
 * Asked for: "change the PM theoretical calculation for BBT and Yelo to take
 * the required quantities directly from Snowflake instead of Power BI." The
 * recipe still comes from the recipe file (Power BI's 'RECIPE TABLE'), by the
 * owner's decision the same day: Snowflake's only recipe source is a copy of
 * MC's recipe tables that stopped syncing on 6 May 2026.
 *
 * SOURCE - the same objects the Power BI sales query reads:
 *
 *   AIRBYTE_FOODICS.<schema>.V_ORDER_PRODUCTS_COMBINED   one row per sold line
 *   AIRBYTE_FOODICS.<schema>.BRANCHES                    NAME = "<code>-<brand>"
 *
 *   BBT -> AIRBYTE_BBT     YP (Yelo) -> AIRBYTE_YELO
 *
 * THE RULES, each measured on 25 Nov 2026 against October 2026:
 *
 *   Completed orders only - ORDER_STATUS 4 or 5, as the Power Query filters.
 *
 *   The PLU is MAPPED_SKU. It is the Snowflake view's own cleaned product id,
 *   and it IS Power BI's Clean_ItemID: 418 of 445 BBT ids and 698 of 750 Yelo
 *   ids carry identical quantities on both sides. Nothing needs reproducing.
 *
 *   EVERY line counts, PRODUCT and OPTION. This is where Snowflake and Power
 *   BI differ, and MC decides it: MC's own till history (HIS_BONIER) received
 *   every BBT PRODUCT line (393,975 units, 165 of 168 PLUs within 3%), and
 *   where one PLU is both a product and an option line MC holds the SUM of the
 *   two (PLU 922: 2,941 + 593 = 3,534). Power BI's BBT sales hold the OPTION
 *   lines alone - exactly 827,992 of Snowflake's 1,221,967 units - so every
 *   combo, fries and burger sold as a product line was missing from BBT's PM.
 *
 *   The outlet is the part of BRANCHES.NAME before the "-", as the Power
 *   Query splits it ("ADL-BBT" -> ADL), which is the KST MAP branch code -
 *   with the one rename in BRANCH_ALIASES below.
 *
 * YELO'S COMBO PIZZAS: 102,377 OPTION units in October (e.g. 232020220303
 * "Medium NY" in "Buy 1 Get 1 Free") carry a recipe PLU here, where Power BI
 * files them under ids with no recipe (2320202), so PM never costed them. MC's
 * till history does not hold them under these PLUs either, yet MC's own
 * theoretical agrees with the Snowflake PM to 97.5% for October - MC costs
 * them by another route. Counted.
 *
 * RESULT, October 2026, PM vs MC accuracy (1 - sum|PM - MC| / sum MC):
 *   BBT  20.0% -> 92.6%     Yelo  62.4% -> 97.5%
 * and for 1-24 November: BBT 19.7% -> 93.4%, Yelo 67.5% -> 97.5%.
 */
import { cached } from '../cache.js'
import { sfSelect, snowflakeReadConfigured } from './read.js'

/** The brands whose PM sales come from Snowflake, and where. */
export const SNOWFLAKE_SALES = new Map([
  ['BBT', 'AIRBYTE_BBT'],
  ['YP', 'AIRBYTE_YELO'],
  ['MM', 'AIRBYTE_MSH'],
  ['TBL', 'AIRBYTE_TBL'],
])

/*
 * MM AND TABEL - 26 Nov 2026, on request: "take the theoretical quantity for
 * MM and TBL directly from Snowflake ... Clean_ItemID instead of ITEM_TABLE".
 *
 * Their schemas have no MAPPED_SKU, so the PLU is the SKU's digits - and it is
 * PRODUCT_SKU on every line, because on an OPTION line the view carries the
 * option's own SKU in PRODUCT_SKU as well as MODIFIER_OPTION_SKU. Measured 26
 * Nov 2026, November: TBL option TB40002150 has PRODUCT_SKU = MODIFIER_OPTION_SKU
 * = TB40002150.
 *
 * The model's literal Clean_ItemID - digits of PRODUCT_SKU & "_" &
 * MODIFIER_OPTION_SKU - therefore writes every option's SKU twice
 * ("4000215040002150") and met 0% of option units on a PLU MC or the recipe
 * file holds, for both brands. The SKU's digits met 100% (MM) and 84% (TBL),
 * and per PLU they equal Power BI's current ITEM TABLE id exactly - so for MM
 * the switch changes no figure; it removes the ITEM TABLE dependency.
 *
 * The other 16% of TBL is fixed by `TBL_BROWN_RICE` below.
 */
const SKU_EXPR = new Map([
  ['MM', `REGEXP_REPLACE(TO_VARCHAR(o.PRODUCT_SKU), '[^0-9]', '')`],
  ['TBL', `REGEXP_REPLACE(TO_VARCHAR(o.PRODUCT_SKU), '[^0-9]', '')`],
])
const skuExpr = (brand) => SKU_EXPR.get(brand) ?? 'TO_VARCHAR(o.MAPPED_SKU)'

/**
 * TABEL'S BROWN-RICE CHOICES reach MC under a different PLU than Foodics' SKU.
 *
 * The option lines TB3000-TB3006 / TB4000-TB4006 (and TL3003, TL4003: the same
 * digits) are "Regular" and "Half" brown rice inside the bowls. MC holds none
 * of 3000-4006; it holds 50003000-50004006, named "Regular / Half Browen Rice
 * For <bowl>", with recipes - and Foodics holds no 5000xxxx code. Measured 26
 * Nov 2026, all 14 codes, October and November: units identical in total and
 * outlet by outlet (e.g. 3003: 2,961 = MC 50003003 2,961 in November). No other
 * TBL code lies in 3000-4999, and every other short TBL code (1648-1652,
 * 9407-9410, product lines) is held by MC as it stands, so the rule touches
 * only these. Neither Snowflake nor MC stores the translation - it happens in
 * the till interface - hence the rule here. Power BI files these under the
 * same short codes, so they never met a recipe there either (~10,700 units a
 * month uncosted).
 *
 * The "Brown Rice" choice codes ending 5000 (TL5000, Th5000 ...) exist neither
 * in MC nor in the recipe file and are left as they are.
 */
export function mcPlu(brand, plu, lineType) {
  if (String(brand).toUpperCase() !== 'TBL' || String(lineType).toUpperCase() !== 'OPTION') return plu
  if (!/^\d{4}$/.test(plu)) return plu
  const n = Number(plu)
  return n >= 3000 && n <= 4999 ? `5000${plu}` : plu
}

/**
 * Foodics outlet codes that MC's KST MAP writes differently.
 *
 * Yelo SBH is SBS: the 62,670 units Snowflake files under SBH in October are
 * exactly the 62,670 Power BI files under SBS, and SBS is the KST MAP code.
 * BBT's YRD is MC's VIB (Vibes) and Yelo's MOD is MC's DFC: measured 26 Nov
 * 2026, November, MC's till files exactly Foodics' units under them (BBT
 * 79,010 = 79,010; Yelo 3,265 = 3,265), and no other MC outlet holds them.
 * (Until then YRD was left as is, having no KST MAP code of its own.)
 *
 * MM and TBL: the renames of the model's own CleanLocationID column, applied
 * to both brands there. Measured 26 Nov 2026, November: with them every outlet's
 * units equal Power BI's to the unit (MM QAD -> QDS 25,971; TBL HAW -> HWL 16,769).
 */
const ERMG_ALIASES = new Map([
  ['JAH', 'JHR'],
  ['TMHB', 'MHB'],
  ['HAW', 'HWL'],
  ['QAD', 'QDS'],
  ['SBH', 'SBS'],
])
/*
 * MM's "HOF/CAT" outlet is MC's catering cost centre. Measured 26 Nov 2026,
 * November: MC's MM catering till holds 1,781 units = Foodics CAT 397 +
 * HOF/CAT 1,376 (+8), and no other MC cost centre holds HOF/CAT's sales. Named
 * CAT here so the catering rule (no theoretical, either side) applies to it;
 * counted as an outlet of its own it was MM's entire Foodics-vs-MC sales gap.
 */
export const BRANCH_ALIASES = new Map([
  ['BBT', new Map([['YRD', 'VIB']])],
  ['YP', new Map([['SBH', 'SBS'], ['MOD', 'DFC']])],
  ['MM', new Map([...ERMG_ALIASES, ['HOF/CAT', 'CAT']])],
  ['TBL', ERMG_ALIASES],
])

/** True for a brand whose PM sales are read from Snowflake. */
export const salesFromSnowflake = (code) => SNOWFLAKE_SALES.has(String(code ?? '').trim().toUpperCase())

/** One PLU written one way: "0102" and "102" are the same id. */
export function canonPlu(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return /^\d+$/.test(s) ? String(BigInt(s)) : s
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const nextDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** Closed windows are held six hours; one that includes today, one hour. */
const ttlFor = (to) => (to < new Date().toISOString().slice(0, 10) ? 6 * 3600 : 3600)

/**
 * Fold Snowflake's rows into sale lines. Pure, so the rules are tested.
 *
 *   rows  [{ LOC, SKU, Q }]
 *   ->    { lines: [{ plu, branch, q }], unmapped: { q, rows } }
 *
 * A line with no MAPPED_SKU cannot meet a recipe; it is counted, not dropped
 * silently.
 */
export function foldSales(rows, brand = '') {
  const alias = BRANCH_ALIASES.get(String(brand).toUpperCase()) ?? new Map()
  const held = new Map()
  const unmapped = { q: 0, rows: 0 }
  for (const r of rows ?? []) {
    const q = Number(r.Q) || 0
    if (!q) continue
    const plu = mcPlu(brand, canonPlu(r.SKU), r.T)
    if (!plu) {
      unmapped.q += q
      unmapped.rows += 1
      continue
    }
    const raw = String(r.LOC ?? '').trim().toUpperCase()
    const branch = alias.get(raw) ?? raw
    const k = `${plu}|${branch}`
    held.set(k, (held.get(k) ?? 0) + q)
  }
  const lines = []
  for (const [k, q] of held) {
    const cut = k.indexOf('|')
    lines.push({ plu: k.slice(0, cut), branch: k.slice(cut + 1), q })
  }
  return { lines, unmapped }
}

/*
 * TODAY IS NEVER READ - 26 Nov 2026. Snowflake is live, so a window reaching
 * today held the day's sales so far, which MC does not have: it posts a day at
 * about 06:00 the next morning, and its month in progress runs to yesterday.
 * Measured 26 Nov 2026: 127 MM units of 26 Nov in PM with no MC counterpart.
 * Power BI never had them either (it refreshes once a day). Business dates are
 * Kuwait's, UTC+3.
 */
const kuwaitToday = (now = Date.now()) => new Date(now + 3 * 3_600_000).toISOString().slice(0, 10)

/** The exclusive end of a window [.., to]: the day after `to`, but never later than today. */
export function windowEnd(to, now = Date.now()) {
  const end = nextDay(to)
  const today = kuwaitToday(now)
  return end < today ? end : today
}

/**
 * Units sold per PLU per outlet for one brand over [from, to], inclusive.
 * Throws when Snowflake cannot be read, so a failure is never cached.
 */
export function snowflakeSales(code, from, to) {
  const brand = String(code ?? '').trim().toUpperCase()
  const schema = SNOWFLAKE_SALES.get(brand)
  if (!schema) throw new Error(`${brand} does not read its sales from Snowflake`)
  if (!snowflakeReadConfigured()) throw new Error('Snowflake (read) is not configured')
  const f = String(from ?? '').slice(0, 10)
  const t = String(to ?? '').slice(0, 10)
  if (!DAY.test(f) || !DAY.test(t) || t < f) throw new Error(`Bad window ${from}..${to}`)
  return cached(
    `sfsales:${brand}:${f}:${t}`,
    async () => {
      const started = Date.now()
      const rows = await sfSelect(
        `SELECT TRIM(SPLIT_PART(b.NAME, '-', 1)) AS LOC,
                TRIM(${skuExpr(brand)})          AS SKU,
                o.LINE_TYPE                      AS T,
                SUM(o.QUANTITY)                  AS Q
           FROM AIRBYTE_FOODICS.${schema}.V_ORDER_PRODUCTS_COMBINED o
           LEFT JOIN AIRBYTE_FOODICS.${schema}.BRANCHES b ON b.ID = o.BRANCH_ID
          WHERE o.ORDER_STATUS IN (4, 5)
            AND o.BUSINESS_DATE >= TO_DATE(?) AND o.BUSINESS_DATE < TO_DATE(?)
          GROUP BY 1, 2, 3`,
        [f, windowEnd(t)]
      )
      const out = foldSales(rows, brand)
      const total = out.lines.reduce((s, l) => s + l.q, 0)
      console.log(
        `  [sf-sales] ${brand} ${f}..${t}: ${out.lines.length} plu-outlets, ${Math.round(total)} units` +
          `${out.unmapped.q ? `, ${Math.round(out.unmapped.q)} with no MAPPED_SKU` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`
      )
      return out
    },
    { seconds: ttlFor(t) }
  )
}

/**
 * The same sales a day at a time: [{ day, plu, branch, q }] - for costing each
 * day with the recipe MC posted it with (`insights/datedPm.js`). Same keys,
 * same outlet renames, same brown-rice rule and the same stop at yesterday.
 */
export function snowflakeSalesDaily(code, from, to) {
  const brand = String(code ?? '').trim().toUpperCase()
  const schema = SNOWFLAKE_SALES.get(brand)
  if (!schema) throw new Error(`${brand} does not read its sales from Snowflake`)
  if (!snowflakeReadConfigured()) throw new Error('Snowflake (read) is not configured')
  const f = String(from ?? '').slice(0, 10)
  const t = String(to ?? '').slice(0, 10)
  if (!DAY.test(f) || !DAY.test(t) || t < f) throw new Error(`Bad window ${from}..${to}`)
  return cached(
    `sfsalesday:${brand}:${f}:${t}`,
    async () => {
      const rows = await sfSelect(
        `SELECT TO_CHAR(TO_DATE(o.BUSINESS_DATE), 'YYYY-MM-DD') AS D,
                TRIM(SPLIT_PART(b.NAME, '-', 1)) AS LOC,
                TRIM(${skuExpr(brand)})          AS SKU,
                o.LINE_TYPE                      AS T,
                SUM(o.QUANTITY)                  AS Q
           FROM AIRBYTE_FOODICS.${schema}.V_ORDER_PRODUCTS_COMBINED o
           LEFT JOIN AIRBYTE_FOODICS.${schema}.BRANCHES b ON b.ID = o.BRANCH_ID
          WHERE o.ORDER_STATUS IN (4, 5)
            AND o.BUSINESS_DATE >= TO_DATE(?) AND o.BUSINESS_DATE < TO_DATE(?)
          GROUP BY 1, 2, 3, 4`,
        [f, windowEnd(t)]
      )
      const byDay = new Map()
      for (const r of rows) {
        const list = byDay.get(r.D) ?? []
        list.push(r)
        byDay.set(r.D, list)
      }
      const out = []
      for (const [day, list] of byDay) for (const l of foldSales(list, brand).lines) out.push({ day, ...l })
      return out
    },
    { seconds: ttlFor(t) }
  )
}
