/**
 * Monthly MC Analysis - every rule the page and the alert job depend on.
 *
 * Snowflake is replaced by an in-memory stand-in (`fakeSnowflake`) that
 * answers the exact statements store.js sends, with real transaction
 * semantics: a unit of work that throws leaves nothing behind. Power BI, the
 * mail transport and the app database are injected, so nothing here reaches a
 * network or the local database.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.SNOWFLAKE_DATABASE = 'TESTDB'
process.env.SNOWFLAKE_SCHEMA = 'COSTING'

const { cleanMonth, previousMonth, monthPair, monthFigures, buildRows, selectAlerts, ALERT_THRESHOLD } =
  await import('./analysis.js')
const store = await import('./store.js')
const { buildAlertEmail, runVarianceAlerts } = await import('./alerts.js')
const { canEditCosting } = await import('../routes/costing.js')
const { allowedPages, PAGE_IDS } = await import('../departments.js')

/* ------------------------------------------------- the fake warehouse -- */

function fakeSnowflake() {
  const s = { classif: new Map(), audit: [], alerts: [], nextAudit: 1, nextAlert: 1 }
  const log = []
  const fake = { log, failOn: null, get state() { return s } }
  const now = () => new Date().toISOString()

  /*
   * Rollback undoes THIS transaction's writes only, the way the warehouse
   * does - restoring a whole-state snapshot would also erase a concurrent
   * transaction that committed in between.
   */
  function exec(sql, binds = [], undo = null) {
    const keep = (fn) => undo?.push(fn)
    const q = sql.replace(/\s+/g, ' ').trim()
    log.push(q)
    if (fake.failOn && fake.failOn.test(q)) throw new Error('simulated Snowflake failure')
    if (/^CREATE TABLE/.test(q)) return { rows: [], affected: null }
    if (/^SELECT COUNT\(\*\) AS N FROM \S+COSTING_ARTICLE_CLASSIFICATION/.test(q)) {
      return { rows: [{ N: s.classif.size }], affected: null }
    }
    // The one-time copy from the app database.
    if (/^INSERT INTO \S+COSTING_ARTICLE_CLASSIFICATION/.test(q)) {
      const [id, name, initial, current, manual, version, who, whoName, uid, at] = binds
      keep(() => s.classif.delete(id))
      s.classif.set(id, {
        ARTICLE_ID: id,
        ARTICLE_NAME: name,
        INITIAL_CLASSIFICATION: initial,
        CURRENT_CLASSIFICATION: current,
        IS_MANUAL_OVERRIDE: manual,
        VERSION: version,
        UPDATED_BY: who,
        UPDATED_BY_NAME: whoName,
        UPDATED_BY_USER_ID: uid,
        UPDATED_AT: at,
      })
      return { rows: [], affected: 1 }
    }
    if (/^INSERT INTO \S+COSTING_CLASSIFICATION_AUDIT/.test(q) && !q.includes("'Classification'")) {
      const [id, name, field, prev, next, who, whoName, uid, at] = binds
      const auditId = s.nextAudit++
      keep(() => s.audit.splice(s.audit.findIndex((a) => a.AUDIT_ID === auditId), 1))
      s.audit.push({
        AUDIT_ID: auditId, ARTICLE_ID: id, ARTICLE_NAME: name, FIELD_NAME: field, PREVIOUS_VALUE: prev,
        NEW_VALUE: next, UPDATED_BY: who, UPDATED_BY_NAME: whoName, UPDATED_BY_USER_ID: uid, UPDATED_AT: at,
      })
      return { rows: [], affected: 1 }
    }

    if (/^SELECT CURRENT_CLASSIFICATION, VERSION FROM \S+COSTING_ARTICLE_CLASSIFICATION/.test(q)) {
      const r = s.classif.get(binds[0])
      return { rows: r ? [{ CURRENT_CLASSIFICATION: r.CURRENT_CLASSIFICATION, VERSION: r.VERSION }] : [], affected: null }
    }
    if (/^UPDATE \S+COSTING_ARTICLE_CLASSIFICATION/.test(q)) {
      const [next, name, who, whoName, uid, id, ver] = binds
      const r = s.classif.get(id)
      if (!r || r.VERSION !== ver) return { rows: [], affected: 0 }
      const was = { ...r }
      keep(() => Object.assign(r, was))
      Object.assign(r, {
        CURRENT_CLASSIFICATION: next,
        IS_MANUAL_OVERRIDE: true,
        VERSION: r.VERSION + 1,
        ARTICLE_NAME: name ?? r.ARTICLE_NAME,
        UPDATED_BY: who,
        UPDATED_BY_NAME: whoName,
        UPDATED_BY_USER_ID: uid,
        UPDATED_AT: now(),
      })
      return { rows: [], affected: 1 }
    }
    if (/^MERGE INTO \S+COSTING_ARTICLE_CLASSIFICATION/.test(q)) {
      const [, id, name, initial, next, who, whoName, uid] = binds
      if (s.classif.has(id)) return { rows: [], affected: 0 }
      keep(() => s.classif.delete(id))
      s.classif.set(id, {
        ARTICLE_ID: id,
        ARTICLE_NAME: name,
        INITIAL_CLASSIFICATION: initial,
        CURRENT_CLASSIFICATION: next,
        IS_MANUAL_OVERRIDE: true,
        VERSION: 1,
        UPDATED_BY: who,
        UPDATED_BY_NAME: whoName,
        UPDATED_BY_USER_ID: uid,
        UPDATED_AT: now(),
      })
      return { rows: [], affected: 1 }
    }
    if (/^INSERT INTO \S+COSTING_CLASSIFICATION_AUDIT/.test(q)) {
      const [id, name, prev, next, who, whoName, uid] = binds
      const auditId = s.nextAudit++
      keep(() => s.audit.splice(s.audit.findIndex((a) => a.AUDIT_ID === auditId), 1))
      s.audit.push({
        AUDIT_ID: auditId,
        ARTICLE_ID: id,
        ARTICLE_NAME: name,
        FIELD_NAME: 'Classification',
        PREVIOUS_VALUE: prev,
        NEW_VALUE: next,
        UPDATED_BY: who,
        UPDATED_BY_NAME: whoName,
        UPDATED_BY_USER_ID: uid,
        UPDATED_AT: now(),
      })
      return { rows: [], affected: 1 }
    }
    if (/^SELECT VERSION, UPDATED_BY, UPDATED_BY_NAME, UPDATED_AT FROM/.test(q)) {
      const r = s.classif.get(binds[0])
      return {
        rows: r ? [{ VERSION: r.VERSION, UPDATED_BY: r.UPDATED_BY, UPDATED_BY_NAME: r.UPDATED_BY_NAME, UPDATED_AT: r.UPDATED_AT }] : [],
        affected: null,
      }
    }
    if (/^SELECT ARTICLE_ID, ARTICLE_NAME, INITIAL_CLASSIFICATION/.test(q)) {
      return { rows: [...s.classif.values()].map((r) => ({ ...r })), affected: null }
    }
    if (/FROM \S+COSTING_CLASSIFICATION_AUDIT WHERE ARTICLE_ID = \?/.test(q)) {
      return { rows: s.audit.filter((a) => a.ARTICLE_ID === binds[0]).map((a) => ({ ...a })), affected: null }
    }
    if (/^SELECT 1 AS X FROM \S+COSTING_VARIANCE_ALERT/.test(q)) {
      return { rows: s.alerts.length ? [{ X: 1 }] : [], affected: null }
    }
    if (/^MERGE INTO \S+COSTING_VARIANCE_ALERT/.test(q)) {
      const status = binds[binds.length - 1]
      let inserted = 0
      for (let i = 0; i + 9 <= binds.length - 1; i += 9) {
        const [key, art, name, brand, month, theo, actual, pct, threshold] = binds.slice(i, i + 9)
        if (s.alerts.some((a) => a.ALERT_KEY === key)) continue
        keep(() => s.alerts.splice(s.alerts.findIndex((a) => a.ALERT_KEY === key), 1))
        s.alerts.push({
          ALERT_ID: s.nextAlert++,
          ALERT_KEY: key,
          ARTICLE_ID: art,
          ARTICLE_NAME: name,
          BRAND: brand,
          ALERT_MONTH: month,
          MC_THEORETICAL: theo,
          ACTUAL_CONSUMPTION: actual,
          VARIANCE_PCT: pct,
          ALERT_THRESHOLD: threshold,
          STATUS: status,
          ATTEMPTS: 0,
          LAST_ERROR: null,
          EMAIL_SENT_AT: null,
          RECIPIENTS: null,
          CREATED_AT: now(),
          UPDATED_AT: now(),
        })
        inserted += 1
      }
      return { rows: [], affected: inserted }
    }
    if (/WHERE STATUS = 'pending' OR \(STATUS = 'failed' AND ATTEMPTS < \?\)/.test(q)) {
      const max = binds[0]
      return {
        rows: s.alerts.filter((a) => a.STATUS === 'pending' || (a.STATUS === 'failed' && a.ATTEMPTS < max)).map((a) => ({ ...a })),
        affected: null,
      }
    }
    if (/^UPDATE \S+COSTING_VARIANCE_ALERT/.test(q)) {
      const [status, error, recipients, ...ids] = binds
      let n = 0
      for (const a of s.alerts) {
        if (!ids.includes(a.ALERT_ID)) continue
        a.STATUS = status
        a.ATTEMPTS += 1
        a.LAST_ERROR = error
        if (status === 'sent') a.EMAIL_SENT_AT = now()
        if (recipients !== null) a.RECIPIENTS = recipients
        n += 1
      }
      return { rows: [], affected: n }
    }
    if (/WHERE ALERT_MONTH IN/.test(q)) {
      return { rows: s.alerts.filter((a) => binds.includes(a.ALERT_MONTH)).map((a) => ({ ...a })), affected: null }
    }
    throw new Error(`fake Snowflake does not understand: ${q.slice(0, 120)}`)
  }

  fake.query = async (sql, binds) => exec(sql, binds).rows
  fake.transaction = async (work) => {
    const undo = []
    try {
      return await work(async (sql, binds) => exec(sql, binds, undo))
    } catch (err) {
      for (const fn of undo.reverse()) fn() // ROLLBACK
      throw err
    }
  }
  return fake
}

