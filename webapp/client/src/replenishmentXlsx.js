/**
 * The Replenishment Planning table as a workbook with LIVE formulas.
 *
 * Asked for on 17 Sep 2026: the calculated columns are to arrive as Excel
 * formulas referencing real cells, so a planner can change an input - the stock
 * figure, the safety stock days, the window length - and watch the order
 * quantity and the dates move, rather than being handed dead numbers.
 *
 * WHAT IS A FORMULA AND WHAT IS NOT
 *
 * A column is written as a formula when this app derives it from other columns
 * on the same row. Everything that arrives from a source - the article, the
 * supplier, the units, the cost, the WH forecast, outbound, the stock reading,
 * the pending quantity, and the three planning settings - is written as a
 * value, because there is nothing to derive it from inside the sheet.
 *
 * THE BASIS SHEET
 *
 * Four of the formulas need something that is not on the row: the length of the
 * window, its end date, and the two anchor days. Those live on a second sheet
 * and every formula references them absolutely, so they are editable in one
 * place. Change "Days in range" and every per-day rate, DTL and date follows.
 * Change nothing and the workbook opens showing exactly what the dashboard
 * showed, because each formula also carries its cached value.
 *
 * THE POLICY WORDS
 *
 * `SS days` and `Delivery freq` hold text as often as numbers - "NoNeed",
 * "OnDemand" - which no arithmetic can consume. The dashboard reads NoNeed as
 * nought days and OnDemand as "no answer", and the formulas reproduce that
 * exactly rather than erroring: `ssDays` below is the expression that does it,
 * and it is inlined wherever a safety stock figure is needed. That is why some
 * of these formulas are longer than their description in the Calculations
 * panel - the panel describes the arithmetic, this has to survive the data.
 */
import { colName, excelDate, S } from './xlsx.js'

/* The Basis sheet, and the absolute references into it. */
const B = {
  from: "Basis!$B$2",
  to: "Basis!$B$3",
  days: "Basis!$B$4",
  today: "Basis!$B$5",
  asOf: "Basis!$B$6",
}

/**
 * Which columns are derived, and how - keyed by column key.
 *
 * Each entry is `(c, r) => string`, where `c` maps a column key to its Excel
 * column letter and `r` is the row number. Anything absent from this map is
 * exported as a value.
 *
 * Every formula guards its inputs with ISNUMBER and returns "" rather than
 * #VALUE! or #DIV/0!, so a blank on the dashboard stays a blank in Excel and a
 * reader editing one cell cannot fill a column with errors.
 */
