import { config } from '../config.js'
import { data } from '../data/index.js'
import { DEPARTMENTS } from '../departments.js'
import { REPORTS, listRecipients, createRecipient, updateRecipient } from './recipients.js'

/**
 * Adding recipients a spreadsheet at a time.
 *
 * Sixty branches added one modal at a time is an afternoon, and the list
 * already exists somewhere as a spreadsheet — the person who knows which
 * address belongs to which kitchen keeps it in Excel, not in this app. So the
 * spreadsheet is the input.
 *
 * One line per branch, because that is how such a list is actually written:
 *
 *   email,name,brand,branch
 *   byn.kitchen@swishhh.net,BBT Bayan,BBT,BYN
 *   byn.kitchen@swishhh.net,BBT Bayan,BBT,MNF
 *   area.north@swishhh.net,Area North,Shawarma Shakir,AGL;RAI
 *
 * Lines for the same address and report are folded into one recipient, so the
 * first two lines above make a single record covering two branches. Nothing is
 * written until the preview has been read: every file is parsed, checked
 * against the brands and the branches Power BI actually reports, and returned
 * as a list of what would happen — then applied only if asked for.
 */

/* ------------------------------------------------------------- parsing --- */

/**
 * A CSV reader that survives what spreadsheets produce.
 *
 * Excel writes a byte-order mark, ends lines with CRLF, quotes any field
 * containing a comma and doubles quotes inside quoted fields. A split on commas
 * gets all four of those wrong.
 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = String(text ?? '').replace(/^﻿/, '')

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    if (row.some((c) => c.trim() !== '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === ',' || c === '\t') endField()
    else if (c === '\n') endRow()
    else if (c === '\r') continue
    else field += c
  }
  if (field !== '' || row.length) endRow()
  return rows
}

/** Column names people actually type, mapped to the one this code uses. */
const HEADINGS = {
  email: 'email',
  'e-mail': 'email',
  address: 'email',
  mail: 'email',
  name: 'name',
  recipient: 'name',
  brand: 'brand',
  brands: 'brand',
  chain: 'brand',
  branch: 'branch',
  branches: 'branch',
  store: 'branch',
  stores: 'branch',
  location: 'branch',
  locations: 'branch',
  report: 'report',
  'what to send': 'report',
  department: 'department',
  team: 'department',
  active: 'active',
  sending: 'active',
}

const clean = (v) => String(v ?? '').trim()
const key = (v) => clean(v).toLowerCase()

/** Several branches in one cell: "AGL;RAI" or "AGL / RAI" or "AGL RAI". */
const splitBranches = (cell) =>
  clean(cell)
    .split(/[;|/]+|\s{1,}/)
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean)

/** A brand written as its code, its label, or close enough to either. */
function brandFor(cell) {
  const want = key(cell)
  if (!want) return null
  return (
    config.brands.find((b) => b.code.toLowerCase() === want) ??
    config.brands.find((b) => b.label.toLowerCase() === want) ??
    config.brands.find((b) => b.label.toLowerCase().replace(/\s+/g, '') === want.replace(/\s+/g, '')) ??
    null
  )
}

/** A report written as its key or as the label the form shows. */
function reportFor(cell) {
  const want = key(cell)
  if (!want) return 'store_plan'
  if (REPORTS[want]) return want
  const found = Object.entries(REPORTS).find(([, r]) => r.label.toLowerCase() === want)
  return found ? found[0] : null
}

/** A department written in any casing, resolved to the one the app stores. */
const departmentFor = (cell) => DEPARTMENTS.find((d) => d.toLowerCase() === key(cell)) ?? null

const isOff = (cell) => ['0', 'no', 'off', 'false', 'paused', 'inactive'].includes(key(cell))

/* -------------------------------------------------------------- reading --- */

/**
 * Turn the file into rows, keeping the line number each one came from.
 *
 * The line number is the whole point of the error list: "row 14 — MNF is not a
 * Shawarma Shakir branch" can be fixed in the spreadsheet, "a branch was wrong"
 * cannot.
 */
export function readRows(text) {
  const table = parseCsv(text)
  if (!table.length) return { rows: [], error: 'The file is empty.' }

  const header = table[0].map((h) => HEADINGS[key(h)] ?? key(h))
  if (!header.includes('email')) {
    return {
      rows: [],
      error: 'No "email" column. The first line must name the columns — email, name, brand, branch.',
    }
  }

  const rows = table.slice(1).map((cells, i) => {
    const get = (name) => {
      const at = header.indexOf(name)
      return at < 0 ? '' : (cells[at] ?? '')
    }
    return {
      line: i + 2, // 1 for the heading, 1 because people count from one
      email: clean(get('email')),
      name: clean(get('name')),
      brand: clean(get('brand')),
      branches: splitBranches(get('branch')),
      report: clean(get('report')),
      department: clean(get('department')),
      active: get('active'),
    }
  })

  return { rows, error: null }
}

/* -------------------------------------------------------------- checking -- */

/**
 * What a file would do, without doing it.
 *
 * Branch codes are checked against the branches Power BI reports for that
 * brand, because the commonest mistake in a list like this is a branch under
 * the wrong brand — and that error is invisible afterwards: the recipient is
 * created, matches no rows, and simply never receives anything.
 */