let sf
// What the app database holds for the carry-over; empty unless a test fills it.
let localHeld
beforeEach(() => {
  sf = fakeSnowflake()
  localHeld = { classifications: [], audit: [] }
  // Never the real app database from a test - the dev server owns that file.
  store.useDriverForTests(sf, { rows: async () => localHeld })
})

const USER = { id: 7, email: 'cost.controller@example.com', name: 'Cost Controller' }

/* --------------------------------------------------------------- months -- */

test('months: calendar month and the one before, across a year boundary', () => {
  assert.equal(cleanMonth('2026-11'), '2026-11-01')
  assert.equal(cleanMonth('2026-11-19'), '2026-11-01')
  assert.equal(cleanMonth('2026-13'), null)
  assert.equal(cleanMonth('rubbish'), null)
  assert.equal(previousMonth('2026-01-01'), '2025-12-01')
  assert.equal(previousMonth('2026-03-01'), '2026-02-01')
  assert.deepEqual(monthPair('2026-10'), { current: '2026-10-01', previous: '2026-09-01' })
  assert.deepEqual(monthPair(null, new Date(2026, 10, 19)), { current: '2026-11-01', previous: '2026-10-01' })
  assert.deepEqual(monthPair('not a month', new Date(2027, 0, 3)), { current: '2027-01-01', previous: '2026-12-01' })
})

