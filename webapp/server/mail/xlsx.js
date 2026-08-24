import { deflateRawSync } from 'node:zlib'

/**
 * A real Excel workbook, written here rather than by a library.
 *
 * A .csv opens as text: article codes lose their leading zeros, quantities
 * arrive as strings, and a branch looking at it on a phone sees a wall of
 * commas. What people mean by "send it as Excel" is a file that opens as a
 * sheet — bold headings that stay put when you scroll, columns wide enough to
 * read, numbers Excel will actually add up, and a filter row.
 *
 * An .xlsx is a zip of XML parts, all of which are written below. That is a few
 * hundred lines, against a dependency this project would then have to carry to
 * the company's own server; the format has not changed since 2007 and none of
 * this needs maintaining.
 *
 * What is deliberately left out: shared strings (every string is written
 * inline, which costs bytes and saves a whole indirection), themes, and
 * calculation chains. Excel, LibreOffice, Google Sheets and Numbers all open
 * the result.
 */

/* ------------------------------------------------------------------ zip --- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * A zip archive of the parts, deflated.
 *
 * Written by hand rather than streamed: a workbook here is a few hundred
 * kilobytes, and holding it in memory is what lets it be attached to an email
 * without a temporary file on disk.
 */
function zip(files) {
  const chunks = []
  const central = []
  let offset = 0

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const deflated = deflateRawSync(body, { level: 6 })
    const crc = crc32(body)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(0, 10) // time — fixed, so the same data gives the same file
    local.writeUInt16LE(0x21, 12) // date — 1 Jan 1996, an arbitrary constant
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, deflated)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0) // central directory header
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt16LE(0, 12)
    dir.writeUInt16LE(0x21, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(deflated.length, 20)
    dir.writeUInt32LE(body.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42) // where the local header sits
    central.push(Buffer.concat([dir, nameBuf]))

    offset += local.length + nameBuf.length + deflated.length
  }

  const dirBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dirBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...chunks, dirBuf, end])
}

/* ------------------------------------------------------------------ xml --- */

const esc = (v) =>
  String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Control characters are not legal in XML at all, and Excel refuses the
    // whole file over a single one — which a product name pasted out of a till
    // system can easily contain.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

/** A1, B1 … Z1, AA1. */
function colName(index) {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/* --------------------------------------------------------------- styles --- */

/*
 * Five formats, which is all a report like this needs:
 *
 *   0  plain text
 *   1  the heading row — bold, on a light fill, with a rule under it
 *   2  a whole number with thousands separators
 *   3  one decimal place, for quantities in kilograms and litres
 *   4  a percentage, already scaled
 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.0"/><numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/></numFmts>
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF0F3A22"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDF3EE"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFD3C4"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`

const STYLE_OF = { text: 0, int: 2, number: 3, percent: 4 }

/* ---------------------------------------------------------------- sheets -- */

/**
 * One sheet.
 *
 * `columns` is the same shape the CSV writer takes — [{ label, key, value,
 * type, width }] — so both files are built from one description and cannot
 * disagree about what a column means.
 */
function sheetXml({ columns, rows }) {
  const widths = columns
    .map((c, i) => {
      const width =
        c.width ??
        Math.min(
          46,
          Math.max(
            10,
            String(c.label).length + 3,
            ...rows.slice(0, 200).map((r) => String(valueOf(c, r) ?? '').length + 2)
          )
        )
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`
    })
    .join('')

  const header = columns
    .map((c, i) => `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${esc(c.label)}</t></is></c>`)
    .join('')

  const body = rows
    .map((row, n) => {
      const cells = columns
        .map((c, i) => {
          const raw = valueOf(c, row)
          if (raw === null || raw === undefined || raw === '') return ''
          const ref = `${colName(i)}${n + 2}`
          const type = c.type ?? (typeof raw === 'number' ? 'number' : 'text')
          if (type !== 'text' && Number.isFinite(Number(raw))) {
            return `<c r="${ref}" s="${STYLE_OF[type] ?? 0}"><v>${Number(raw)}</v></c>`
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(raw)}</t></is></c>`
        })
        .join('')
      return `<row r="${n + 2}">${cells}</row>`
    })
    .join('')

  const last = `${colName(columns.length - 1)}${rows.length + 1}`

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths}</cols>
<sheetData><row r="1" ht="20" customHeight="1">${header}</row>${body}</sheetData>
${rows.length ? `<autoFilter ref="A1:${last}"/>` : ''}
</worksheet>`
}

const valueOf = (column, row) => (column.value ? column.value(row) : row[column.key])

/** Excel refuses these in a tab name, and silently truncates past 31 characters. */
const tabName = (name) => String(name).replace(/[\\/*?:[\]]/g, '-').slice(0, 31) || 'Sheet1'

/**
 * A workbook of one or more sheets, as a Buffer ready to attach.
 *
 * Several sheets in one file rather than several files: a branch opening one
 * attachment and finding Products, Articles and To prepare as tabs is the way
 * this is normally handed over, and it is one thing to save rather than three.
 */
export function workbook(sheets) {
  const used = new Set()
  const named = sheets.map((s, i) => {
    let name = tabName(s.name ?? `Sheet${i + 1}`)
    let n = 2
    while (used.has(name.toLowerCase())) name = `${tabName(s.name).slice(0, 28)} ${n++}`
    used.add(name.toLowerCase())
    return { ...s, name, rows: s.rows ?? [] }
  })

  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]

  return zip(files)
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
