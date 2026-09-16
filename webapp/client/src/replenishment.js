/**
 * Replenishment planning arithmetic.
 *
 * Asked for on 16 Sep 2026, and specified against a working spreadsheet. Every
 * formula below was checked against that sheet's own printed figures before a
 * line of the table was written: an article on a 15-day policy with a 17,513
 * forecast over 51 days, 4,000 on hand and a 90-day lead time reproduced all
 * twelve of its columns exactly - per-day 343.4, DTL 12, target cover 53,
 * requested 18,320, requested date 14 Jun 26, out-of-stock 27 Sep 26, D2 offset
 * 50.00. That check is the reason these are written as the sheet writes them
 * rather than as a tidier model of the same idea.
 *
 * WHAT IS DELIBERATELY NOT REUSED
 *
 * None of this feeds the warehouse forecast. `WH Forecast` arrives already
 * calculated and is only ever divided by the length of the window; nothing here
 * can change it, and nothing here is subtracted from it. The same goes for
 * Store SOH, which does not appear in this file at all - DTL is a question
 * about the WAREHOUSE running out, and the shops' stock is not available to the
 * warehouse to ship. Mixing the two would overstate cover by whatever is
 * already sitting in the shops.
 *
 * THE STOCK READING
 *
 * `WH_SOH_Now` is the warehouse balance as the inventory feed last knew it, not
 * the selected window's closing balance. DTL asks when stock runs out from
 * where it stands today, so a window that has not finished has no closing
 * balance to use, and a window in the past has one that has since been
 * overtaken. The as-of day is shown in the panel heading rather than implied.
 */

const DAY = 86_400_000