/* --------------------------------------------------------- calculations -- */

test('figures use the Variance page formulas', () => {
  const f = monthFigures({ potential: 100, consumption: 125 })
  assert.equal(f.theoretical, 100)
  assert.equal(f.actual, 125)
  assert.equal(f.variancePct, 0.25) // (125 - 100) / 100
  assert.equal(f.accuracy, 0.8) // 1 - 25 / 125
  assert.equal(f.status, 'Variance')

  const under = monthFigures({ potential: 200, consumption: 150 })
  assert.equal(under.variancePct, -0.25)
  assert.equal(under.accuracy, 0.75)
})

test('a month MC does not hold is missing, never zero', () => {
  const f = monthFigures(undefined)
  assert.deepEqual(f, { theoretical: null, actual: null, accuracy: null, variancePct: null, status: 'Missing Data' })
})

test('no theoretical: no variance %, no accuracy', () => {
  const f = monthFigures({ potential: 0, consumption: 40 })
  assert.equal(f.variancePct, null)
  assert.equal(f.accuracy, null)
  assert.notEqual(f.status, 'Match')
})

/* ------------------------------------------------------ classification -- */

const months = { current: '2026-11-01', previous: '2026-10-01' }
const series = new Map([
  ['100|BBT', new Map([['2026-10-01', { potential: 100, consumption: 130 }]])],
  ['100|YLO', new Map([['2026-11-01', { potential: 50, consumption: 50 }]])],
  ['200|BBT', new Map([['2026-10-01', { potential: 10, consumption: 11 }]])],
  ['300|BBT', new Map([['2026-08-01', { potential: 10, consumption: 11 }]])], // outside both months
])
const names = new Map([
  ['100', 'Chicken breast'],
  ['200', 'Napkin'],
])

