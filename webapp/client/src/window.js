/**
 * Is the selected window entirely in the future?
 *
 * Picking "Tomorrow" or "Next 30 days" asks about days that have not happened.
 * There are no actuals for them and there never will be until they arrive, so
 * every actual reads zero, every variance reads −100%, and the page fills with
 * red that means nothing. A forecast for a future day is a plan, not a miss.
 *
 * Answered from the model's own calendar rather than the browser clock: the
 * last day with sales in it is a fact about the data, and the two can differ by
 * a day either way across time zones.
 */
export function isFutureWindow(filters, dateRange) {
  const from = filters?.dateFrom
  const measuredTo = dateRange?.lastActual || dateRange?.today
  if (!from || !measuredTo) return false
  return from > measuredTo
}

/** Columns and cards that only make sense once a day has actually happened. */
export const dropActuals = (columns, keys) => columns.filter((c) => !keys.includes(c.key))
