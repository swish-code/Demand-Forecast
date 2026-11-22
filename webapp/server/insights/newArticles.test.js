import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  lookbackFor,
  verdictFor,
  LOOKBACK_MONTHS,
  QUALIFY,
  BOUNDARY_DAYS,
  NEW_ARTICLE_LABEL,
  RETURNING_ARTICLE_LABEL,
} from './newArticles.js'

/*
 * New / Returning / Existing, judged against the period on the date slicer.
 *
 * Agreed 22 Nov 2026 after a read-only measurement of the live data: of 1,967
 * articles that had moved in the 30 days to 22 Nov, 71 had been silent for the
 * preceding twelve months. 67 of those had never moved before at all; 4 had
 * moved long ago and come back - article 102100001 among them, first seen
 * 20 Sep 2025, silent for over a year, 20 rows this month.
 *
 * Calling those 4 "New" was the defect this rule exists to avoid, and 16 of
 * the 67 had one or two movement rows in their whole life, which is what
 * QUALIFY exists to avoid. Both are pinned below.
 */

/* ------------------------------------------------- the dynamic lookback -- */

test('the lookback is twelve months ending the day before the period', () => {
  // The worked example from the brief.
  assert.deepEqual(lookbackFor('2026-10-01'), { start: '2025-10-01', end: '2026-09-30' })
  assert.deepEqual(lookbackFor('2026-11-01'), { start: '2025-11-01', end: '2026-10-31' })
  assert.deepEqual(lookbackFor('2026-12-01'), { start: '2025-12-01', end: '2026-11-30' })
  assert.deepEqual(lookbackFor('2027-01-01'), { start: '2026-01-01', end: '2026-12-31' })
})

test('the lookback moves with the slicer and never overlaps the period', () => {
  for (const from of ['2026-03-17', '2026-07-01', '2027-02-28']) {
    const got = lookbackFor(from)
    assert.ok(got.end < from, `${from}: the lookback must end before the period begins`)
    assert.ok(got.start < got.end, `${from}: the lookback must run forwards`)
    const years = Number(from.slice(0, 4)) - Number(got.start.slice(0, 4))
    assert.equal(years * 12, LOOKBACK_MONTHS, `${from}: twelve months back`)
  }
})

test('a period spanning months is judged from its own start', () => {
  // Agreed: one question about the whole report, not one per month in it.
  assert.deepEqual(lookbackFor('2026-10-01').start, '2025-10-01')
})

test('no period means no lookback, which means no verdict', () => {
  // The security-and-honesty direction: without a window there is nothing to
  // judge against, and the caller must leave the column blank rather than
  // falling back to today - the whole point of the change.
  assert.equal(lookbackFor(null), null)
  assert.equal(lookbackFor(''), null)
  assert.equal(lookbackFor('not a date'), null)
})

/* ------------------------------------------------------ the three kinds -- */

const moved = { periodRows: 10, periodDays: 5, lookbackStart: '2025-10-01' }

test('an article that moved during the lookback is Existing, so unflagged', () => {
  assert.equal(verdictFor({ ...moved, lookbackRows: 1, firstSeen: '2024-01-01' }), null)
  assert.equal(verdictFor({ ...moved, lookbackRows: 400, firstSeen: null }), null)
})

test('silent for twelve months with no history before them is New', () => {
  assert.equal(
    verdictFor({ ...moved, lookbackRows: 0, firstSeen: '2026-11-09' }),
    NEW_ARTICLE_LABEL
  )
  // No ledger row at all is also New: nothing has ever been seen of it.
  assert.equal(verdictFor({ ...moved, lookbackRows: 0, firstSeen: null }), NEW_ARTICLE_LABEL)
})

test('silent for twelve months WITH history before them is Returning', () => {
  /*
   * Article 102100001, the case this distinction was built for: first seen
   * 20 Sep 2025, nothing through the lookback, 20 rows in the period. It is
   * not new - the business had it a year ago and stopped using it.
   */
  assert.equal(
    verdictFor({ periodRows: 20, periodDays: 6, lookbackRows: 0, firstSeen: '2025-09-20', lookbackStart: '2025-11-01' }),
    RETURNING_ARTICLE_LABEL
  )
})