test('initial classification comes from Recipe File SWiSH', () => {
  const rows = buildRows({ series, names, recipe: new Set(['100']), overrides: new Map(), months })
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.equal(byKey['100|BBT'].classification, 'Recipe')
  assert.equal(byKey['100|BBT'].initialClassification, 'Recipe')
  assert.equal(byKey['200|BBT'].classification, 'Non-Recipe')
  assert.equal(byKey['200|BBT'].overridden, false)
  assert.equal(byKey['200|BBT'].version, 0)
  assert.equal(byKey['300|BBT'], undefined, 'an article with nothing in either month is not listed')
})

test('a manual override wins over the Recipe File, on every brand row', () => {
  const overrides = new Map([
    ['100', { current: 'Non-Recipe', overridden: true, version: 3, updatedBy: 'a@x', updatedAt: '2026-11-18T10:00:00Z' }],
  ])
  const rows = buildRows({ series, names, recipe: new Set(['100']), overrides, months })
  for (const r of rows.filter((r) => r.articleId === '100')) {
    assert.equal(r.classification, 'Non-Recipe')
    assert.equal(r.initialClassification, 'Recipe', 'the initial value is kept separately')
    assert.equal(r.overridden, true)
    assert.equal(r.version, 3)
    assert.equal(r.lastUpdatedBy, 'a@x')
  }
})

test('the Recipe File changing later does not overwrite a manual choice', () => {
  const overrides = new Map([['200', { current: 'Non-Recipe', overridden: true, version: 1 }]])
  // 200 has since been added to the Recipe File.
  const rows = buildRows({ series, names, recipe: new Set(['100', '200']), overrides, months })
  const r = rows.find((r) => r.key === '200|BBT')
  assert.equal(r.initialClassification, 'Recipe')
  assert.equal(r.classification, 'Non-Recipe')
})

test('rows are limited to the brands the account may see', () => {
  const rows = buildRows({ series, names, recipe: new Set(), overrides: new Map(), months, brands: new Set(['YLO']) })
  assert.deepEqual(rows.map((r) => r.key), ['100|YLO'])
})

/* --------------------------------------------------------------- alerts -- */

const alertRow = (id, brand, cur, prev) => ({
  articleId: id,
  articleName: `Article ${id}`,
  brand,
  classification: 'Recipe',
  current: cur ? monthFigures(cur) : monthFigures(undefined),
  previous: prev ? monthFigures(prev) : monthFigures(undefined),
})

test('alerts fire beyond ±20% only, in either month', () => {
  const rows = [
    alertRow('A', 'BBT', { potential: 100, consumption: 125 }), // +25%  -> alert
    alertRow('B', 'BBT', { potential: 100, consumption: 75 }), //  -25%  -> alert
    alertRow('C', 'BBT', { potential: 100, consumption: 115 }), // +15%
    alertRow('D', 'BBT', { potential: 100, consumption: 82 }), //  -18%
    alertRow('E', 'BBT', { potential: 100, consumption: 120 }), // exactly +20%, not "above"
    alertRow('F', 'BBT', { potential: 0, consumption: 500 }), //   no theoretical, no percentage
    alertRow('G', 'BBT', null, { potential: 10, consumption: 30 }), // previous month +200%
  ]
  const found = selectAlerts(rows, months)
  assert.deepEqual(
    found.map((a) => `${a.articleId}:${a.month}`).sort(),
    ['A:2026-11-01', 'B:2026-11-01', 'G:2026-10-01']
  )
  assert.equal(found[0].threshold, ALERT_THRESHOLD)
})

test('the email lists every alert, escapes names and carries a CSV', () => {
  const msg = buildAlertEmail(
    [
      { articleId: '1', articleName: 'Fish <fillet> & "co"', brand: 'BBT', month: '2026-10-01', theoretical: 100, actual: 130, variancePct: 0.3, threshold: 0.2 },
      { articleId: '2', articleName: 'Rice', brand: 'YLO', month: '2026-10-01', theoretical: 100, actual: 70, variancePct: -0.3, threshold: 0.2 },
    ],
    { link: 'https://app.example/?page=costing' }
  )
  assert.match(msg.subject, /above 20%: 2 articles/)
  assert.match(msg.html, /Fish &lt;fillet&gt; &amp; &quot;co&quot;/)
  assert.doesNotMatch(msg.html, /<fillet>/)
  assert.match(msg.html, /\+30\.0%/)
  assert.match(msg.html, /-30\.0%/)
  assert.match(msg.html, /page=costing/)
  assert.match(msg.html, /Nothing has been changed automatically/)
  const csv = msg.attachments[0].content.toString('utf8')
  assert.equal(csv.trim().split('\r\n').length, 3)
  assert.match(csv, /"Fish <fillet> & ""co"""/)
})

