/**
 * Replenishment Planning — one row per article, below Article Detail.
 *
 * Asked for on 16 Sep 2026, specified against a working spreadsheet, and built
 * as a SEPARATE table on purpose. Article Detail answers "what did we need and
 * what moved"; this answers "what should I order and when". They share their
 * inputs and nothing else: every column here is either already on the Article
 * Detail row or derived from those, and neither the warehouse forecast nor
 * Store SOH is touched by anything in this file.
 *
 * WHY ITS OWN GRAIN
 *
 * Article Detail is one row per recipe line, so an article appears many times -
 * once per recipe group, and again for the catch-all row its warehouse figures
 * arrive on. A purchase order is placed once for the article, not once per
 * recipe, so the rows are folded to one per article here.
 *
 * Quantities are summed across those rows, which also sums an article shared by
 * several brands - TISSUE Z FOLD is forecast separately for TBL and MM. That is
 * the right total, because there is one warehouse buying it once. The
 * per-article figures - stock, pending, policy, supplier - are stamped
 * identically on each of those rows by the server, so they are taken once
 * rather than added, or an article in three brands would appear to hold three
 * times the stock.
 *
 * STORE SOH IS NOT HERE
 *
 * Deliberately, and it is worth saying twice. DTL asks how long the WAREHOUSE
 * can keep issuing, and stock already sitting in the shops is not available for
 * the warehouse to issue. Including it would overstate cover by exactly the
 * amount already distributed, which is the opposite of the reading the column
 * is for.
 */
import { useMemo } from 'react'
import { fmtQty, fmtPct, downloadCsv } from '../api.js'
import { Panel, Pill, ChartSkeleton } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { IconDownload } from '../components/Icons.jsx'
import { planFor, windowDays } from '../replenishment.js'
import { downloadXlsx } from '../xlsx.js'
import { planningSheets } from '../replenishmentXlsx.js'
import { whAccuracy } from '../whAccuracy.js'

/**
 * A planning date, with its year.
 *
 * Not `fmtDate` from api.js, which drops the year: these dates routinely land
 * in another year - a 90-day lead time on a November plan asks for an order in
 * June - and "14 Jun" beside "29 Jan" with no year is unreadable. Same shape as
 * the source spreadsheet, so the two can be compared line by line.
 */
const fmtPlanDate = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '–'
  return new Date(Number(ms)).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  })
}

/**
 * Days, as whole days.
 *
 * Shown to one decimal until 16 Sep 2026. The decimal was honest - both figures
 * are quotients and rarely land on a whole number - and it was noise: nobody
 * plans a delivery to a tenth of a day, and "3.4" beside "5.9" in a narrow
 * column is harder to scan than "3" beside "6". The underlying value keeps its
 * full precision, so everything computed from it is unaffected; only the
 * display rounds.
 */
const fmtDays = (v) => {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '–'
  return String(Math.round(Number(v)))
}

const dash = (title) => (
  <span className="muted" title={title}>
    –
  </span>
)

/**
 * 1st, 2nd, 3rd, 4th — for the delivery columns, which are named not numbered.
 *
 * The teens are the exception every naive version gets wrong: 11, 12 and 13
 * take "th" despite ending in 1, 2 and 3. The planning sheet's frequencies stop
 * at ten so it never bites here, but a column header that reads "11st" the day
 * somebody types 11 is not worth the two lines it saves.
 */