test('a first trace ON the lookback start is New, not Returning', () => {
  // The boundary belongs to the lookback: `<` not `<=`. An article first seen
  // the day the lookback opens has no history BEFORE it.
  assert.equal(
    verdictFor({ ...moved, lookbackRows: 0, firstSeen: '2025-10-01' }),
    NEW_ARTICLE_LABEL
  )
  assert.equal(
    verdictFor({ ...moved, lookbackRows: 0, firstSeen: '2025-09-30' }),
    RETURNING_ARTICLE_LABEL
  )
})

test('an article that did not move in the period is never flagged', () => {
  assert.equal(verdictFor({ periodRows: 0, periodDays: 0, lookbackRows: 0, lookbackStart: '2025-10-01' }), null)
})

/* ------------------------------------------------------------- QUALIFY --- */

test('a one-row article is not a launch, whichever kind it would have been', () => {
  /*
   * 16 of the 67 genuinely-new articles measured on 22 Nov had one or two
   * movement rows in their entire life. A real launch moves: the top of that
   * same list had 110 rows in a fortnight.
   */
  const thin = { lookbackRows: 0, lookbackStart: '2025-10-01' }
  assert.equal(verdictFor({ ...thin, periodRows: 1, periodDays: 1, firstSeen: null }), null)
  assert.equal(verdictFor({ ...thin, periodRows: 2, periodDays: 1, firstSeen: null }), null)
  // And it gates Returning too, not only New.
  assert.equal(verdictFor({ ...thin, periodRows: 1, periodDays: 1, firstSeen: '2024-01-01' }), null)
})

test('either arm of QUALIFY is enough on its own', () => {
  const base = { lookbackRows: 0, firstSeen: null, lookbackStart: '2025-10-01' }
  assert.equal(verdictFor({ ...base, periodRows: QUALIFY.rows, periodDays: 1 }), NEW_ARTICLE_LABEL)
  assert.equal(verdictFor({ ...base, periodRows: 1, periodDays: QUALIFY.days }), NEW_ARTICLE_LABEL)
})

test('QUALIFY is measured on the period, not on the article’s whole life', () => {
  /*
   * The reason the threshold moved with the window. A Returning article has
   * years of history, so a whole-life row count passes it by definition, and
   * the gate would never fire for the half of the population most likely to
   * hold a stray correction. One row this period is one row this period,
   * whatever 2024 looked like.
   */
  const src = readFileSync(new URL('./newArticles.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function verdictFor'), src.indexOf('/** Keep the ledger current'))
  assert.ok(/periodRows < QUALIFY\.rows && periodDays < QUALIFY\.days/.test(fn))
  assert.ok(!/MOVEMENT_ROWS|DISTINCT_DAYS/.test(fn), 'the whole-life columns must not decide this')
})

/* ------------------------------------- BOUNDARY_DAYS, and the ledger ----- */

test('a lookback reaching past recorded history classifies nothing', () => {
  /*
   * Re-pointed from the article to the WINDOW on 22 Nov. The old test asked
   * whether one article's first appearance sat too close to its source's
   * earliest record. Under a moving lookback the exposure is larger: if the
   * history does not cover the lookback, EVERY article looks dormant through
   * it and the rule would flag the lot.
   *
   * Outbound history begins in 2021 but only fills from 2024 (645 articles)
   * and 2025 (2,293), so this is not hypothetical.
   */
  const src = readFileSync(new URL('./newArticles.js', import.meta.url), 'utf8')
  assert.ok(
    /daysBetween\(outboundStart, lookback\.start\) < BOUNDARY_DAYS/.test(src),
    'the WINDOW must clear the start of recorded history, not the article'
  )
  assert.ok(/suppressed: true/.test(src), 'and a suppressed period must say so')
  assert.ok(BOUNDARY_DAYS >= 60, 'the margin must not be whittled away')
})