/* ------------------------------------------------ storing a classification -- */

const change = (over) =>
  store.setClassification({ articleId: '100', articleName: 'Chicken breast', initial: 'Recipe', next: 'Non-Recipe', expectedVersion: 0, user: USER, ...over })

test('first change creates the row and one audit entry with the user', async () => {
  const r = await change()
  assert.equal(r.changed, true)
  assert.equal(r.previous, 'Recipe')
  assert.equal(r.current, 'Non-Recipe')
  assert.equal(r.version, 1)
  assert.equal(r.updatedBy, USER.email)
  assert.equal(r.updatedByName, USER.name, 'the account name is kept beside the email')

  const row = sf.state.classif.get('100')
  assert.equal(row.INITIAL_CLASSIFICATION, 'Recipe')
  assert.equal(row.CURRENT_CLASSIFICATION, 'Non-Recipe')
  assert.equal(row.IS_MANUAL_OVERRIDE, true)

  const history = await store.auditHistory('100')
  assert.equal(history.length, 1)
  assert.deepEqual(
    { field: history[0].field, previous: history[0].previous, next: history[0].next, by: history[0].updatedBy },
    { field: 'Classification', previous: 'Recipe', next: 'Non-Recipe', by: USER.email }
  )
  assert.ok(history[0].updatedAt)
})

test('later changes update the row, bump the version and append to history', async () => {
  await change()
  const r = await change({ next: 'Recipe', expectedVersion: 1 })
  assert.equal(r.version, 2)
  assert.equal(r.previous, 'Non-Recipe')
  const history = await store.auditHistory('100')
  assert.deepEqual(history.map((h) => `${h.previous}->${h.next}`), ['Recipe->Non-Recipe', 'Non-Recipe->Recipe'])
  // Set back to the initial value, it is STILL a manual decision.
  assert.equal(sf.state.classif.get('100').IS_MANUAL_OVERRIDE, true)
  const loaded = await store.loadClassifications()
  assert.equal(loaded.get('100').overridden, true)
  assert.equal(loaded.get('100').current, 'Recipe')
})

test('choosing the value already held changes nothing and writes no history', async () => {
  const r = await change({ next: 'Recipe' }) // initial is Recipe, nothing stored
  assert.equal(r.changed, false)
  assert.equal(sf.state.classif.size, 0)
  assert.equal(sf.state.audit.length, 0)
})

test('a stale editor gets a conflict and changes nothing', async () => {
  await change() // version 1 now
  await assert.rejects(change({ next: 'Recipe', expectedVersion: 0 }), (err) => err.status === 409)
  assert.equal(sf.state.classif.get('100').CURRENT_CLASSIFICATION, 'Non-Recipe')
  assert.equal(sf.state.audit.length, 1)
})

test('two people saving at once: one wins, the other gets a conflict', async () => {
  const results = await Promise.allSettled([change(), change({ next: 'Non-Recipe' })])
  // Both read version 0 before either writes; the second insert finds the row
  // already there and is refused, and its rollback leaves the winner intact.
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 1)
  assert.equal(sf.state.audit.length, 1)
})

test('if the audit row cannot be written, the change is rolled back', async () => {
  sf.failOn = /^INSERT INTO \S+COSTING_CLASSIFICATION_AUDIT/
  await assert.rejects(change(), /simulated/)
  assert.equal(sf.state.classif.size, 0, 'no classification without its audit row')
  assert.equal(sf.state.audit.length, 0)
})

test('bad input is refused', async () => {
  await assert.rejects(change({ next: 'Maybe' }), (err) => err.status === 400)
  await assert.rejects(change({ user: {} }), (err) => err.status === 401)
})

test('the audit table is only ever inserted into', async () => {
  await change()
  await change({ next: 'Recipe', expectedVersion: 1 })
  const touchingAudit = sf.log.filter((q) => /COSTING_CLASSIFICATION_AUDIT/.test(q) && !/^CREATE TABLE/.test(q))
  assert.ok(touchingAudit.length > 0)
  for (const q of touchingAudit) assert.match(q, /^(INSERT INTO|SELECT)/, q)
})

