/**
 * A very small .xlsx writer: enough to carry live formulas and number formats.
 *
 * WHY NOT CSV, AND WHY NOT A LIBRARY
 *
 * A CSV can hold a formula - Excel evaluates a cell that starts with "=" - but
 * it cannot hold a NUMBER FORMAT. Every date formula would open as a bare
 * serial ("46265" rather than "17 Sep 26") until the reader formatted the
 * column by hand, and a percentage would read as 0.402. Carrying formulas and
 * leaving them unreadable is worse than carrying values.
 *
 * SheetJS would do all of this and more. It is also about a megabyte for one
 * export, against a client that has three runtime dependencies in total. What
 * is actually needed here is narrow: one table, one constants sheet, inline
 * strings, numbers, formulas with cached values, and five number formats. That
 * is this file, and it has no dependencies.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No shared string table (inline strings cost a few bytes more and remove a
 * whole index to keep consistent), no compression (a stored ZIP entry is valid
 * and Excel reads it; the file is a few hundred KB either way), no column
 * widths beyond what is asked for, no merged cells, no charts. Anything beyond
 * a formatted table with formulas belongs in a real library.
 *
 * THE CACHED VALUE MATTERS
 *
 * Every formula cell is written with both the formula and the value this app
 * computed for it. Excel shows the cached value immediately and recalculates on
 * the first edit, so the download opens showing exactly what the dashboard
 * showed - which is the requirement - and stays live afterwards.
 */

/* ---------------------------------------------------------------- zip ----- */

/*
 * CRC-32, table built once.
 *
 * A stored ZIP entry still has to carry a correct checksum: Excel refuses the
 * file outright if it does not match, with no indication of why.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (bytes) => {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const utf8 = (s) => new TextEncoder().encode(s)

/**
 * A ZIP archive with every entry stored rather than deflated.
 *
 * Written by hand because the alternative is a compression library, and the
 * only thing compression buys here is file size on a file nobody keeps.
 */