test('the ledger stores a fact and never a verdict', () => {
  /*
   * This is what lets the same article read New in October and Existing in
   * December with no ledger write at all, and why changing the slicer cannot
   * corrupt the history. If a verdict were ever written to the table, a reader
   * changing the date range would start overwriting other readers' answers.
   */
  const src = readFileSync(new URL('./newArticles.js', import.meta.url), 'utf8')
  assert.ok(!/UPDATE\s+\$\{T\(\)\}/i.test(src), 'the ledger must never be updated in place')
  assert.ok(!/MERGE\s+INTO/i.test(src), 'and never merged, which is an update wearing a hat')
  assert.ok(/INSERT INTO \$\{T\(\)\}/.test(src), 'it is insert-only')
  for (const label of [NEW_ARTICLE_LABEL, RETURNING_ARTICLE_LABEL]) {
    assert.ok(
      !new RegExp(`['"\`]${label}['"\`]\\s*\\)?\\s*,?\\s*$`, 'm').test(
        src.slice(src.indexOf('async function recordUnseen'), src.indexOf('export function lookbackFor'))
      ),
      `${label} must not be written to the ledger`
    )
  }
})

/* ------------------------------------------------- how it reaches a page - */

test('the stamp runs for every component-level page, not only pinned ones', () => {
  /*
   * It lived inside `withResponsibility` until 22 Nov, which returns at its
   * first line unless a department is pinned - so Procurement, which pins
   * none, never saw the column at all. That is the bug this change fixes, and
   * it would come back silently if the stamp moved back inside.
   */
  const api = readFileSync(new URL('../routes/api.js', import.meta.url), 'utf8')
  const code = api.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(/async function withArticleStatus\(/.test(code), 'it must be its own step')
  assert.equal(
    code.split('await withArticleStatus(').length - 1,
    2,
    'both the single-brand and merged pipelines must stamp it'
  )
  const within = code.slice(code.indexOf('async function withResponsibility'), code.indexOf('async function withArticleStatus'))
  assert.ok(!/New Article/.test(within), 'and must not be stamped from inside the responsibility filter')
})

test('the period reaches the classifier, and today never does', () => {
  const api = readFileSync(new URL('../routes/api.js', import.meta.url), 'utf8')
  const fn = api.slice(api.indexOf('async function withArticleStatus'), api.indexOf('async function withCategory'))
  assert.ok(/from: filters\?\.dateFrom/.test(fn), 'the window must come from the slicer')
  assert.ok(/to: filters\?\.dateTo/.test(fn))
  assert.ok(!/new Date\(\)/.test(fn), 'the clock must not decide what a reader sees')
})

test('an unknown classification filters nothing out', () => {
  /*
   * Dropping rows when the verdict could not be established would turn "we
   * could not tell" into "none of these are new", on a slicer the reader chose
   * deliberately. The same direction as the empty-page defect of 20 Nov.
   */
  const api = readFileSync(new URL('../routes/api.js', import.meta.url), 'utf8')
  const fn = api.slice(api.indexOf('async function withArticleStatus'), api.indexOf('async function withCategory'))
  assert.ok(/if \(!got\) return rows/.test(fn))
})

test('a failed ledger top-up does not take the page down with it', () => {
  /*
   * The blank page reported 22 Nov. Reconstructing the old rule against the
   * ledger showed it WOULD have flagged 52 articles that day, three of them
   * on Stock Article - so "nothing qualified" cannot explain an empty page.
   * The only way to reach zero was for the lookup to fail and every row to be
   * treated as not-new.
   *
   * Two defences, both pinned here: the top-up is allowed to fail without
   * taking the verdict with it, and a verdict that cannot be established
   * filters nothing.
   */
  const src = readFileSync(new URL('./newArticles.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('async function refreshLedger'), src.indexOf('async function movementFor'))
  assert.ok(/try \{[\s\S]*firstTraces\(\)[\s\S]*\} catch/.test(fn), 'the top-up must be guarded')
  assert.ok(/await ensureFirstSeenTable\(\)/.test(fn), 'but the table must still exist')
  assert.ok(
    fn.indexOf('await query(') > fn.indexOf('catch'),
    'the ledger must still be read after a failed top-up'
  )
})

test('the slicer offers both kinds and still refuses to offer "Existing"', () => {
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8')
  assert.ok(/newArticle: \['New', 'Returning'\]/.test(app))
  assert.ok(!/'Existing'/.test(app), 'a blank is not a claim that an article is old')
})