/* ---------------------------------------------------- the alert job -- */

function analysisWith(rowsRef) {
  return async () => ({ months, rows: rowsRef.rows })
}

function harness(rowsRef, over = {}) {
  const sent = []
  const raised = []
  const logged = []
  const deps = {
    configured: () => true,
    analysis: analysisWith(rowsRef),
    alertRecipients: async () => ['cc1@example.com', 'cc2@example.com'],
    sendMail: async (m) => {
      if (over.failSend) throw new Error('SMTP down')
      sent.push(m)
    },
    logEmail: (e) => logged.push(e),
    raise: (a) => raised.push(a),
    clear: () => {},
    testTo: null,
    appOrigin: 'https://app.example',
    ...over.deps,
  }
  return { deps, sent, raised, logged }
}

test('first run records existing exceedances as baseline and emails nobody', async () => {
  const ref = { rows: [alertRow('A', 'BBT', { potential: 100, consumption: 150 })] }
  const h = harness(ref)
  const r = await runVarianceAlerts({ deps: h.deps })
  assert.equal(r.baseline, true)
  assert.equal(h.sent.length, 0)
  assert.equal(sf.state.alerts.length, 1)
  assert.equal(sf.state.alerts[0].STATUS, 'baseline')
})

test('a new exceedance is emailed once, in one email per recipient, and never again', async () => {
  const ref = { rows: [alertRow('A', 'BBT', { potential: 100, consumption: 150 })] }
  const h = harness(ref)
  await runVarianceAlerts({ deps: h.deps }) // baseline

  ref.rows = [...ref.rows, alertRow('B', 'YLO', { potential: 100, consumption: 60 }), alertRow('C', 'BBT', { potential: 50, consumption: 80 })]
  const second = await runVarianceAlerts({ deps: h.deps })
  assert.equal(second.sent, 2)
  assert.equal(h.sent.length, 2, 'one digest to each recipient')
  assert.match(h.sent[0].subject, /2 articles/)
  assert.doesNotMatch(h.sent[0].html, /Article A/, 'the baseline alert is not emailed')
  assert.deepEqual(sf.state.alerts.map((a) => a.STATUS).sort(), ['baseline', 'sent', 'sent'])
  assert.ok(sf.state.alerts.filter((a) => a.STATUS === 'sent').every((a) => a.EMAIL_SENT_AT && a.RECIPIENTS))

  const third = await runVarianceAlerts({ deps: h.deps })
  assert.equal(third.sent, 0)
  assert.equal(h.sent.length, 2, 'nothing is sent twice')
  assert.equal(sf.state.alerts.length, 3, 'no duplicate rows')
})

test('a failed send is recorded, raised, and retried on the next run', async () => {
  const ref = { rows: [] }
  const ok = harness(ref)
  await runVarianceAlerts({ deps: ok.deps }) // empty baseline - nothing recorded yet
  // Make sure the next run is not treated as a first run.
  await store.recordAlerts([{ articleId: 'Z', brand: 'BBT', month: '2026-09-01', theoretical: 1, actual: 2, variancePct: 1, threshold: 0.2 }], 'baseline')

  ref.rows = [alertRow('B', 'BBT', { potential: 100, consumption: 60 })]
  const bad = harness(ref, { failSend: true })
  const r = await runVarianceAlerts({ deps: bad.deps })
  assert.equal(r.sent, 0)
  assert.equal(r.error, 'SMTP down')
  const b = sf.state.alerts.find((a) => a.ARTICLE_ID === 'B')
  assert.equal(b.STATUS, 'failed')
  assert.equal(b.ATTEMPTS, 1)
  assert.equal(b.LAST_ERROR, 'SMTP down')
  assert.equal(bad.raised.at(-1).key, 'costing:send')
  assert.equal(bad.logged.filter((l) => l.status === 'failed').length, 2)

  const retry = harness(ref)
  const r2 = await runVarianceAlerts({ deps: retry.deps })
  assert.equal(r2.sent, 1)
  assert.equal(sf.state.alerts.find((a) => a.ARTICLE_ID === 'B').STATUS, 'sent')
})

