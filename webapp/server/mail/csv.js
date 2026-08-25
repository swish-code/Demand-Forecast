/**
 * The same figures as the email, as a file somebody can open in Excel.
 *
 * The HTML table is for reading on a phone at six in the morning; this is for
 * the person who wants to sort it, filter it, or paste it into an order sheet.
 * Both are built from the same rows, so they cannot disagree.
 */

/**
 * Excel's CSV rules, which are not quite RFC 4180.
 *
 * Two things matter beyond quoting. A field that starts with =, +, - or @ is
 * treated as a formula, and a product name beginning with "-" would be executed
 * rather than shown — prefixing a tab stops that without changing what is
 * displayed. And a leading zero on an article code is discarded unless the
 * field looks like text, which is why codes are quoted with a tab too.
 */
function cell(value) {
  if (value === null || value === undefined) return ''
  let s = String(value)
  // A negative number is not a formula. Guarding it as one turns -8.0 into text
  // and Excel then refuses to sum the column, which is the one thing somebody
  // opening a CSV actually wants to do.
  const numeric = s !== '' && Number.isFinite(Number(s))
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = '\t' + s
  return /[",\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** `columns` is [{ key, label, value? }]. */
export function toCsv(rows, columns) {
  const header = columns.map((c) => cell(c.label)).join(',')
  const body = rows.map((r) =>
    columns.map((c) => cell(c.value ? c.value(r) : r[c.key])).join(',')
  )
  // A BOM, so Excel opens it as UTF-8 rather than mangling every Arabic name.
  return '﻿' + [header, ...body].join('\r\n') + '\r\n'
}

const int = (v) => Math.round(Number(v) || 0)
const pct = (v) => (Number.isFinite(Number(v)) ? Number((Number(v) * 100).toFixed(1)) : '')

/* --------------------------------------------------------------- sheets --- */

/*
 * One description per report, used by both writers.
 *
 * `type` is for the spreadsheet: it decides whether Excel treats a cell as a
 * number it can total or as text. A PLU is text on purpose — 0090196 is an
 * identifier, and as a number it loses its leading zero.
 */

/** One branch's plan, article by article. */
export function planSheet(rows) {
  return {
    name: 'Product PLU',
    columns: [
      { key: 'CHAINID', label: 'Brand', type: 'text', width: 10 },
      { key: 'LocationID', label: 'Branch', type: 'text', width: 10 },
      { key: 'Clean_ItemID', label: 'Product PLU', type: 'text', width: 16 },
      { key: 'ProductName_Fixed_Option', label: 'Product', type: 'text', width: 34 },
      { label: 'Prepare', type: 'int', value: (r) => int(r.Tomorrow_Forecast_Qty) },
      { label: 'Recent daily average', type: 'int', value: (r) => int(r.Last_Avg_Actual) },
      { label: 'Demand change %', type: 'percent', value: (r) => pct(r.Demand_Change_Pct) },
      { key: 'Prep_Status', label: 'Prep status', type: 'text', width: 20 },
    ],
    rows: [...rows].sort((a, b) => int(b.Tomorrow_Forecast_Qty) - int(a.Tomorrow_Forecast_Qty)),
  }
}

/** The same plan summed to product level. */
export function productSheet(rows) {
  const map = new Map()
  for (const r of rows) {
    const key = `${r.LocationID}|${r.ProductName_Fixed_Option}`
    const prev = map.get(key) ?? {
      Brand: r.CHAINID,
      Branch: r.LocationID,
      Product: r.ProductName_Fixed_Option,
      forecast: 0,
      recent: 0,
      articles: 0,
    }
    prev.forecast += Number(r.Tomorrow_Forecast_Qty) || 0
    prev.recent += Number(r.Last_Avg_Actual) || 0
    prev.articles += 1
    map.set(key, prev)
  }
  return {
    name: 'Products',
    columns: [
      { key: 'Brand', label: 'Brand', type: 'text', width: 10 },
      { key: 'Branch', label: 'Branch', type: 'text', width: 10 },
      { key: 'Product', label: 'Product', type: 'text', width: 34 },
      { key: 'articles', label: 'PLUs', type: 'int' },
      { label: 'Prepare', type: 'int', value: (r) => int(r.forecast) },
      { label: 'Recent daily average', type: 'int', value: (r) => int(r.recent) },
    ],
    rows: [...map.values()].sort((a, b) => b.forecast - a.forecast),
  }
}

/**
 * The prepared items a branch has to make, from the recipe side.
 *
 * PA is the node type for something the kitchen produces itself rather than
 * takes off a shelf, so it is the part of the ingredient list that is work
 * rather than stock.
 */
export function preparedSheet(rows) {
  return {
    name: 'To prepare',
    columns: [
      { key: 'Recipe Group', label: 'Recipe group', type: 'text', width: 24 },
      { key: 'Item', label: 'Prepared item', type: 'text', width: 34 },
      { key: 'BU', label: 'Unit', type: 'text', width: 10 },
      { label: 'Quantity', type: 'number', value: (r) => Number(Number(r.Component_Forecast_Qty).toFixed(2)) },
    ],
    rows: [...rows].sort(
      (a, b) => (Number(b.Component_Forecast_Qty) || 0) - (Number(a.Component_Forecast_Qty) || 0)
    ),
  }
}

/** Yesterday across every brand, as the morning digest reports it. */
export function digestSheet(daily) {
  return {
    name: 'Accuracy',
    columns: [
      { key: 'brand', label: 'Brand', type: 'text', width: 10 },
      { key: 'label', label: 'Name', type: 'text', width: 22 },
      { label: 'Accuracy %', type: 'percent', value: (r) => pct(r.accuracy) },
      { label: 'Sold', type: 'int', value: (r) => int(r.actual) },
      { label: 'Forecast', type: 'int', value: (r) => int(r.forecast) },
      { label: 'Variance', type: 'int', value: (r) => int(r.actual) - int(r.forecast) },
      { key: 'day', label: 'Day measured', type: 'text', width: 14 },
    ],
    rows: daily ?? [],
  }
}

/* ------------------------------------------------------------------ csv --- */

const asCsv = ({ columns, rows }) => toCsv(rows, columns)

export const planCsv = (rows) => asCsv(planSheet(rows))
export const productCsv = (rows) => asCsv(productSheet(rows))
export const preparedCsv = (rows) => asCsv(preparedSheet(rows))
export const digestCsv = (daily) => asCsv(digestSheet(daily))