const ordinal = (n) => {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/**
 * A date the reader is meant to act on, which may already have passed.
 *
 * A requested date in the past is the most useful thing this table produces -
 * it means the order is already late - so it is marked rather than hidden. The
 * source spreadsheet annotates these by hand; here the row says it itself.
 */
const actionDate = (ms, today, overdueHint) => {
  if (ms === null || ms === undefined) return dash('Needs a stock reading, a lead time and a safety stock policy.')
  const late = today !== null && ms < today
  return (
    <span
      title={late ? overdueHint : `${fmtPlanDate(ms)} — on this basis the order is not yet due.`}
      style={late ? { color: 'var(--red, #c0392b)', fontWeight: 600 } : undefined}
    >
      {fmtPlanDate(ms)}
      {late ? ' ⚠' : ''}
    </span>
  )
}

/**
 * A delivery date, held as a day offset and shown as a date.
 *
 * The source sheet prints the offset - "-3", "50.00" - which is unreadable as a
 * date and negative surprisingly often. The date is shown and the offset said
 * in the tooltip, so the sheet can still be checked against this table.
 */
const deliveryDate = (ms, offset, none, from = 'today') => {
  if (ms === null || ms === undefined) {
    return dash(none ?? 'Needs a DTL and a safety stock policy in days.')
  }
  const n = Number(offset)
  const when =
    n < 0
      ? `${Math.abs(n).toFixed(1)} days ago — this delivery is already overdue`
      : `in ${n.toFixed(1)} days`
  return (
    <span
      title={`${when}. Counted from ${from}, as the planning sheet does.`}
      style={n < 0 ? { color: 'var(--red, #c0392b)', fontWeight: 600 } : undefined}
    >
      {fmtPlanDate(ms)}
    </span>
  )
}

const COLUMNS = (today, asOf, deliveries = 2) => [
  {
    key: 'Item No.',
    label: 'Article No',
    hint: 'The article number the order will be placed against.',
    width: 104,
    group: 'planid',
  },
  {
    key: 'Item',
    label: 'Article',
    hint: 'The article name.',
    /*
     * Measured and draggable, matching the Article column in Article Detail.
     *
     * It was a fixed 240px, which gave it no resize grip - the grip is rendered
     * only for columns the measurer sizes, because a column with a hard-coded
     * width has nothing to fall back to when a drag is reset. Same options as
     * Article Detail uses so the two tables behave identically: sized to fit
     * 95% of names exactly, no ceiling, and the long tail wraps rather than
     * being cut off.
     */
    autoWidth: { min: 140, max: null, percentile: 0.95 },
    wrap: true,
    strong: true,
    group: 'planid',
  },
  {
    key: 'Supplier_Name',
    // "Last Supplier Name" until 16 Sep 2026. The source column is
    // [last Supplier Name] and "last" is true of it, but it read as a sort
    // order rather than as "most recent supplier" - the tooltip says which.
    label: 'Supplier name',
    hint:
      'Who last supplied this article, as recorded on the replenishment planning sheet. Some articles list several suppliers.',
    /*
     * Sized to almost every name, and wrapping for the rest. Fixed 16 Sep 2026.
     *
     * A flat 190px cut every long name off with an ellipsis. Widening to fit
     * them all is not an option here: measured across the 2,224 names, the
     * median is 11 characters and the 95th percentile 40, but the longest is
     * 181 - "United Partners, Alrawdah Paper & Nylon Product Co. W.L.L., Nile
     * National Company, ..." - a list of six suppliers on one article. Sizing
     * the column to that would mean roughly 1,150px of mostly empty space on
     * every other row and would push the rest of the table off the screen.
     *
     * So the width fits the 95th percentile and the column WRAPS. A long name
     * takes two or three lines and is read in full; nothing is ever truncated,
     * and no row pays for the one article with six suppliers. That is the same
     * arrangement the article-name columns elsewhere use, and for the same
     * reason: "never cut off" and "never wider than it needs" cannot both hold
     * without a second line.
     */
    autoWidth: { min: 200, max: 360, percentile: 0.95 },
    wrap: true,
    group: 'planref',
    render: (v) => v || dash('Not recorded on the planning sheet.'),
  },
  {
    /*
     * Sized to the LONGEST value, so nothing is ever cut off.
     *
     * 108px, then a fixed 168px, both truncated - "Packet 100...", "CTN 24
     * Packet 150 P...", "CTN 100 Packet 100 p..." - and the cut fell exactly
     * where the information is. The pack size is the whole point of the column:
     * "CTN" alone does not tell anybody how much arrives.
     *
     * Unlike the supplier name beside it this one can simply be fitted.
     * Measured across the 2,108 values, the longest is 26 characters - "CTN 12
     * X 12 Packet 36.8 GM" - so no percentile and no wrapping is needed: the
     * measurer sizes the column to its widest value and every one of them sits
     * on a single line. Still draggable if a reader wants it narrower.
     */
    key: 'Purchase_Unit',
    label: 'Purchase Unit',
    hint: 'The pack the article is bought in, including the pack size — for example "Ctn 2500 Pcs" is a carton of 2,500 pieces.',
    autoWidth: { min: 120 },
    group: 'planref',
    render: (v) => v || dash('Not recorded on the planning sheet.'),
  },
  /*
   * AVG COST was removed on 17 Sep 2026, the day after it was added.
   *
   * The server still stamps `Avg_Cost` - see `insights/replanPlanning.js`, which
   * reads it from 'Replan Planning'[CURRENT STOCK WAC] on the query it was
   * already making - so the column comes back by restoring a definition here.
   * Nothing else about the article cost changed.
   */
  {
    key: 'Base_Unit',
    label: 'Base Unit',
    hint: 'The unit every quantity in this table is counted in. All the figures to the right are in this unit, not in purchase packs.',
    width: 92,
    group: 'planref',
    render: (v) => v || dash('Not recorded on the planning sheet.'),
  },

  /* What the article needs and what it has. All reused, none recalculated. */
  {
    key: 'WH_Constant_Forecast_Qty',
    label: 'WH Forecast',
    hint:
      'How much the warehouse is expected to issue over the selected dates. Taken straight from the Article Detail table above — nothing in this table changes it.',
    autoWidth: true,
    num: true,
    group: 'planneed',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) => (
      <span title="The warehouse forecast for the selected range, exactly as Article Detail shows it. Nothing in this table changes it.">
        {fmtQty(v)}
      </span>
    ),
  },
  {
    key: 'Consumed_Qty',
    label: 'Outbound',
    hint:
      'How much actually left the warehouse over the selected dates.',
    autoWidth: true,
    num: true,
    group: 'planneed',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) => fmtQty(v),
  },
  {
    key: 'WH_Accuracy',
    label: 'ACC%',
    hint:
      'How close the WH Forecast came to what actually went out. 100% means they matched.',
    width: 88,
    num: true,
    group: 'planneed',
    render: (v) => (v === null || v === undefined ? dash('Nothing shipped to measure against.') : fmtPct(v)),
  },
  {
    key: 'Safety_Stock_Days',
    label: 'SS days',
    hint:
      'How many days of buffer stock this article is meant to hold. "NoNeed" means no buffer is wanted; "OnDemand" means it is ordered only when needed.',
    width: 92,
    group: 'planneed',
    render: (v) => {
      if (v === null || v === undefined || v === '') return dash('Not on the planning sheet.')
      if (/^noneed$/i.test(v)) return <Pill tone="slate" title="Deliberately held without safety stock.">NoNeed</Pill>
      if (/^ondemand$/i.test(v)) return <Pill tone="amber" title="Ordered when needed — no standing cover, so no cover-based planning.">OnDemand</Pill>
      return <span title={`${v} days of cover, from Replan Planning[SS].`}>{v}</span>
    },
  },
  {
    key: 'Per_Day_Qty',
    label: 'Per day qty',
    hint:
      'The average daily requirement: WH Forecast divided by the number of days selected. Every figure to the right is built on this.',
    autoWidth: true,
    num: true,
    group: 'planneed',
    render: (v) =>
      v === null ? (
        dash('No forecast for this range, so there is no daily rate.')
      ) : (
        <span title="WH Forecast ÷ days in the selected range. Every figure to the right is built on this.">
          {Number(v).toFixed(1)}
        </span>
      ),
  },
  {
    key: 'SS_Qty',
    label: 'SS Qty',
    hint:
      'The buffer in units: SS days multiplied by the per-day quantity.',
    autoWidth: true,
    num: true,
    group: 'planneed',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v, row) =>
      v === null ? (
        dash('No day count to work from — the policy is OnDemand, or there is no forecast.')
      ) : (
        <span title={`${row.Safety_Stock_Days} days × ${Number(row.Per_Day_Qty ?? 0).toFixed(1)} per day.`}>
          {fmtQty(v)}
        </span>
      ),
  },

  /* Where the warehouse stands, and how long that lasts. */
  {
    key: 'Plan_WH_SOH',
    label: 'SOH',
    hint:
      'How much the WAREHOUSE is holding right now, as at the date in this panel\'s heading. Not the shops\' stock — shop stock cannot be issued by the warehouse.',
    autoWidth: true,
    num: true,
    group: 'planstock',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null ? (
        dash('The inventory feed has never seen this article at the warehouse.')
      ) : (
        <span
          title={`Warehouse stock on hand${asOf ? ` as at ${fmtPlanDate(Date.parse(`${asOf}T00:00:00Z`))}` : ''}. The warehouse's own balance, not the shops' — Store SOH is not used anywhere in this table.`}
        >
          {fmtQty(v)}
        </span>
      ),
  },
  {
    key: 'Open_PO_Qty',
    label: 'Pending Qty',
    hint:
      'Units already ordered from suppliers but not yet received, as at the end of the selected date range.',
    autoWidth: true,
    num: true,
    group: 'planstock',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        dash('No open purchase orders found for this article.')
      ) : (
        <span title="Ordered and not yet received, net of part deliveries. POs raised on or before the end of the selected range.">{fmtQty(v)}</span>
      ),
  },
  {
    key: 'DTL',
    label: 'DTL',
    hint:
      'Days to last — roughly how many days the warehouse stock will last from today, counting what is already on order. Worked out as (SOH + Pending) ÷ per-day quantity.',
    width: 84,
    num: true,
    group: 'planstock',
    render: (v) =>
      v === null ? (
        dash('Needs both a stock reading and a daily rate.')
      ) : (
        <span
          title="Days to last: (Warehouse SOH + Pending Qty) ÷ Per day qty. Warehouse stock only — the shops' stock cannot be issued by the warehouse."
          style={v < 7 ? { color: 'var(--red, #c0392b)', fontWeight: 600 } : undefined}
        >
          {fmtDays(v)}
        </span>
      ),
  },
  /*
   * FORECASTED OOS DATE - removed on 16 Sep 2026 and put back the same day.
   *
   * Taken out because it is the DTL column beside it expressed as a date: the
   * same fact twice. Asked for again so the table can be read against the
   * source spreadsheet line by line, which is the better reason - the value was
   * never removed, only the column, so this is a display change and nothing is
   * recalculated. It remains the date Req Date and both delivery deadlines are
   * measured back from, which is the other argument for showing it: with it on
   * screen, every date to its right can be checked by subtraction.
   */
  {
    key: 'OOS_Date',
    label: 'Forecasted OOS Date',
    hint: 'The day warehouse stock is expected to run out: today plus DTL. Everything to the right is counted back from here.',
    width: 150,
    group: 'planstock',
    render: (v) =>
      v === null || v === undefined
        ? dash('Needs a stock reading and a daily rate — the same two figures DTL needs.')
        : actionDate(v, today, 'Stock has already run out on this basis.'),
  },

  /* What to order, how much, and when. */
  {
    key: 'Target_Cover',
    label: 'Target Cover',
    hint:
      'How many extra days of stock are needed to reach the end of the selected period and still hold the safety buffer. A negative number means stock already lasts beyond the period, so nothing needs ordering.',
    width: 116,
    num: true,
    group: 'planorder',
    render: (v) =>
      v === null ? (
        dash('Needs a DTL and a safety stock policy in days.')
      ) : (
        <span
          title="Last selected date − (today + DTL) + SS days. Negative means stock already outlasts the selected range, so nothing needs ordering."
          style={v < 0 ? { color: 'var(--muted, #888)' } : undefined}
        >
          {fmtDays(v)}
        </span>
      ),
  },
  {
    key: 'Req_Qty',
    label: 'Req Qty',
    hint:
      'How much to order: Target Cover multiplied by the per-day quantity. Never below zero.',
    autoWidth: true,
    num: true,
    group: 'planorder',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null ? (
        dash('Needs a target cover and a daily rate.')
      ) : (
        <span
          title="Target Cover × Per day qty, floored at zero — a negative cover is not a negative order."
          style={v > 0 ? { fontWeight: 600 } : undefined}
        >
          {fmtQty(v)}
        </span>
      ),
  },
  {
    key: 'Req_Date',
    label: 'Req Date',
    hint:
      'The latest date the order should be placed. Counted back from the day stock runs out, allowing for the lead time and the safety buffer. A date in the past means the order is already overdue.',
    width: 116,
    group: 'planorder',
    render: (v) =>
      actionDate(
        v,
        today,
        'This order date has already passed — on this lead time the request is overdue.'
      ),
  },
  {
    key: 'Lead_Time_Days',
    label: 'Lead Time',
    hint:
      'How many days it takes from placing an order to receiving it.',
    width: 96,
    num: true,
    group: 'planorder',
    render: (v) =>
      v === null || v === undefined || v === ''
        ? dash('Not on the planning sheet.')
        : <span title={`${v} days from order to receipt.`}>{v}</span>,
  },
  {
    key: 'Delivery_Freq',
    label: 'Delivery Freq',
    hint:
      'How many scheduled deliveries this article gets. The source does not state over what period, so no unit is shown.',
    width: 116,
    group: 'planorder',
    render: (v) => {
      if (v === null || v === undefined || v === '') return dash('Not on the planning sheet.')
      if (/^noneed$/i.test(v)) return <Pill tone="slate" title="No scheduled deliveries.">NoNeed</Pill>
      if (/^ondemand$/i.test(v)) return <Pill tone="amber" title="Delivered on request, not on a schedule.">OnDemand</Pill>
      return <span title="Scheduled deliveries, as written on the planning sheet. The sheet does not state the period, so none is shown.">{v}</span>
    },
  },

  /*
   * One pair of columns per delivery, generated from the frequency.
   *
   * "D1 Date" and "D2 Date" were renamed on 16 Sep 2026 - the old names were
   * the spreadsheet's column letters, which say nothing to anybody who has not
   * seen the spreadsheet. What the figures actually are:
   *
   *   1st = DTL - SS days, the day stock falls TO the safety buffer rather
   *         than to nothing. The last day the first delivery can arrive
   *         without eating into the buffer, so it is a deadline, not a plan.
   *   nth = the same deadline pushed out by however long the deliveries
   *         before it last (qty / per-day each).
   *
   * They are deadlines, which is why the names say "by" rather than "on".
   *
   * Generated rather than written out from 23 Sep 2026. Two fixed pairs could
   * only ever describe a frequency of two, and the planning sheet runs to ten:
   * 131 articles ask for three or more and were silently cut off. `count` is
   * the largest frequency in the rows actually on screen, so a table with
   * nothing above two still shows exactly the two pairs it always did.
   */
  ...Array.from({ length: Math.max(2, deliveries) }, (_, i) => {
    const n = i + 1
    const ord = ordinal(n)
    return [
      {
        key: `D${n}_Date`,
        label: `${ord} delivery by`,
        hint:
          n === 1
            ? 'The last day the first delivery can arrive without dipping into the safety stock: TODAY plus (DTL - SS days). Counted from today, like every other date here, so its gap from Forecasted OOS Date is exactly the safety stock. A date in the past means it is already late.'
            : `The last day the ${ord} delivery can arrive. It is the first deadline pushed out by however long the ${n - 1} ${n === 2 ? 'delivery' : 'deliveries'} before it last at the daily rate.`,
        width: 130,
        group: 'plansplit',
        render: (v, row) =>
          deliveryDate(
            v,
            row[`D${n}_Offset`],
            n === 1
              ? undefined
              : `This article's delivery frequency does not reach a ${ord} delivery.`,
            'today'
          ),
      },
      {
        key: `D${n}_Qty`,
        label: `${ord} delivery qty`,
        hint: `How much should come in the ${ord} delivery. The requirement is split equally, so every delivery is Req Qty ÷ Delivery Freq.`,
        autoWidth: true,
        num: true,
        group: 'plansplit',
        total: 'sum',
        renderTotal: fmtQty,
        render: (v) =>
          v === null || v === undefined
            ? dash(
                n <= 2
                  ? 'Needs a requested quantity and a numeric delivery frequency.'
                  : `This article's delivery frequency does not reach a ${ord} delivery.`
              )
            : <span title="Req Qty ÷ Delivery Freq.">{fmtQty(v)}</span>,
      },
    ]
  }).flat(),

]