test('retries stop at the attempt limit', async () => {
  await store.recordAlerts([{ articleId: 'Z', brand: 'BBT', month: '2026-09-01', theoretical: 1, actual: 2, variancePct: 1, threshold: 0.2 }], 'baseline')
  const ref = { rows: [alertRow('B', 'BBT', { potential: 100, consumption: 60 })] }
  const bad = harness(ref, { failSend: true })
  for (let i = 0; i < 7; i++) await runVarianceAlerts({ deps: bad.deps })
  const b = sf.state.alerts.find((a) => a.ARTICLE_ID === 'B')
  assert.equal(b.ATTEMPTS, 5)
  assert.equal(b.STATUS, 'failed')
})

test('with nobody to send to, alerts wait and an app alert is raised', async () => {
  await store.recordAlerts([{ articleId: 'Z', brand: 'BBT', month: '2026-09-01', theoretical: 1, actual: 2, variancePct: 1, threshold: 0.2 }], 'baseline')
  const ref = { rows: [alertRow('B', 'BBT', { potential: 100, consumption: 60 })] }
  const h = harness(ref, { deps: { alertRecipients: async () => [] } })
  const r = await runVarianceAlerts({ deps: h.deps })
  assert.equal(r.error, 'no recipients')
  assert.equal(h.raised[0].key, 'costing:recipients')
  assert.equal(sf.state.alerts.find((a) => a.ARTICLE_ID === 'B').STATUS, 'pending')
})

test('MAIL_TEST_TO redirects the email and says who it was for', async () => {
  await store.recordAlerts([{ articleId: 'Z', brand: 'BBT', month: '2026-09-01', theoretical: 1, actual: 2, variancePct: 1, threshold: 0.2 }], 'baseline')
  const ref = { rows: [alertRow('B', 'BBT', { potential: 100, consumption: 60 })] }
  const h = harness(ref, { deps: { testTo: 'tester@example.com' } })
  await runVarianceAlerts({ deps: h.deps })
  assert.ok(h.sent.every((m) => m.to === 'tester@example.com'))
  assert.match(h.sent[0].subject, /^\[test → cc1@example\.com\]/)
})

test('the alert job never changes a classification', async () => {
  await change() // a manual classification exists
  const before = structuredClone(sf.state.classif.get('100'))
  const from = sf.log.length
  const ref = { rows: [alertRow('100', 'BBT', { potential: 100, consumption: 300 })] }
  const h = harness(ref)
  await runVarianceAlerts({ deps: h.deps })
  await runVarianceAlerts({ deps: h.deps })
  assert.deepEqual(sf.state.classif.get('100'), before)
  const writes = sf.log.slice(from).filter((q) => /^(UPDATE|MERGE INTO|INSERT INTO|DELETE FROM) \S+COSTING_ARTICLE_CLASSIFICATION/.test(q))
  assert.deepEqual(writes, [])
})

test('nothing runs when Snowflake is not configured', async () => {
  const r = await runVarianceAlerts({ deps: { configured: () => false } })
  assert.equal(r.skipped, 'Snowflake is not configured')
  assert.equal(sf.log.length, 0)
})

/* ------------------------------------- copy from the app database -- */

const heldLocally = () => ({
  classifications: [
    {
      article_id: '555', article_name: 'Rice', initial_classification: 'Recipe', current_classification: 'Non-Recipe',
      is_manual_override: true, version: 2, updated_by: 'a@x', updated_by_name: 'Aisha', updated_by_user_id: 3,
      updated_at: '2026-11-19T10:00:00.000Z', created_at: '2026-11-19T09:00:00.000Z',
    },
  ],
  audit: [
    { article_id: '555', article_name: 'Rice', field_name: 'Classification', previous_value: 'Recipe', new_value: 'Non-Recipe', updated_by: 'a@x', updated_by_name: 'Aisha', updated_by_user_id: 3, updated_at: '2026-11-19T09:00:00.000Z' },
    { article_id: '555', article_name: 'Rice', field_name: 'Classification', previous_value: 'Non-Recipe', new_value: 'Recipe', updated_by: 'a@x', updated_by_name: 'Aisha', updated_by_user_id: 3, updated_at: '2026-11-19T09:30:00.000Z' },
  ],
})

test('edits made before Snowflake are copied into it, history and all', async () => {
  localHeld = heldLocally()
  const loaded = await store.loadClassifications()
  assert.equal(loaded.get('555').current, 'Non-Recipe')
  assert.equal(loaded.get('555').version, 2)
  assert.equal(loaded.get('555').updatedByName, 'Aisha')
  const history = await store.auditHistory('555')
  assert.equal(history.length, 2)
  assert.equal(history[0].updatedByName, 'Aisha')
  // And the next editor continues from the copied version.
  const r = await store.setClassification({ articleId: '555', articleName: 'Rice', initial: 'Recipe', next: 'Recipe', expectedVersion: 2, user: USER })
  assert.equal(r.version, 3)
})