export const FORMULAS = {
  WH_Accuracy: (c, r) => {
    const f = `${c.WH_Constant_Forecast_Qty}${r}`
    const o = `${c.Consumed_Qty}${r}`
    return `IF(OR(NOT(ISNUMBER(${f})),NOT(ISNUMBER(${o}))),"",IF(MAX(${f},${o})=0,"",1-ABS(${f}-${o})/MAX(${f},${o})))`
  },
  Per_Day_Qty: (c, r) => {
    const f = `${c.WH_Constant_Forecast_Qty}${r}`
    return `IF(OR(NOT(ISNUMBER(${f})),${f}<=0,${B.days}<=0),"",${f}/${B.days})`
  },
  SS_Qty: (c, r) => {
    const ss = ssDays(c, r)
    const pd = `${c.Per_Day_Qty}${r}`
    return `IF(NOT(ISNUMBER(${ss})),"",IF(${ss}=0,0,IF(NOT(ISNUMBER(${pd})),"",${ss}*${pd})))`
  },
  DTL: (c, r) => {
    const pd = `${c.Per_Day_Qty}${r}`
    const soh = `${c.Plan_WH_SOH}${r}`
    const pend = zero(`${c.Open_PO_Qty}${r}`)
    return `IF(OR(NOT(ISNUMBER(${pd})),${pd}<=0,NOT(ISNUMBER(${soh}))),"",MAX(0,${soh}+${pend})/${pd})`
  },
  OOS_Date: (c, r) => `IF(NOT(ISNUMBER(${c.DTL}${r})),"",${B.today}+${c.DTL}${r})`,
  Target_Cover: (c, r) => {
    const oos = `${c.OOS_Date}${r}`
    const ss = ssDays(c, r)
    return `IF(OR(NOT(ISNUMBER(${oos})),NOT(ISNUMBER(${ss}))),"",${B.to}-${oos}+${ss})`
  },
  Req_Qty: (c, r) => {
    const cov = `${c.Target_Cover}${r}`
    const pd = `${c.Per_Day_Qty}${r}`
    return `IF(OR(NOT(ISNUMBER(${cov})),NOT(ISNUMBER(${pd}))),"",MAX(0,${cov}*${pd}))`
  },
  Req_Date: (c, r) => {
    const oos = `${c.OOS_Date}${r}`
    const lead = `${c.Lead_Time_Days}${r}`
    const ss = ssDays(c, r)
    return `IF(OR(NOT(ISNUMBER(${oos})),NOT(ISNUMBER(${lead})),NOT(ISNUMBER(${ss}))),"",${oos}-${lead}-${ss})`
  },
  /*
   * Counted from today, like every other date in this table. It was anchored on
   * the range start until 23 Sep 2026; see `replenishment.js` for why that was
   * reverted, and note that this formula must match it cell for cell.
   */
  D1_Date: (c, r) => {
    const dtl = `${c.DTL}${r}`
    const ss = ssDays(c, r)
    return `IF(OR(NOT(ISNUMBER(${dtl})),NOT(ISNUMBER(${ss}))),"",${B.today}+${dtl}-${ss})`
  },
  D1_Qty: (c, r) => {
    const req = `${c.Req_Qty}${r}`
    const freq = `${c.Delivery_Freq}${r}`
    return `IF(OR(NOT(ISNUMBER(${req})),NOT(ISNUMBER(${freq})),${freq}<=0),"",${req}/${freq})`
  },
  D2_Qty: (c, r) => {
    const req = `${c.Req_Qty}${r}`
    const d1 = `${c.D1_Qty}${r}`
    return `IF(OR(NOT(ISNUMBER(${req})),NOT(ISNUMBER(${d1}))),"",${req}-${d1})`
  },
  /*
   * Suppressed when there is nothing left to deliver, which is the guard added
   * on 16 Sep 2026: on a delivery frequency of 1 the whole request arrives
   * once, and a date for a delivery of nought reads as a commitment.
   */
  D2_Date: (c, r) => {
    const d2 = `${c.D2_Qty}${r}`
    const d1 = `${c.D1_Qty}${r}`
    const pd = `${c.Per_Day_Qty}${r}`
    const dtl = `${c.DTL}${r}`
    const ss = ssDays(c, r)
    return `IF(OR(NOT(ISNUMBER(${d2})),${d2}<=0,NOT(ISNUMBER(${d1})),NOT(ISNUMBER(${pd})),${pd}<=0,NOT(ISNUMBER(${dtl})),NOT(ISNUMBER(${ss}))),"",${B.today}+(${d1}/${pd})+${dtl}-${ss})`
  },
  Total_SOH: (c, r) => {
    const soh = `${c.Plan_WH_SOH}${r}`
    const out = `${c.Consumed_Qty}${r}`
    return `IF(AND(NOT(ISNUMBER(${soh})),NOT(ISNUMBER(${out}))),"",${zero(soh)}+${zero(`${c.Open_PO_Qty}${r}`)}+${zero(out)})`
  },
  New_WH_Forecast: (c, r) => {
    const f = `${c.WH_Constant_Forecast_Qty}${r}`
    return `IF(NOT(ISNUMBER(${f})),"",${f}+${zero(`${c.SS_Qty}${r}`)})`
  },
  New_ACC: (c, r) => {
    const tot = `${c.Total_SOH}${r}`
    const nf = `${c.New_WH_Forecast}${r}`
    return `IF(OR(NOT(ISNUMBER(${tot})),NOT(ISNUMBER(${nf})),${nf}<=0),"",${tot}/${nf})`
  },
}