/** Inclusive calendar days in the selected range - 15 Sep to 5 Nov is 52. */
export function windowDays(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) return null
  const from = Date.parse(`${dateFrom}T00:00:00Z`)
  const to = Date.parse(`${dateTo}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null
  return Math.round((to - from) / DAY) + 1
}

/** A finite number, or null. Guards every divisor and every date offset. */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Every planning figure for one article.
 *
 * Returns nulls rather than NaN, Infinity or a 1970 date wherever an input is
 * missing. That is not defensive dressing: a third of the sheet's own articles
 * are on `OnDemand` or `NoNeed` and have no day count at all, plenty have no
 * delivery frequency, and an article can legibly hold no stock. Each of those
 * is a real state with a real answer, and the answer is a dash.
 */
export function planFor(row, { dateFrom, dateTo, today }) {
  const days = windowDays(dateFrom, dateTo)
  const endMs = dateTo ? Date.parse(`${dateTo}T00:00:00Z`) : null

  /*
   * The day every date is counted from: TODAY, the system date.
   *
   * Moved to the first slicer date on 16 Sep 2026 and moved back the same day.
   * The reason for moving it was that the source spreadsheet's TODAY() was
   * reported to be the slicer start; checked cell by cell, it is not. Three of
   * that sheet's four date cells - Forecasted OOS Date, Target Cover and Req
   * Date - reference TODAY() and the system date. Only its first-delivery cell
   * counts from the slicer start, and that one cell is why its OOS and its
   * first delivery sit 16 days apart on a 15-day safety stock.
   *
   * It is also the only anchor the arithmetic supports. DTL divides a CURRENT
   * stock balance - `WH_SOH_Now`, read on the feed's last day - and a duration
   * can only be counted from the moment the quantity was measured. Anchoring it
   * to a chosen date adds today's stock to a different day's clock: a past
   * window then reports stock running out before it was counted, and a future
   * window assumes today's stock survives untouched until the window opens.
   *
   * What this gives up, stated because it is the one real argument the other
   * way: these dates move forward every morning, so the same date range does
   * not give the same answer tomorrow. The alternative that keeps both - stable
   * dates AND a clock that matches the stock - is the inventory feed's own
   * as-of date, which is already shown in the panel heading.
   */
  const anchor = today
  // Null rather than NaN on an unparseable date: NaN would propagate into every
  // date below and reach the screen as "Invalid Date".
  const anchored = anchor ? Date.parse(`${anchor}T00:00:00Z`) : NaN
  const nowMs = Number.isFinite(anchored) ? anchored : null

  const forecast = num(row.WH_Constant_Forecast_Qty)
  const soh = num(row.WH_SOH_Now)
  const pending = Math.max(0, num(row.Open_PO_Qty) ?? 0)
  const outbound = num(row.Consumed_Qty)
  const ssDays = num(row.Safety_Stock_Days)
  const lead = num(row.Lead_Time_Days)
  const freq = num(row.Delivery_Freq)

  /*
   * Per-day requirement. Zero or negative forecast gives null, not zero: it is
   * the divisor for everything below, and a zero divisor is what produces the
   * Infinity that would otherwise reach the screen.
   */
  const perDay = days && forecast !== null && forecast > 0 ? forecast / days : null

  // A policy of 0 days is 0 units, whatever the rate - answered without one.
  const ssQty = ssDays === null ? null : ssDays === 0 ? 0 : perDay === null ? null : ssDays * perDay

  /*
   * Days to last, on WAREHOUSE stock plus what is already bought.
   *
   * Negative stock is a data fault, not negative cover, so it is floored at
   * zero - the warehouse cannot last a negative number of days.
   */
  const dtl = perDay === null || soh === null ? null : Math.max(0, soh + pending) / perDay

  const oosMs = dtl === null || nowMs === null ? null : nowMs + dtl * DAY

  /*
   * Target cover: the gap between running out and the end of the plan, plus the
   * buffer that has to survive it. Legitimately negative when stock outlasts
   * the window, and shown that way - it is the reader's signal that nothing
   * needs ordering. Only the quantity below is floored.
   */
  const cover =
    oosMs === null || ssDays === null || endMs === null ? null : (endMs - oosMs) / DAY + ssDays

  const reqQty = cover === null || perDay === null ? null : Math.max(0, cover * perDay)

  /*
   * When to place the order: back off the lead time and the buffer from the day
   * stock runs out. Frequently in the past on a long lead time, which is a
   * finding rather than an error - the table marks those overdue.
   */
  const reqDateMs =
    oosMs === null || lead === null || ssDays === null ? null : oosMs - (lead + ssDays) * DAY

  /*
   * Delivery one and two, held as day offsets from today and converted to dates
   * for display. The source sheet shows the offsets, and they can be negative;
   * the offset is kept on the row so the column can show the date and say the
   * offset in its tooltip.
   */
  const d1Off = dtl === null || ssDays === null ? null : dtl - ssDays
  const d1Qty = reqQty === null || freq === null || freq <= 0 ? null : reqQty / freq
  const d2Qty = reqQty === null || d1Qty === null ? null : reqQty - d1Qty
  /*
   * No second delivery, no second deadline. Fixed 16 Sep 2026.
   *
   * This was worked out from the first delivery's size alone, so an article on
   * a delivery frequency of 1 - the commonest setting, 928 rows of the planning
   * sheet - got a date for a delivery that does not exist. The whole request
   * arrives once, the remainder is nought, and the row still announced a second
   * arrival in November.
   *
   * The source spreadsheet does the same and it was reproduced faithfully,
   * quirk included, when this was built: its own row shows a D2 offset of 50.00
   * against a D2 quantity of 0. A number in a spare cell is harmless; a date in
   * a column headed "2nd delivery by" reads as a commitment.
   *
   * The quantity is left exactly as specified - Req Qty minus the first
   * delivery, which really is nought - because that is a true remainder. It is
   * the date that asserted an event, so it is the date that goes.
   */
  const d2Off =
    d1Qty === null || perDay === null || d1Off === null || !(d2Qty > 0)
      ? null
      : d1Qty / perDay + d1Off

  const offsetDate = (off) => (off === null || nowMs === null ? null : nowMs + off * DAY)

  /*
   * The first delivery deadline, and ONLY it, counts from the first day of the
   * selected range instead of from today.
   *
   * Asked for on 16 Sep 2026, narrowly and deliberately. The source spreadsheet
   * anchors three of its four date cells - Forecasted OOS Date, Target Cover,
   * Req Date - on TODAY(), and its first-delivery cell on the slicer start.
   * This reproduces that exactly, so the two can be reconciled cell for cell.
   *
   * It is worth being clear about what that costs, because it is not an
   * oversight in this code: the gap between Forecasted OOS Date and this column
   * is no longer exactly the safety stock. It becomes SS + (today - first
   * selected day), so on a range starting yesterday the two columns sit 16 days
   * apart on a 15-day buffer. Every other column keeps the TODAY anchor, as
   * instructed, which is what leaves this one out of step with them.
   *
   * Falls back to today when no range is selected, which is the only case with
   * no first day to use.
   */
  const d1Anchored = dateFrom ? Date.parse(`${dateFrom}T00:00:00Z`) : NaN
  const d1From = Number.isFinite(d1Anchored) ? d1Anchored : nowMs
  const d1Date = (off) => (off === null || d1From === null ? null : d1From + off * DAY)

  /*
   * The three figures from the third screenshot.
   *
   * Total SOH is everything the warehouse has had available across the window -
   * what it still holds, what is on order, and what it has already issued.
   * New WH Forecast adds the safety buffer to the requirement, and New ACC% is
   * the ratio of the two: how much of the buffered requirement is covered. It
   * is a coverage ratio, not an accuracy score, and it can exceed 100% - which
   * is why it is not compared against the ACC% columns in Article Detail.
   */
  const totalSoh = soh === null && outbound === null ? null : (soh ?? 0) + pending + (outbound ?? 0)
  const newForecast = forecast === null ? null : forecast + (ssQty ?? 0)
  const newAcc =
    totalSoh === null || newForecast === null || newForecast <= 0 ? null : totalSoh / newForecast

  return {
    Per_Day_Qty: perDay,
    SS_Qty: ssQty,
    Plan_WH_SOH: soh,
    DTL: dtl,
    Target_Cover: cover,
    Req_Qty: reqQty,
    Req_Date: reqDateMs,
    OOS_Date: oosMs,
    // The only date anchored on the first selected day - see `d1Date` above.
    D1_Date: d1Date(d1Off),
    D1_Offset: d1Off,
    D1_Qty: d1Qty,
    // Still counted from today, like every other date here.
    D2_Date: offsetDate(d2Off),
    D2_Offset: d2Off,
    D2_Qty: d2Qty,
    Total_SOH: totalSoh,
    New_WH_Forecast: newForecast,
    New_ACC: newAcc,
  }
}
