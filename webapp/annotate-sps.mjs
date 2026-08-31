/**
 * Annotate the supply planning sheet with what the dashboard knows today.
 *
 * The sheet marks 1,590 items "Not Exist" against the September forecast. That
 * was true when it was written; a good many of them are in a recipe now, and
 * most of the rest can be forecast from what actually moves. This writes the
 * same rows back out with a column saying which, and a second sheet holding
 * only the ones still beyond reach.
 *
 * Reading and writing .xlsx without a library: the format is a zip of XML, and
 * the writer this project already uses for the daily reports is reused here.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import 'dotenv/config'
import { config } from './server/config.js'
import { executeQuery, normalizeRows } from './server/powerbi/client.js'
import { getAccessToken } from './server/powerbi/auth.js'
import { workbook } from './server/mail/xlsx.js'

const IN = process.argv[2]
const OUT = process.argv[3]

/* ------------------------------------------------------------- reading --- */

const unzip = (buf) => {
  // Minimal central-directory walk: enough to pull the parts we need.
  const files = new Map()
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < n; i++) {
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 24)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const lnLen = buf.readUInt16LE(offset + 26)
    const leLen = buf.readUInt16LE(offset + 28)
    const start = offset + 30 + lnLen + leLen
    const raw = buf.subarray(start, start + buf.readUInt32LE(p + 20))
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw.subarray(0, size))
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

const buf = fs.readFileSync(IN)
const parts = unzip(buf)
const text = (name) => parts.get(name)?.toString('utf8') ?? ''

const shared = []
for (const m of text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
  shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''))
}
const unesc = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

const relTargets = Object.fromEntries(
  [...text('xl/_rels/workbook.xml.rels').matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]])
)
const sheetRefs = [...text('xl/workbook.xml').matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
const spsRef = sheetRefs.find(([, name]) => name === 'SPS') ?? sheetRefs.find((m) => m[1] === 'SPS')
const target = (spsRef[2] ? relTargets[spsRef[2]] : null) ?? 'worksheets/sheet2.xml'
const sheetPath = target.startsWith('xl/') ? target : 'xl/' + target.replace(/^\//, '')

const grid = []
for (const rowM of text(sheetPath).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
  const cells = {}
  for (const cm of rowM[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const [, col, attrs, body] = cm
    const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
    const inline = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')
    cells[col] = / t="s"/.test(attrs) && v !== undefined ? shared[Number(v)] : inline || v || ''
  }
  if (Object.keys(cells).length) grid.push(cells)
}

const header = grid[0]
const cols = Object.keys(header).sort((a, b) => (a.length - b.length) || a.localeCompare(b))
const labels = cols.map((c) => unesc(String(header[c] ?? '')).replace(/\s+/g, ' ').trim())
const codeCol = cols[labels.findIndex((l) => l.toLowerCase() === 'code')]
const descCol = cols[labels.findIndex((l) => /item description/i.test(l))]
const fcCol = cols[labels.findIndex((l) => /frcst qty/i.test(l))]

console.log(`  sheet SPS: ${grid.length - 1} rows, ${cols.length} columns`)
console.log(`  code=${codeCol} description=${descCol} forecast=${fcCol}`)

/* ------------------------------------------------- what the app knows now --- */

const brand = config.brands[0]
const recipeRows = await executeQuery(
  `EVALUATE SUMMARIZECOLUMNS('RECIPE TABLE'[Item No.], 'RECIPE TABLE'[Node Type])`,
  brand.datasetId,
  { bulk: true }
)
const inRecipe = new Map()
for (const r of recipeRows) {
  const k = String(r['Item No.'] ?? '').trim()
  if (k) inRecipe.set(k, String(r['Node Type'] ?? ''))
}

const token = await getAccessToken()
const res = await fetch(
  `https://api.powerbi.com/v1.0/myorg/groups/${config.warehouse.workspaceId}/datasets/${config.warehouse.datasetId}/executeQueries`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queries: [{ query: `EVALUATE SUMMARIZECOLUMNS(fact_outbound_line[Article No.], "n", COUNTROWS(fact_outbound_line))` }],
      serializerSettings: { includeNulls: true },
    }),
  }
)
const moves = new Set(
  normalizeRows((await res.json())?.results?.[0]?.tables?.[0]?.rows ?? []).map((r) => String(r['Article No.'] ?? '').trim())
)
console.log(`  recipe articles ${inRecipe.size} | articles that move ${moves.size}`)

/* ----------------------------------------------------------- annotating --- */

const verdict = (code, sheetForecast) => {
  const hadForecast = sheetForecast && !/^not exist$/i.test(sheetForecast.trim())
  if (hadForecast) return { status: 'Already forecast', how: 'Had a Sep-26 quantity in this sheet' }
  // Twenty rows carry no article number at all — the Code column itself reads
  // "Not Exist". Nothing can be matched to them, and saying which is more use
  // than reporting them as simply absent.
  if (!/^\d+$/.test(code))
    return { status: 'No — no article number', how: 'The Code column has no ERP article number, so nothing can be matched to it' }
  if (inRecipe.has(code))
    return { status: 'Yes — in a recipe', how: `Used by recipes as ${inRecipe.get(code)}; forecast follows product sales` }
  if (moves.has(code))
    return { status: 'Yes — by constant', how: 'No recipe, but it moves: forecast from outbound scaled by sales' }
  return { status: 'No', how: 'Not in any recipe and no stock movement recorded' }
}

const rows = []
for (const r of grid.slice(1)) {
  const code = unesc(String(r[codeCol] ?? '')).trim()
  if (!code) continue
  const v = verdict(code, unesc(String(r[fcCol] ?? '')))
  const out = {}
  cols.forEach((c, i) => {
    out[labels[i] || c] = unesc(String(r[c] ?? ''))
  })
  out['In dashboard now?'] = v.status
  out['How it is forecast'] = v.how
  rows.push(out)
}

// Everything still without a forecast, whichever reason: the sheet asked for
// the items that do not exist even now, and a missing article number is as
// much a reason as a missing recipe.
const stillMissing = rows.filter((r) => String(r['In dashboard now?']).startsWith('No'))

const tally = {}
for (const r of rows) tally[r['In dashboard now?']] = (tally[r['In dashboard now?']] ?? 0) + 1
console.log('\n  verdicts:')
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`)

const columns = [...labels.filter(Boolean), 'In dashboard now?', 'How it is forecast'].map((label) => ({
  label,
  key: label,
  type: 'text',
}))

fs.writeFileSync(
  OUT,
  workbook([
    { name: 'SPS with status', columns, rows },
    { name: 'Still not forecast', columns, rows: stillMissing },
  ])
)
console.log(`\n  written ${OUT}`)
console.log(`  sheet 1: ${rows.length} rows | sheet 2: ${stillMissing.length} rows`)
process.exit(0)
