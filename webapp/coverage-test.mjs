/**
 * Does the copy ever claim more than it holds?
 *
 * The fault this guards against drew a thirty-day chart from four days of rows
 * and said nothing. So: put known rows in, ask what the copy thinks it covers,
 * and check it refuses every window it cannot actually answer.
 */
import 'dotenv/config'
import { initDatabase, pg } from './server/db/accounts.js'
import * as cube from './server/cube/query.js'

await initDatabase()

let failures = 0
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${what}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

const days = (from, to) => {
  const out = []
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

/** Fill the tables for one brand over a range, the way an extract would. */
const fill = async (brand, from, to) => {
  for (const d of days(from, to)) {
    await pg.run('INSERT INTO cube_location_daily (brand, date, location, actual, forecast) VALUES (?, ?, ?, 10, 10)', [brand, d, 'SAD'])
    await pg.run('INSERT INTO cube_article_daily (brand, date, article, product, actual, forecast) VALUES (?, ?, ?, ?, 10, 10)', [brand, d, '1', 'P'])
    await pg.run('INSERT INTO cube_component_daily (brand, date, recipe, item, bu, node_type, actual, forecast) VALUES (?, ?, ?, ?, ?, ?, 10, 10)', [brand, d, 'R', 'I', 'Each', 'RAW'])
    await pg.run('INSERT INTO cube_daily (brand, date, location, product, actual, forecast) VALUES (?, ?, ?, ?, 10, 10)', [brand, d, 'SAD', 'P'])
  }
}

/* Rebuild coverage the way the extract does, by measuring the tables. */
const { noteCoverageForTest } = await import('./server/cube/extract.js')

const wipe = async () => {
  for (const t of ['cube_daily', 'cube_location_daily', 'cube_article_daily', 'cube_component_daily', 'cube_coverage']) {
    await pg.run(`DELETE FROM ${t}`)
  }
}

const ask = (from, to, locations) =>
  cube.canAnswer('X', { brand: 'X', brands: ['X'], dateFrom: from, dateTo: to, ...(locations ? { locations } : {}) })

/* 1. The reported fault: only the last four days are in the copy. */
await wipe()
await fill('X', '2026-08-26', '2026-08-29')
await noteCoverageForTest({ code: 'X' })
await cube.loadCoverage()

check('a four-day copy refuses a thirty-day window', ask('2026-07-31', '2026-08-29'), false)
check('and answers the four days it has', ask('2026-08-26', '2026-08-29'), true)
check('and refuses one day beyond them', ask('2026-08-25', '2026-08-29'), false)

/* 2. A copy that really does hold the range. */
await wipe()
await fill('X', '2026-07-01', '2026-08-29')
await noteCoverageForTest({ code: 'X' })
await cube.loadCoverage()
check('a two-month copy answers thirty days', ask('2026-07-31', '2026-08-29'), true)

/* 3. Coverage must be able to shrink, not only grow. */
await pg.run("DELETE FROM cube_location_daily WHERE date < '2026-08-26'")
await noteCoverageForTest({ code: 'X' })
await cube.loadCoverage()
check('losing rows narrows the claim', ask('2026-07-31', '2026-08-29'), false)

/* 4. An empty copy claims nothing. */
await wipe()
await noteCoverageForTest({ code: 'X' })
await cube.loadCoverage()
check('an empty copy answers nothing', ask('2026-08-26', '2026-08-29'), false)

/* 5. The branch-grain window is separate from the wide one. */
await wipe()
await fill('X', '2026-07-01', '2026-08-29')
await pg.run("DELETE FROM cube_daily WHERE date < '2026-08-20'")
await noteCoverageForTest({ code: 'X' })
await cube.loadCoverage()
check('without a branch filter the wide range applies', ask('2026-07-01', '2026-08-29'), true)
check('with one, only what the detail table holds', ask('2026-07-01', '2026-08-29', ['SAD']), false)
check('and that shorter window is answered', ask('2026-08-20', '2026-08-29', ['SAD']), true)

console.log(failures ? `\n  ${failures} FAILED` : '\n  the copy never claims more than it holds')
process.exit(failures ? 1 : 0)