/*
 * The group headings, and the help behind each heading's information icon.
 *
 * `help` is a LIST of { term, text, formula?, example? } - one entry per column
 * in the group. It was written as a single string when this table was built and
 * that crashed the page: a string is truthy, so the icon rendered, and opening
 * it called `.map` on the string. Nobody clicked it until 16 Sep 2026, when it
 * surfaced on the deployed site as "b(...).help.map is not a function".
 *
 * Same shape as `HELP` in `pages/ComponentLevel.jsx`, which is where the
 * contract is set and where these read well next to.
 */
/**
 * What each column is, per column key, for the CSV to carry with it.
 *
 * Asked for on 17 Sep 2026: almost every figure in this table is derived, and a
 * downloaded "Target Cover 58" is unreadable without the arithmetic. On screen
 * the header tooltips and the group help answer that; in a spreadsheet opened a
 * week later there is nothing to hover, so the formulas travel with the file.
 *
 * Keyed on the column key rather than written into each column definition, so
 * the export and the columns stay in step: `csvNotes` below walks the columns
 * being exported and looks each one up, and the test asserts the two sets match
 * exactly - a column added without a formula, or a formula left behind after a
 * column is removed, both fail rather than going unnoticed.
 *
 * Kept deliberately terse. The prose lives in GROUPS below and in
 * `server/calculations.js`; this is the arithmetic only.
 */