export async function planImport(text) {
  const { rows, error } = readRows(text)
  if (error) return { error, entries: [], problems: [] }

  const problems = []
  const wanted = new Map() // email|report -> entry

  // One slicer call per brand named in the file, not per row.
  const brandCodes = [...new Set(rows.map((r) => brandFor(r.brand)?.code).filter(Boolean))]
  const known = new Map()
  for (const code of brandCodes) {
    const brand = config.brands.find((b) => b.code === code)
    try {
      const slicers = await data.slicers(
        { brand: code, ...(brand.chain ? { brands: [brand.chain] } : {}) },
        brand.datasetId,
        ['locations']
      )
      known.set(code, new Set((slicers?.locations ?? []).map((l) => String(l).toUpperCase())))
    } catch {
      // A brand whose branch list will not load is not a reason to refuse the
      // file — it only means those branches go unchecked.
      known.set(code, null)
    }
  }

  for (const row of rows) {
    if (!row.email.includes('@')) {
      problems.push({ line: row.line, detail: `"${row.email || '(blank)'}" is not an email address.` })
      continue
    }

    const report = reportFor(row.report)
    if (!report) {
      problems.push({ line: row.line, detail: `"${row.report}" is not one of the reports.` })
      continue
    }

    const needsBranch = Boolean(REPORTS[report].needsLocation)
    const brand = brandFor(row.brand)
    if (row.brand && !brand) {
      problems.push({ line: row.line, detail: `"${row.brand}" is not one of the brands.` })
      continue
    }
    if (needsBranch && !brand) {
      problems.push({ line: row.line, detail: `${REPORTS[report].label} needs a brand.` })
      continue
    }
    if (needsBranch && !row.branches.length) {
      problems.push({ line: row.line, detail: `${REPORTS[report].label} needs at least one branch.` })
      continue
    }
    const department = row.department ? departmentFor(row.department) : null
    if (row.department && !department) {
      problems.push({ line: row.line, detail: `"${row.department}" is not one of the departments.` })
      continue
    }

    const branchList = known.get(brand?.code)
    const good = []
    for (const branch of row.branches) {
      if (branchList && !branchList.has(branch)) {
        problems.push({ line: row.line, detail: `${branch} is not a ${brand.label} branch.` })
        continue
      }
      good.push(branch)
    }
    if (needsBranch && !good.length) continue

    const id = `${row.email.toLowerCase()}|${report}`
    const entry = wanted.get(id) ?? {
      email: row.email,
      name: row.name,
      report,
      department,
      brands: new Set(),
      locations: new Set(),
      active: true,
      lines: [],
    }
    if (row.name && !entry.name) entry.name = row.name
    if (department && !entry.department) entry.department = department
    if (isOff(row.active)) entry.active = false
    if (brand) entry.brands.add(brand.code)
    for (const branch of good) entry.locations.add(`${brand.code}:${branch}`)
    entry.lines.push(row.line)
    wanted.set(id, entry)
  }

  // What each one would do to the list as it stands.
  const existing = listRecipients()
  const entries = [...wanted.values()].map((e) => {
    const match = existing.find(
      (r) => r.email.toLowerCase() === e.email.toLowerCase() && r.report === e.report
    )
    const brands = [...e.brands]
    const locations = [...e.locations]

    if (!match) {
      return {
        action: 'create',
        email: e.email,
        name: e.name,
        report: e.report,
        reportLabel: REPORTS[e.report].label,
        department: e.department,
        brands,
        locations,
        active: e.active,
        lines: e.lines,
        detail: locations.length ? locations.join(', ') : brands.join(', ') || 'every brand',
      }
    }

    // Existing recipients gain branches rather than losing the ones already
    // set: a file naming three branches is an addition to the list, not a
    // statement that every other branch should stop receiving mail.
    const mergedBrands = [...new Set([...(match.brands ?? []), ...brands])]
    const mergedLocations = [...new Set([...(match.locations ?? []), ...locations])]
    const added = mergedLocations.filter((l) => !(match.locations ?? []).includes(l))
    return {
      action: added.length || mergedBrands.length !== (match.brands ?? []).length ? 'update' : 'unchanged',
      id: match.id,
      email: e.email,
      name: e.name || match.name,
      report: e.report,
      reportLabel: REPORTS[e.report].label,
      department: e.department ?? match.department,
      brands: mergedBrands,
      locations: mergedLocations,
      active: e.active,
      lines: e.lines,
      detail: added.length ? `adds ${added.join(', ')}` : 'already covered',
    }
  })

  return { error: null, entries, problems }
}

/** Writes the plan. Anything already covered is left alone. */
export function applyImport(entries, actorId) {
  const counts = { created: 0, updated: 0, unchanged: 0 }
  for (const e of entries) {
    if (e.action === 'unchanged') {
      counts.unchanged += 1
      continue
    }
    if (e.action === 'create') {
      createRecipient(
        {
          email: e.email,
          name: e.name,
          report: e.report,
          department: e.department,
          brands: e.brands,
          locations: e.locations,
          active: e.active,
        },
        actorId
      )
      counts.created += 1
      continue
    }
    updateRecipient(e.id, {
      name: e.name,
      department: e.department,
      brands: e.brands,
      locations: e.locations,
      active: e.active,
    })
    counts.updated += 1
  }
  return counts
}

/** The file to start from, with the brands and branches spelled out. */
export function templateCsv() {
  const [first, second] = config.brands
  const lines = [
    'email,name,brand,branch,report,department',
    `byn.kitchen@swishhh.net,${first?.label ?? 'BBT'} Bayan,${first?.code ?? 'BBT'},BYN,Tomorrow's prep list,Branches`,
    `byn.kitchen@swishhh.net,${first?.label ?? 'BBT'} Bayan,${first?.code ?? 'BBT'},MNF,Tomorrow's prep list,Branches`,
    `area.north@swishhh.net,Area North,${second?.code ?? 'SS'},AGL;RAI,Branch forecast,Area Managers`,
  ]
  return `﻿${lines.join('\r\n')}\r\n`
}