function zip(files) {
  const chunks = []
  const central = []
  let offset = 0

  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff]
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]

  for (const { name, data } of files) {
    const nameBytes = utf8(name)
    const sum = crc32(data)
    const local = [
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0x0800), // UTF-8 names
      ...u16(0), // stored
      ...u16(0),
      ...u16(0), // no timestamp: a fixed one keeps the output byte-identical
      ...u32(sum),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
    ]
    chunks.push(new Uint8Array(local), nameBytes, data)

    central.push([
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0x0800),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(sum),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...nameBytes,
    ])
    offset += local.length + nameBytes.length + data.length
  }

  const dir = central.flat()
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(dir.length),
    ...u32(offset),
    ...u16(0),
  ]
  chunks.push(new Uint8Array(dir), new Uint8Array(end))

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/* --------------------------------------------------------------- sheet ---- */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** A1-style column name: 1 -> A, 27 -> AA. */
export function colName(index) {
  let n = index
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/*
 * The style slots, in the order they are written into styles.xml.
 *
 * Referenced by index from every cell, so the order here is the contract. Two
 * of them exist only because a formula would otherwise be unreadable: DATE
 * turns a serial into a date, and PCT turns 0.402 into 40.2%.
 */
export const S = {
  PLAIN: 0,
  HEAD: 1,
  DATE: 2,
  QTY: 3, // thousands, no decimals
  COST: 4, // four decimals, for unit costs under a hundredth
  PCT: 5,
  DAYS: 6, // whole days
  RATE: 7, // two decimals, for per-day quantities
  LABEL: 8, // bold, for the constants sheet
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5">
<numFmt numFmtId="164" formatCode="dd&quot; &quot;mmm&quot; &quot;yy"/>
<numFmt numFmtId="165" formatCode="#,##0"/>
<numFmt numFmtId="166" formatCode="0.0000"/>
<numFmt numFmtId="167" formatCode="0.0%"/>
<numFmt numFmtId="168" formatCode="#,##0.00"/>
</numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`

/**
 * Excel's date serial. 1 Jan 1900 is 1, and it believes 1900 was a leap year,
 * which is why the epoch below is 30 Dec 1899 rather than 31 Dec.
 */
export function excelDate(value, { exact = false } = {}) {
  /*
   * A number is a millisecond timestamp, not a serial already.
   *
   * `Date.parse` accepts only strings: handed the 1.79e12 that this app carries
   * dates around as, it coerces to "1790000000000", fails to parse that as a
   * date and returns NaN. Every date cell's CACHED value came out blank that
   * way while its formula was perfectly correct - so the workbook opened with
   * empty date columns until Excel recalculated. Caught on 17 Sep 2026 by
   * comparing each formula's result against the value cached beside it.
   */
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Date.parse(value)
  if (!Number.isFinite(ms)) return null
  const serial = (ms - Date.UTC(1899, 11, 30)) / 86_400_000
  /*
   * `exact` keeps the fractional part, which is the time of day.
   *
   * A DERIVED date carries one: "today + 7.41 days" lands at 09:55 on the
   * eighth day. Rounding the cached value to 46289 while the formula evaluates
   * to 46289.41 makes the two disagree the moment Excel recalculates - both
   * display as the same date under the date format, so nothing looks wrong, but
   * a reader comparing the file against the dashboard finds a difference that
   * has no explanation. Exact for derived dates, rounded for the plain ones.
   */
  return exact ? serial : Math.round(serial)
}

/*
 * One cell.
 *
 * `c.f` is a formula without its leading "=", `c.v` the value to cache beside
 * it. A formula whose cached value is a blank string is written as a formula
 * with no <v> at all: Excel then computes it on open, which is right for the
 * rows where the dashboard shows a dash.
 */
function cell(ref, c) {
  if (c === null || c === undefined || c === '') return ''
  const style = c.s ? ` s="${c.s}"` : ''

  if (c.f) {
    const v = c.v
    const cached =
      v === null || v === undefined || v === '' ? '' : typeof v === 'number' && Number.isFinite(v) ? `<v>${v}</v>` : ''
    // A formula that evaluates to text needs t="str" for its cached value; the
    // ones here evaluate to numbers or to "", so no cached value is the right
    // answer for the blank case.
    return `<c r="${ref}"${style}><f>${esc(c.f)}</f>${cached}</c>`
  }

  if (typeof c.v === 'number' && Number.isFinite(c.v)) return `<c r="${ref}"${style}><v>${c.v}</v></c>`
  if (c.v === null || c.v === undefined || c.v === '') return style ? `<c r="${ref}"${style}/>` : ''
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`
}

function sheetXml(rows, { widths, freeze } = {}) {
  const cols = widths?.length
    ? `<cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''
  const pane = freeze
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : ''
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((c, i) => cell(`${colName(i + 1)}${r + 1}`, c))
        .filter(Boolean)
        .join('')
      return cells ? `<row r="${r + 1}">${cells}</row>` : ''
    })
    .filter(Boolean)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${body}</sheetData></worksheet>`
}

/**
 * Build a workbook from `[{ name, rows, widths, freeze }]` and return a Blob.
 *
 * `rows` is an array of arrays of cells; a cell is `{ v, f, s }`, or null for
 * an empty one. Sheet names are used verbatim in formulas, so keep them simple.
 */
export function buildXlsx(sheets) {
  const parts = [
    {
      name: '[Content_Types].xml',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets
        .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets>
<calcPr fullCalcOnLoad="1"/>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', body: STYLES },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      body: sheetXml(s.rows, s),
    })),
  ]

  return zip(parts.map((p) => ({ name: p.name, data: utf8(p.body) })))
}

/** The same bytes, wrapped for a browser download. */
export function downloadXlsx(filename, sheets) {
  const bytes = buildXlsx(sheets)
  const url = URL.createObjectURL(
    new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}