const FORMULAS = {
  'Item No.': "The ERP article number. Source: 'RECIPE TABLE'[Item No.]",
  Item: 'The article name',
  Supplier_Name: "Source: 'Replan Planning'[last Supplier Name]",
  Purchase_Unit: "Source: 'Replan Planning'[PURCH UNIT]",
  Base_Unit: "Source: 'Replan Planning'[BASE UNIT]. Every quantity below is in this unit",
  WH_Constant_Forecast_Qty:
    'Reused from Article Detail: six-month outbound-per-sales rate x forecast sales for the range. Unchanged by this table',
  Consumed_Qty: 'Reused from Article Detail: what actually left the Central Warehouse in the range',
  WH_Accuracy: '1 - ABS(WH Forecast - Outbound) / MAX(WH Forecast, Outbound)',
  Safety_Stock_Days:
    "Source: 'Replan Planning'[SS]. A number of DAYS, or the words NoNeed (no buffer wanted) / OnDemand (no standing cover)",
  Per_Day_Qty: 'WH Forecast / days in the selected range, counted inclusively',
  SS_Qty: 'SS days x Per day qty. NoNeed gives 0; OnDemand is blank',
  Plan_WH_SOH:
    "Warehouse closing stock on the inventory feed's last day, warehouse locations only. A CURRENT balance, not the range's closing balance. Never the shops' Store SOH",
  Open_PO_Qty:
    "Source: [CC Open PO Qty] in the Inventory Control model, grouped on 'CC Item Location'[Article No.], warehouse locations only, POs raised on or before the end of the selected range",
  DTL: 'MAX(0, SOH + Pending Qty) / Per day qty. Warehouse stock only',
  OOS_Date: 'TODAY + DTL',
  Target_Cover:
    'last selected date - Forecasted OOS Date + SS days. Negative means stock already outlasts the range',
  Req_Qty: 'MAX(0, Target Cover x Per day qty)',
  Req_Date:
    'Forecasted OOS Date - Lead Time - SS days. A date in the past means the order is already overdue',
  Lead_Time_Days: "Source: 'Replan Planning'[LEAD TIME], in days",
  Delivery_Freq:
    "Source: 'Replan Planning'[DeliveryFreq], a count of deliveries. The source does not state the period",
  D1_Date:
    'TODAY + (DTL - SS days). Counted from today, like every other date in this table',
  D1_Qty: 'Req Qty / Delivery Freq',
  D2_Date:
    'TODAY + ((1st delivery qty / Per day qty) + DTL - SS days). Blank when there is no second delivery',
  D2_Qty: 'Req Qty / Delivery Freq',
}