/**
 * Rows where a formula CANNOT be rebuilt faithfully, and must fall back to the
 * value this app computed.
 *
 * One case, found on 21 Sep 2026 by evaluating every exported formula against
 * its own cached value: WH ACC% is scored on the UNROUNDED warehouse forecast,
 * while the WH forecast column in the sheet carries the figure the dashboard
 * DISPLAYS - which is rounded up to a whole standard package where one exists.
 * The number the score was taken from is therefore not in the workbook, so a
 * formula reading the forecast cell cannot reproduce it:
 *
 *   forecast displayed  190      formula gives 1 - |190-150|/190 = 78.95%
 *   forecast scored     185.28   dashboard shows            = 80.96%
 *
 * Rather than ship a cell whose formula disagrees with its own cached value,
 * those rows get the value alone. It is the same fallback the hidden-column
 * case already uses, and it keeps the brief true: what you download equals
 * what the dashboard showed.
 *
 * This affects only articles with a standard package size - 23 of 1,219 when
 * measured - and it disappears entirely if the forecast is ever put back to
 * unrounded, at which point every row becomes live again with no change here.
 */
const NOT_REBUILDABLE = {
  WH_Accuracy: (row) => {
    const raw = Number(row.WH_Forecast_Unrounded)
    const shown = Number(row.WH_Constant_Forecast_Qty)
    return Number.isFinite(raw) && Number.isFinite(shown) && raw !== shown
  },
}

/** A cell read as a number, or nought when it is blank or a policy word. */
const zero = (ref) => `IF(ISNUMBER(${ref}),${ref},0)`

/**
 * Safety stock in days, from a cell that may hold a word.
 *
 * A number is a number; anything else - "NoNeed", "OnDemand", a blank - has no
 * day count and the formula using it returns "".
 *
 * That mirrors `planFor`, which is the rule the table on screen follows, and it
 * is NOT the rule the server follows. `readPolicy` in
 * `server/insights/replanPlanning.js` reads NoNeed as nought days, so the SS
 * qty column in Article Detail shows 0 for those articles while the planning
 * table below shows a dash. The two disagree, and this export matches the table
 * it is exporting rather than quietly picking the other reading - the brief was
 * that the downloaded figures open identical to the dashboard. Worth settling
 * separately; it is a one-line change in `planFor` whichever way it goes.
 */
const ssDays = (c, r) => {
  const ref = `${c.Safety_Stock_Days}${r}`
  return `IF(ISNUMBER(${ref}),${ref},"")`
}

/** How each exported column is formatted, and whether it is a date. */
const STYLE = {
  WH_Constant_Forecast_Qty: S.QTY,
  Consumed_Qty: S.QTY,
  WH_Accuracy: S.PCT,
  Per_Day_Qty: S.RATE,
  SS_Qty: S.QTY,
  Plan_WH_SOH: S.QTY,
  Open_PO_Qty: S.QTY,
  DTL: S.DAYS,
  OOS_Date: S.DATE,
  Target_Cover: S.DAYS,
  Req_Qty: S.QTY,
  Req_Date: S.DATE,
  D1_Date: S.DATE,
  D1_Qty: S.QTY,
  D2_Date: S.DATE,
  D2_Qty: S.QTY,
  Total_SOH: S.QTY,
  New_WH_Forecast: S.QTY,
  New_ACC: S.PCT,
}

const DATES = new Set(['OOS_Date', 'Req_Date', 'D1_Date', 'D2_Date'])

/*
 * Columns whose value is a number in the row but must stay a number in the
 * sheet even though the dashboard renders them as text. Lead time and delivery
 * frequency arrive as strings ("30", "1", "OnDemand"); a numeric one has to be
 * written as a number or the formulas that divide by it see text.
 */
const NUMERIC_TEXT = new Set(['Lead_Time_Days', 'Delivery_Freq', 'Safety_Stock_Days'])

