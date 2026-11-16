import test from 'node:test'
import assert from 'node:assert/strict'

/*
 * The route modules must actually LOAD.
 *
 * WHY THIS TEST EXISTS
 *
 * On 8 Nov 2026 the consumption page was added and api.js failed to start three
 * times in a row, each time for a different reason and each time invisibly:
 *
 *   1. a second `withConsumption` was declared. Function declarations hoist, so
 *      the later one silently replaced the first and three pre-existing calls
 *      reached the wrong function.
 *   2. `consumptionByArticle` was imported twice - the warehouse's issuing from
 *      warehouse.js, and the outlets' consumption from consumption.js. Two
 *      different measurements that deserve the same English word.
 *   3. a paren was consumed rather than appended while wrapping the response
 *      chain, so the file no longer parsed at all.
 *
 * Every one of those is a module-load failure, and NONE of them was caught by
 * the client build, by the other 160 tests, or by `node --check` - which reads
 * a .js file as CommonJS whatever package.json says, so it reports the first
 * `import` as the error and hides everything after it.
 *
 * Importing the module is the test. It is the same thing the server does on
 * startup, so anything that would 500 the whole app fails here instead.
 * Measured: 127ms, and the process exits on its own, so nothing is left open.
 */
const ROUTES = ['./api.js', './admin.js']

for (const path of ROUTES) {
  test(`${path} loads`, async () => {
    const mod = await import(path)
    assert.ok(mod, `${path} imported as nothing`)
  })
}

/*
 * And a sharper message for the specific case that started it.
 *
 * The import above already fails when a name is declared twice, but it fails
 * with "Identifier X has already been declared" and no indication of which
 * file or why it matters. For a duplicated FUNCTION it does not fail at all -
 * hoisting makes that legal - so this is the only check that catches it.
 */
test('no route file declares a function name twice', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))

  for (const path of ROUTES) {
    const file = path.replace('./', '')
    const src = readFileSync(join(here, file), 'utf8')
    const names = [...src.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1])

    const seen = new Set()
    const clashes = new Set()
    for (const n of names) {
      if (seen.has(n)) clashes.add(n)
      seen.add(n)
    }

    assert.deepEqual(
      [...clashes],
      [],
      `redeclared in ${file} — hoisting makes the LAST one win silently, so every ` +
        `call in the file reaches it, including calls written before it: ${[...clashes].join(', ')}`
    )
  }
})