/**
 * The block appended under the exported table.
 *
 * The window and the two anchor dates come first, because half the formulas
 * below refer to them: "days in the selected range" and "TODAY" are not
 * self-evident in a file opened later, and the stock as-of date is a different
 * day again from both.
 */
export function csvNotes(cols, { dateFrom, dateTo, days, asOf, today }) {
  const out = [
    [],
    ['How this table was produced'],
    ['Selected range', dateFrom && dateTo ? `${dateFrom} to ${dateTo}` : 'none selected'],
    ['Days in range (inclusive)', days ?? ''],
    ['TODAY, as used by the date formulas', today ?? ''],
    ['Warehouse stock as at', asOf ?? 'not available'],
    [],
    ['Column', 'Formula or source'],
  ]
  for (const c of cols) {
    // Delivery columns past the second are generated, so their formula is too:
    // every delivery is the same share, spaced by however long one lasts.
    const nth = /^D(\d+)_(Date|Qty)$/.exec(c.key)
    const generated =
      nth && Number(nth[1]) > 2
        ? nth[2] === 'Qty'
          ? 'Req Qty / Delivery Freq'
          : `TODAY + (${Number(nth[1]) - 1} x (delivery qty / Per day qty) + DTL - SS days)`
        : ''
    out.push([c.label, FORMULAS[c.key] ?? generated])
  }
  return out
}