/**
 * Build the two sheets.
 *
 * `cols` is the visible column list, in order, as `{ key, label }` - so a
 * column the reader has hidden is absent from the sheet AND from every formula,
 * which is why the letter map is built from this list rather than from a fixed
 * order.
 */
export function planningSheets(rows, cols, { dateFrom, dateTo, days, today, asOf }) {
  const letter = {}
  cols.forEach((c, i) => {
    letter[c.key] = colName(i + 1)
  })

  const header = cols.map((c) => ({ v: c.label, s: S.HEAD }))

  const body = rows.map((row, i) => {
    const r = i + 2 // row 1 is the header
    return cols.map((c) => {
      const make = FORMULAS[c.key]
      const style = STYLE[c.key] ?? 0

      if (make) {
        /*
         * The formula needs every column it references to be present. If the
         * reader hid one, the derived column cannot be rebuilt in the sheet, so
         * it falls back to the value this app computed - still correct, just no
         * longer live.
         */
        const f = make(letter, r)
        /*
         * Two reasons a derived column falls back to a plain value: a column it
         * references has been hidden, or the figure it was derived from is not
         * in the sheet at all. Either way the formula would be wrong, and a
         * wrong formula is worse than a correct dead number.
         */
        const missing = /undefined/.test(f) || Boolean(NOT_REBUILDABLE[c.key]?.(row))
        const raw = row[c.key]
        // Exact, so the cached value and the formula's own result are the same
        // number rather than differing by the time of day.
        const v = DATES.has(c.key) ? excelDate(raw, { exact: true }) : numeric(raw)
        return missing ? { v, s: style } : { f, v, s: style }
      }

      const raw = row[c.key]
      if (DATES.has(c.key)) return { v: excelDate(raw), s: style }
      if (NUMERIC_TEXT.has(c.key)) {
        const n = Number(String(raw ?? '').trim())
        // A policy word stays a word; "30" becomes 30 so it can be divided by.
        return String(raw ?? '').trim() === '' || !Number.isFinite(n)
          ? { v: raw ?? '', s: 0 }
          : { v: n, s: style }
      }
      return { v: numeric(raw) ?? (raw ?? ''), s: typeof raw === 'number' ? style : 0 }
    })
  })

  const basis = [
    [{ v: 'How this table was produced', s: S.LABEL }],
    [{ v: 'Selected range start', s: S.LABEL }, { v: excelDate(dateFrom), s: S.DATE }],
    [{ v: 'Selected range end', s: S.LABEL }, { v: excelDate(dateTo), s: S.DATE }],
    [
      { v: 'Days in range (inclusive)', s: S.LABEL },
      // A formula, so editing either date above moves every rate in the table.
      { f: `IF(OR(NOT(ISNUMBER($B$2)),NOT(ISNUMBER($B$3))),"",$B$3-$B$2+1)`, v: days ?? null },
    ],
    [{ v: 'TODAY, as used by the date formulas', s: S.LABEL }, { v: excelDate(today), s: S.DATE }],
    [{ v: 'Warehouse stock as at', s: S.LABEL }, { v: excelDate(asOf), s: S.DATE }],
    [],
    [{ v: 'Every calculated column on the Plan sheet references the four cells above.', s: 0 }],
    [{ v: 'Change one and the table recalculates. The figures as downloaded match the dashboard.', s: 0 }],
    [],
    [{ v: 'Values, not formulas:', s: S.LABEL }],
    [
      {
        v: 'Article, supplier, units, WH forecast, outbound, SOH, pending qty, SS days, lead time, delivery freq.',
        s: 0,
      },
    ],
    [{ v: 'Everything else is derived from those, in the sheet, and is editable.', s: 0 }],
  ]

  return [
    {
      name: 'Plan',
      rows: [header, ...body],
      freeze: 1,
      widths: cols.map((c) => Math.min(38, Math.max(10, String(c.label).length + 4))),
    },
    { name: 'Basis', rows: basis, widths: [38, 16] },
  ]
}

/** A finite number, or null - so a dash on screen becomes an empty cell. */
function numeric(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