test('the copy never lands on top of classifications already in Snowflake', async () => {
  await change() // Snowflake now holds article 100
  store.useDriverForTests(sf, { rows: async () => heldLocally() }) // re-runs the schema step
  const loaded = await store.loadClassifications()
  assert.equal(loaded.has('555'), false)
  assert.equal(loaded.has('100'), true)
})

/* ---------------------------- the app-database store, on real Postgres -- */

/*
 * An in-memory PostgreSQL, created for this test and thrown away - NOT the
 * app's database file, which the running dev server owns. It runs the
 * interim store's actual SQL, including the one-statement change + audit.
 */
const { PGlite } = await import('@electric-sql/pglite')
const { toPositional } = await import('../db/driver.js')
const local = await import('./localStore.js')

const mem = await PGlite.create()
const memDb = {
  async get(sql, params = []) {
    return (await mem.query(toPositional(sql), params)).rows[0]
  },
  async all(sql, params = []) {
    return (await mem.query(toPositional(sql), params)).rows
  },
  async exec(sql) {
    await mem.exec(sql)
  },
}
const conflict = (m) => Object.assign(new Error(m), { status: 409 })
const localChange = (over) =>
  local.setLocalClassification(
    { articleId: 'L1', articleName: 'Flour', initial: 'Recipe', next: 'Non-Recipe', expectedVersion: 0, who: 'cc@x', whoName: 'Cost Controller', userId: 9, conflict, ...over },
    memDb
  )

test('app database: a change and its history are saved together, with the name', async () => {
  const r = await localChange()
  assert.equal(r.changed, true)
  assert.equal(r.version, 1)
  assert.equal(r.updatedByName, 'Cost Controller')
  const r2 = await localChange({ next: 'Recipe', expectedVersion: 1 })
  assert.equal(r2.version, 2)

  const all = await local.loadLocalClassifications(memDb)
  assert.equal(all.get('L1').current, 'Recipe')
  assert.equal(all.get('L1').overridden, true)
  const history = await local.localAuditHistory('L1', memDb)
  assert.deepEqual(history.map((h) => `${h.previous}->${h.next} by ${h.updatedByName}`), [
    'Recipe->Non-Recipe by Cost Controller',
    'Non-Recipe->Recipe by Cost Controller',
  ])
})

test('app database: a stale version and a same-value change write nothing', async () => {
  await localChange({ articleId: 'L2' })
  await assert.rejects(localChange({ articleId: 'L2', next: 'Recipe', expectedVersion: 0 }), (e) => e.status === 409)
  const same = await localChange({ articleId: 'L2', next: 'Non-Recipe', expectedVersion: 1 })
  assert.equal(same.changed, false)
  assert.equal((await local.localAuditHistory('L2', memDb)).length, 1)
})

test('app database: two saves racing on a new article - one wins, one conflicts', async () => {
  const results = await Promise.allSettled([localChange({ articleId: 'L3' }), localChange({ articleId: 'L3' })])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 1)
  assert.equal((await local.localAuditHistory('L3', memDb)).length, 1)
})

test('app database: everything is handed over for the Snowflake copy', async () => {
  const held = await local.localRowsForCarryOver(memDb)
  assert.ok(held.classifications.some((r) => r.article_id === 'L1'))
  assert.ok(held.audit.filter((a) => a.article_id === 'L1').length === 2)
})

/* ---------------------------------------------------------------- access -- */

test('who may edit: Cost Controller and administrators only', () => {
  assert.equal(canEditCosting({ role: 'admin', department: null }), true)
  assert.equal(canEditCosting({ role: 'user', department: 'Cost Controller' }), true)
  assert.equal(canEditCosting({ role: 'user', department: '  cost controller ' }), true)
  assert.equal(canEditCosting({ role: 'user', department: 'Procurement' }), false)
  assert.equal(canEditCosting({ role: 'user', department: null }), false)
  assert.equal(canEditCosting(null), false)
})

test('the page is grantable and Cost Controller holds it by default', () => {
  assert.ok(PAGE_IDS.includes('costing'))
  assert.ok(allowedPages({ role: 'user', department: 'Cost Controller' }).includes('costing'))
  assert.ok(!allowedPages({ role: 'user', department: 'Procurement' }).includes('costing'))
})