const GROUPS = {
  /*
   * Two sections where there was one, split on 24 Sep 2026.
   *
   * They were a single "Article" group of five columns, which made the two
   * things it held inseparable: the identity of the row, and reference detail
   * about how the article is bought. Collapsing meant losing the article
   * number, and freezing the identity columns left the group's title spanning
   * three columns that had scrolled away.
   *
   * So identity stands alone and is what the table freezes by default, and the
   * supplier and the units become a section of their own that can be put away
   * when the question is about quantities.
   */
  planid: {
    label: 'Article',
    // No collapse control: these two are what identify a row, and a table of
    // quantities with no article against them is not a shorter table, it is an
    // unreadable one. Either column can still be hidden from Build view.
    collapsible: false,
    help: [
      {
        term: 'Article No, Article',
        text: 'What the order will be placed against, and its name. These two identify the row, so they are what the table freezes by default — use the Freeze control to change that.',
      },
    ],
  },
  planref: {
    label: 'Supplier & units',
    help: [
      {
        term: 'Supplier name',
        text: 'Who last supplied this article. Some articles list several suppliers, and the cell wraps rather than cutting them off.',
        formula: "'Replan Planning'[last Supplier Name]",
      },
      {
        term: 'Purchase Unit',
        text: 'The pack it is bought in, including the pack size.',
        formula: "'Replan Planning'[PURCH UNIT]",
        example: '"Ctn 2500 Pcs" is a carton of 2,500 pieces.',
      },
      {
        term: 'Base Unit',
        text: 'The unit every quantity in this table is counted in. Nothing here is in purchase packs.',
        formula: "'Replan Planning'[BASE UNIT]",
      },
    ],
  },
  planneed: {
    label: 'Requirement',
    help: [
      {
        term: 'WH Forecast, Outbound, ACC%',
        text: 'Taken straight from the Article Detail table above. Nothing in this table changes them.',
      },
      {
        term: 'SS days',
        text: 'How many days of buffer stock the article should hold.',
        formula: "'Replan Planning'[SS]",
        example:
          '"NoNeed" means no buffer is wanted. "OnDemand" means it is ordered only when needed, so there is no standing buffer and the columns that need one are blank.',
      },
      {
        term: 'Per day qty',
        text: 'The average daily requirement. Every figure to its right is built on this.',
        formula: 'WH Forecast / days in the selected range (counted inclusively)',
        example: '17,537 over 15 Sep to 5 Nov is 52 days, so 337.25 a day.',
      },
      {
        term: 'SS Qty',
        text: 'The buffer in units. Worked out from the FORECAST rather than from Outbound, so a bad month at the warehouse cannot shrink the buffer meant to protect against it.',
        formula: 'SS days x Per day qty',
      },
    ],
  },
  planstock: {
    label: 'Warehouse position',
    help: [
      {
        term: 'SOH',
        text: "What the WAREHOUSE holds right now, as at the date in this panel's heading. Never the shops' stock - Store SOH cannot be issued by the warehouse and is not used anywhere in this table.",
        formula: 'cc_daily_inventory[Closing Stock Qty] on the feed’s last day, warehouse locations only',
        example: 'A dash means the feed has never seen the article there, which is not the same as none in stock.',
      },
      {
        term: 'Pending Qty',
        text: 'Units already ordered from suppliers and not yet received, net of part deliveries. As at the end of the selected range: POs raised on or before it count.',
      },
      {
        term: 'DTL',
        text: 'Days to last - roughly how long the warehouse can keep issuing, counting what is already on order.',
        formula: 'MAX(0, SOH + Pending Qty) / Per day qty',
        example:
          'Shown as a whole number; the underlying value keeps its decimals, so figures derived from it do not shift. It moves with the range length, because that sets the daily rate.',
      },
      {
        term: 'Forecasted OOS Date',
        text: 'The day stock is expected to run out. Everything in the Order group is counted back from here.',
        formula: 'TODAY + DTL',
      },
    ],
  },
  planorder: {
    label: 'Order',
    help: [
      {
        term: 'Target Cover',
        text: 'The days of cover still to be bought: the gap between running out and the end of the plan, plus the buffer that has to survive it.',
        formula: 'last selected date - Forecasted OOS Date + SS days',
        example:
          'Legitimately NEGATIVE when stock already outlasts the range - that is the signal nothing needs ordering. Only the quantity is floored at zero.',
      },
      {
        term: 'Req Qty',
        text: 'How much to order.',
        formula: 'MAX(0, Target Cover x Per day qty)',
      },
      {
        term: 'Req Date',
        text: 'The latest day the order can be placed, counted back from the stock-out date through the lead time and the buffer.',
        formula: 'Forecasted OOS Date - Lead Time - SS days',
        example:
          'Frequently in the past, and that is the finding rather than an error: 7 days of stock against a 30-day lead time means the order is already late. Those are marked red.',
      },
      {
        term: 'Lead Time, Delivery Freq',
        text: 'Days from order to receipt, and how many scheduled deliveries the article gets. Both as written on the planning sheet; the sheet does not say over what period the frequency runs, so no unit is shown.',
      },
    ],
  },
  plansplit: {
    label: 'Deliveries',
    help: [
      {
        term: '1st delivery by',
        text: 'A DEADLINE, not a plan - the last day the first delivery can land without eating into the safety buffer.',
        formula: 'TODAY + (DTL - SS days)',
        example:
          'Counted from today, like every other date here, so its gap from Forecasted OOS Date is exactly the safety stock. The slicer chooses which window to plan, not what day it is.',
      },
      {
        term: '1st delivery qty',
        text: 'How much of the request comes in that delivery.',
        formula: 'Req Qty / Delivery Freq',
      },
      {
        term: '2nd delivery by',
        text: 'The first deadline pushed out by however long the first delivery lasts. Blank when there is no second delivery.',
        formula: 'TODAY + ((1st delivery qty / Per day qty) + DTL - SS days)',
        example:
          'On a Delivery Freq of 1 the whole request arrives once, so the remainder is nought and no second date is shown.',
      },
      {
        term: '2nd delivery qty',
        text: 'Whatever is left after the first delivery.',
        formula: 'Req Qty - 1st delivery qty',
      },
    ],
  },
}

