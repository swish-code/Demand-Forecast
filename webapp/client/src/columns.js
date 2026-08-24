/**
 * Shared column widths.
 *
 * Every table in the app draws its widths from here, so an Article column is
 * the same width on Product Level as on Production Plan, and all numeric
 * columns line up at the same right edge. One flexible column per table (the
 * name column) takes the remaining space.
 */
export const W = {
  article: 164,
  brand: 84,
  location: 112,
  unit: 92,
  type: 136,
  group: 180,
  qty: 136,
  pct: 152,
  status: 158,
}