/**
 * One planning row per article.
 *
 * `rows` are the Article Detail rows for the same window and filters, so the
 * two tables can never disagree about a forecast: there is one figure and this
 * reads it.
 */
export default function ReplenishmentPlanning({ rows, filters, busy }) {
  const today = useMemo(() => Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`), [])

  const planned = useMemo(() => {
    if (!rows?.length) return []

    const held = new Map()
    for (const r of rows) {
      const article = String(r['Item No.'] ?? '').trim()
      // No article number, nothing to order. Prep steps are not purchased.
      if (!article) continue

      const seen = held.get(article)
      if (!seen) {
        held.set(article, {
          'Item No.': article,
          Item: r.Item ?? null,
          Supplier_Name: r.Supplier_Name ?? null,
          Purchase_Unit: r.Purchase_Unit ?? null,
          Base_Unit: r.Base_Unit ?? null,
          Safety_Stock_Days: r.Safety_Stock_Days ?? null,
          Lead_Time_Days: r.Lead_Time_Days ?? null,
          Delivery_Freq: r.Delivery_Freq ?? null,
          // Per-article, stamped the same on every row of the article: taken
          // once, never added. See the note at the top of this file.
          WH_SOH_Now: r.WH_SOH_Now ?? null,
          WH_SOH_As_Of: r.WH_SOH_As_Of ?? null,
          Open_PO_Qty: r.Open_PO_Qty ?? null,
          // Summed across the article's rows, brands included.
          WH_Constant_Forecast_Qty: r.WH_Constant_Forecast_Qty ?? null,
          Consumed_Qty: r.Consumed_Qty ?? null,
        })
        continue
      }
      const add = (a, b) => {
        if ((a === null || a === undefined) && (b === null || b === undefined)) return null
        return (Number(a) || 0) + (Number(b) || 0)
      }
      seen.WH_Constant_Forecast_Qty = add(seen.WH_Constant_Forecast_Qty, r.WH_Constant_Forecast_Qty)
      seen.Consumed_Qty = add(seen.Consumed_Qty, r.Consumed_Qty)
      // First non-null wins for everything per-article: only one row of the
      // article carries them, and which one is not knowable from here.
      for (const k of [
        'Item',
        'Supplier_Name',
        'Purchase_Unit',
        'Base_Unit',
        'Safety_Stock_Days',
        'Lead_Time_Days',
        'Delivery_Freq',
        'WH_SOH_Now',
        'WH_SOH_As_Of',
        'Open_PO_Qty',
      ]) {
        if ((seen[k] === null || seen[k] === undefined) && r[k] !== null && r[k] !== undefined)
          seen[k] = r[k]
      }
    }

    const todayIso = new Date(today).toISOString().slice(0, 10)
    return [...held.values()].map((r) => {
      const plan = planFor(r, {
        dateFrom: filters?.dateFrom,
        dateTo: filters?.dateTo,
        today: todayIso,
      })
      /*
       * Accuracy is re-derived here rather than carried over, because the
       * forecast and outbound above were summed across the article's rows and a
       * ratio taken from one of them would not describe the row on screen.
       */
      const c = r.Consumed_Qty
      const f = plan.New_WH_Forecast === null ? null : r.WH_Constant_Forecast_Qty
      const bigger = c === null || f === null ? null : Math.max(Number(c), Number(f))
      return {
        ...r,
        ...plan,
        // Stock rule on top, same as the other tables — see `whAccuracy.js`.
        WH_Accuracy: whAccuracy(
          bigger === null || bigger <= 0 ? null : 1 - Math.abs(Number(f) - Number(c)) / bigger,
          f,
          r.Store_SOH
        ),
      }
    })
  }, [rows, filters?.dateFrom, filters?.dateTo, today])

  const days = windowDays(filters?.dateFrom, filters?.dateTo)
  const asOf = planned.find((r) => r.WH_SOH_As_Of)?.WH_SOH_As_Of ?? null
  /*
   * How many delivery columns this table needs, from the rows it is showing.
   *
   * Driven by the data rather than fixed at the sheet's maximum of ten, so a
   * filtered table asks for exactly the pairs its articles use - selecting one
   * article on a frequency of three gives three, not ten with seven blank.
   */
  const deliveries = useMemo(
    () => planned.reduce((n, r) => Math.max(n, Number(r.Delivery_Count) || 0), 0),
    [planned]
  )
  const columns = useMemo(() => COLUMNS(today, asOf, deliveries), [today, asOf, deliveries])

  return (
    <Panel
      /*
       * Every formula behind this table, declared for the Calculations panel.
       *
       * Listed in the order the columns read left to right, so the drawer walks
       * the table rather than an alphabet. The first three are the existing
       * warehouse entries - this table reads them and defines nothing about
       * them, so it points at the same catalogue entries Article Detail does
       * rather than describing them a second time and letting the two drift.
       */
      calc={[
        'plan-grain',
        'plan-sheet',
        'wh-forecast',
        'outbound',
        'wh-acc',
        'plan-perday',
        'plan-ssqty',
        'plan-soh',
        'plan-pending',
        'plan-dtl',
        'plan-cover',
        'plan-reqqty',
        'plan-reqdate',
        'plan-d1',
        'plan-d2',
      ].join(',')}
      title="Replenishment Planning"
      count={busy ? undefined : `${planned.length.toLocaleString()} articles`}
      sub={
        days
          ? `What to order and when, over the ${days} day${days === 1 ? '' : 's'} selected` +
            (asOf ? ` · warehouse stock as at ${fmtPlanDate(Date.parse(`${asOf}T00:00:00Z`))}` : '')
          : 'Select a date range to plan over'
      }
      flush
      fill
      tools={
        <>
        {/*
          * Two downloads, because they answer different questions.
          *
          * Excel carries the calculated columns as LIVE FORMULAS against real
          * cells, with the window constants on a second sheet - so a planner
          * can change the stock figure or the safety stock days and watch the
          * order quantity and the dates move. CSV stays a flat snapshot with
          * the formulas written out underneath as text, which is what you want
          * if you are feeding it to something else rather than reading it.
          */}
        <button
          type="button"
          className="btn"
          disabled={!planned.length}
          title="The table with every calculated column as a working Excel formula"
          onClick={() =>
            downloadXlsx(
              'replenishment-planning',
              planningSheets(planned, columns.map(({ key, label }) => ({ key, label })), {
                dateFrom: filters?.dateFrom,
                dateTo: filters?.dateTo,
                days,
                asOf,
                today: new Date(today).toISOString().slice(0, 10),
              })
            )
          }
        >
          <IconDownload size={12} />
          Excel
        </button>
        <button
          type="button"
          className="btn"
          disabled={!planned.length}
          title="A flat snapshot, with the formulas listed as text underneath"
          onClick={() =>
            downloadCsv(
              'replenishment-planning',
              planned,
              // The schedule is an array on the row; the sheet takes its
              // one-line form instead, which reads the same.
              columns.map(({ key, label }) => ({ key, label })),
              /*
               * The formulas ride along under the table.
               *
               * Built from the columns actually being exported, so a hidden
               * column does not leave an orphan formula and an added one cannot
               * arrive without its arithmetic.
               */
              csvNotes(columns, {
                dateFrom: filters?.dateFrom,
                dateTo: filters?.dateTo,
                days,
                asOf,
                today: new Date(today).toISOString().slice(0, 10),
              })
            )
          }
        >
          <IconDownload size={12} />
          CSV
        </button>
        </>
      }
    >
      {busy && !planned.length ? (
        <div style={{ padding: 16 }}>
          <ChartSkeleton height={320} />
        </div>
      ) : (
        /*
         * A refresh says so, rather than leaving the old figures looking current.
         *
         * The skeleton above only covers the FIRST load. Changing the date range
         * or the brand re-fetches while rows are already on screen, and those
         * rows are the previous window's - so for as long as the request runs the
         * table is showing numbers that no longer match the controls. Dimming it
         * and naming the state is the difference between "stale" and "wrong".
         *
         * The rows stay readable and interactive on purpose: replacing a full
         * table with a spinner loses the reader's scroll position and whatever
         * they were part-way through comparing.
         */
        <div className={`replen__tbl${busy ? ' replen__tbl--busy' : ''}`}>
          {busy ? (
            <p className="replen__busy" role="status">
              <span className="replen__spin" aria-hidden="true" />
              Updating for the new selection…
            </p>
          ) : null}
        <DataTable
          columns={columns}
          rows={planned}
          totals
          initialSort={{ key: 'Req_Qty', dir: 'desc' }}
          searchPlaceholder="Search article or supplier…"
          tableId="replenishment-planning-v1"
          groups={GROUPS}
          /*
           * Article No and Article stay put; everything else scrolls.
           *
           * At 43 columns the article a row describes had left the screen long
           * before its delivery dates arrived, so every comparison meant
           * scrolling back to find out whose row it was. Two rather than the
           * whole first section, asked for on 24 Sep 2026: the number and the
           * name are what identify a row, and supplier and units are reference
           * detail that costs width somebody would rather spend on the figures.
           *
           * Only the starting point - the Freeze control in the toolbar changes
           * it, and the choice is remembered per reader.
           */
          freeze={2}
          /*
           * Any section can be put away. Eight groups over 43 columns is more
           * than fits, and which ones matter depends entirely on the question
           * being asked - ordering quantities, delivery timing, or stock cover.
           */
          collapsibleGroups
          /*
           * Bounded for the same reason Article Detail is, from 16 Sep 2026.
           *
           * This table is not the bottom of the page - the accuracy band charts
           * sit under it - so a table that grows to its full page of rows puts
           * them a couple of thousand pixels down. Shorter than Article Detail
           * because this is the table you scan for the handful of articles that
           * need ordering, having sorted by Req Qty, rather than one you read
           * down.
           */
          maxHeight={520}
        />
        </div>
      )}
    </Panel>
  )
}
