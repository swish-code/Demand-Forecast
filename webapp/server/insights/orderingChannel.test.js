import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNEL,
  classifyInbound,
  classifyTransfer,
  costCentreKind,
  formatChannels,
  formatPaths,
  matchesChannelFilter,
  isWarehouse,
  latestChannels,
  latestMovement,
  pathsForBrand,
  brandOfCostCentre,
  transferStatus,
  TRANSFER_STATUS,
} from './orderingChannel.js'

/*
 * The Transaction Types, corrected 31 Oct 2026.
 *
 * The rules these pin are the ones that are easy to get backwards - and one of
 * them WAS backwards until this date:
 *   - an internal transfer is SWISH to SWISH, never brand to brand
 *   - a receipt into the warehouse is NOT Purchase
 *   - an unresolvable receipt is NOT Purchase either
 *   - a movement is named from its RECEIVING end only, so one movement can
 *     never put two values on one article row
 *   - a channel set is never a quantity, which is what keeps the row grain safe
 */

/* ------------------------------------------------- Purchase --------- */

test('a supplier delivery into a non-warehouse cost centre is Purchase', () => {
  assert.equal(classifyInbound({ costCentre: 'BBT', qty: 120 }), CHANNEL.DIRECT)
})

test('a receipt into the warehouse is NOT Purchase', () => {
  // Ordinary purchasing. The business rule says the receiving location must be
  // a cost centre OTHER than the warehouse.
  assert.equal(classifyInbound({ costCentre: 'MAIN WAREHOUSE', qty: 5000 }), null)
})

test('the warehouse is recognised under both of its names', () => {
  // PO lifecycle says "MAIN WAREHOUSE", outbound says "Central Warehouse".
  assert.ok(isWarehouse('MAIN WAREHOUSE'))
  assert.ok(isWarehouse('Central Warehouse'))
  assert.ok(isWarehouse('  central warehouse  '))
  assert.equal(classifyInbound({ costCentre: 'Central Warehouse', qty: 10 }), null)
})

test('a cost centre that merely contains the word warehouse is not the warehouse', () => {
  assert.ok(!isWarehouse('FM WH Ardiya'))
  // It is also not a cost centre at all - it is a shop-level location - so it
  // is surfaced rather than guessed onto the brand or the Swish side.
  assert.equal(classifyInbound({ costCentre: 'FM WH Ardiya', qty: 3 }), CHANNEL.REVIEW)
})

test('an excluded cost centre produces nothing at all', () => {
  // "dont consider them", 31 Oct 2026 - and the exclusion beats the sign, so
  // not even a negative receipt turns into a Return IN.
  for (const cc of ['HO', 'Marketing', 'Merchandise', 'LVB', 'SM', '  lvb  ']) {
    assert.equal(classifyInbound({ costCentre: cc, qty: 500 }), null)
    assert.equal(classifyInbound({ costCentre: cc, qty: -500 }), null)
  }
})

test('a supplier delivery into a BRAND cost centre is Purchase', () => {
  // Confirmed 31 Oct 2026: "all cost centres except the warehouse" includes
  // brands. This is the warehouse-bypassing flow the column exists to show.
  for (const cc of ['BBT', 'SS', 'MM', 'FM', 'FM-JHR']) {
    assert.equal(classifyInbound({ costCentre: cc, qty: 120 }), CHANNEL.DIRECT)
  }
})

test('a supplier delivery into a non-warehouse SWISH cost centre is Purchase too', () => {
  for (const cc of ['CKU/CPU', 'SWISH BAKERY', 'YELO FACTORY']) {
    assert.equal(classifyInbound({ costCentre: cc, qty: 120 }), CHANNEL.DIRECT)
  }
})

/* ------------------------------------- which side is a cost centre on ---- */

test('the brand and Swish lists are what the business says they are', () => {
  for (const cc of ['BBT', 'SS', 'MM', 'PAT', 'YP', 'SLC', 'BUR', 'CHP', 'TBL']) {
    assert.equal(costCentreKind(cc), 'brand', cc)
  }
  // Corrected 31 Oct 2026: FM and FM-JHR are brands, not facilities.
  assert.equal(costCentreKind('FM'), 'brand')
  assert.equal(costCentreKind('FM-JHR'), 'brand')
  // Store-level codes sit under their brands.
  assert.equal(costCentreKind('YP-Salam Mall'), 'brand')
  assert.equal(costCentreKind('YELO COOP'), 'brand')

  for (const cc of ['MAIN WAREHOUSE', 'Central Warehouse', 'CKU/CPU', 'SWISH BAKERY', 'YELO FACTORY']) {
    assert.equal(costCentreKind(cc), 'swish', cc)
  }
  // R&D moved here from `swish` on 1 Nov 2026 - a development kitchen, not a
  // supplying one. Pinned so the move cannot be undone by accident.
  for (const cc of ['HO', 'Marketing', 'Merchandise', 'LVB', 'SM', 'R&D']) {
    assert.equal(costCentreKind(cc), 'excluded', cc)
  }
})

test('an unrecognised cost centre is unknown, never quietly Swish', () => {
  // A new or renamed site must surface rather than silently relabel every
  // movement into it as an internal transfer.
  assert.equal(costCentreKind('NEW BRAND 2027'), 'unknown')
  assert.equal(costCentreKind(''), 'unknown')
  assert.equal(costCentreKind(null), 'unknown')
})

/* ------------------------------------- not Purchase by default ------ */

test('a blank cost centre is Needs Review, never Purchase', () => {
  for (const cc of ['', null, undefined, '   ']) {
    assert.equal(classifyInbound({ costCentre: cc, qty: 50 }), CHANNEL.REVIEW)
  }
})

test('a receipt with no usable quantity is Needs Review', () => {
  assert.equal(classifyInbound({ costCentre: 'SS', qty: 0 }), CHANNEL.REVIEW)
  assert.equal(classifyInbound({ costCentre: 'SS', qty: null }), CHANNEL.REVIEW)
  assert.equal(classifyInbound({ costCentre: 'SS', qty: 'abc' }), CHANNEL.REVIEW)
})

/* ------------------------------------------------------- Return IN ------- */

test('a negative receipt is Return IN', () => {
  assert.equal(classifyInbound({ costCentre: 'BBT', qty: -40 }), CHANNEL.RETURN_IN)
  assert.equal(classifyInbound({ costCentre: 'CKU/CPU', qty: -40 }), CHANNEL.RETURN_IN)
})

test('a return from the warehouse is still a return', () => {
  // The sign decides direction; the warehouse exclusion only applies to the
  // positive, Purchase branch.
  assert.equal(classifyInbound({ costCentre: 'MAIN WAREHOUSE', qty: -40 }), CHANNEL.RETURN_IN)
})

/* ------------------------------------------- naming a transfer ----------- */

test('SWISH to SWISH names BOTH ends - TRF OUT at source, TRF IN at destination', () => {
  // The worked example from the business: warehouse -> production.
  const moved = classifyTransfer({ source: 'Central Warehouse', destination: 'CKU/CPU' })
  assert.equal(moved.length, 2)
  const to = moved.find((m) => m.channel === CHANNEL.TRF_IN)
  const from = moved.find((m) => m.channel === CHANNEL.TRF_OUT)
  assert.equal(to.costCentre, 'CKU/CPU')
  assert.equal(from.costCentre, 'Central Warehouse')
  for (const m of moved) assert.equal(m.path, 'Central Warehouse → CKU/CPU')
})

test('every other pairing names ONE end', () => {
  // Only Swish -> Swish is two-ended; the rest produce a single stamp.
  assert.equal(classifyTransfer({ source: 'Central Warehouse', destination: 'BBT' }).length, 1)
  assert.equal(classifyTransfer({ source: 'BBT', destination: 'SS' }).length, 1)
  assert.equal(classifyTransfer({ source: 'Central Warehouse', destination: 'NEW SITE' }).length, 1)
})

test('brand to brand is NOT an internal transfer', () => {
  /*
   * THE CORRECTION OF 31 OCT 2026.
   *
   * This asserted the exact opposite until that date - brand to brand WAS the
   * internal transfer. Internal transfer is about Swish cost centres and has
   * nothing to do with brands.
   */
  const [moved] = classifyTransfer({ source: 'BBT', destination: 'CHP' })
  assert.equal(moved.channel, CHANNEL.BRAND_TRF)
  assert.notEqual(moved.channel, CHANNEL.TRF_IN)
  // And brand to brand is NOT two-ended either - no TRF OUT on a brand source.
  assert.equal(classifyTransfer({ source: 'BBT', destination: 'CHP' }).length, 1)
})

test('SWISH to BRAND is Issue to Store, and does NOT also stamp TRF OUT', () => {
  /*
   * Deliberate, 31 Oct 2026. Internal TRF OUT belongs to Swish -> Swish only,
   * per the business definition. Stamping it here as well would have made it
   * mean "left a Swish centre" - a different and broader claim that was
   * offered and not chosen.
   */
  const moved = classifyTransfer({ source: 'Central Warehouse', destination: 'BBT' })
  assert.equal(moved.length, 1)
  assert.equal(moved[0].costCentre, 'BBT')
  assert.equal(moved[0].channel, CHANNEL.ISSUE)
  assert.equal(moved[0].path, 'Central Warehouse → BBT')
})

test('BRAND back to SWISH is left blank', () => {
  // The user's explicit choice, 31 Oct 2026, over naming it.
  assert.equal(classifyTransfer({ source: 'BBT', destination: 'Central Warehouse' }), null)
  assert.equal(classifyTransfer({ source: 'SS', destination: 'CKU/CPU' }), null)
})

test('a transfer touching an excluded cost centre produces nothing', () => {
  assert.equal(classifyTransfer({ source: 'Central Warehouse', destination: 'HO' }), null)
  assert.equal(classifyTransfer({ source: 'LVB', destination: 'Central Warehouse' }), null)
  assert.equal(classifyTransfer({ source: 'Marketing', destination: 'BBT' }), null)
})

test('a transfer touching an unknown cost centre is surfaced, not guessed', () => {
  const [moved] = classifyTransfer({ source: 'Central Warehouse', destination: 'NEW SITE' })
  assert.equal(moved.channel, CHANNEL.REVIEW)
  assert.equal(moved.path, 'Central Warehouse → NEW SITE')
})

test('TRF OUT accompanies TRF IN and never appears without it', () => {
  /*
   * The property worth pinning, because it is what makes the slicer entry
   * redundant and somebody will eventually call that a bug. Internal TRF is
   * Swish -> Swish by definition, so the only movement producing TRF OUT also
   * produces TRF IN, onto the same article row.
   */
  for (const [source, destination] of [
    ['Central Warehouse', 'BBT'],
    ['BBT', 'SS'],
    ['BBT', 'Central Warehouse'],
    ['Central Warehouse', 'NEW SITE'],
    ['CKU/CPU', 'SWISH BAKERY'],
  ]) {
    const moved = classifyTransfer({ source, destination }) ?? []
    const channels = moved.map((m) => m.channel)
    if (channels.includes(CHANNEL.TRF_OUT)) {
      assert.ok(channels.includes(CHANNEL.TRF_IN), `${source} -> ${destination}`)
    }
  }
})

test('a movement with either end missing is not called a transfer', () => {
  assert.equal(classifyTransfer({ source: 'BBT', destination: '' }), null)
  assert.equal(classifyTransfer({ source: null, destination: 'BBT' }), null)
})

test('a cost centre moving stock to itself is not a transfer', () => {
  assert.equal(classifyTransfer({ source: 'BBT', destination: 'BBT' }), null)
  assert.equal(classifyTransfer({ source: 'bbt', destination: 'BBT' }), null)
})

/* --------------------------------------------- the column text ----------- */

test('several channels read in a fixed order, on one row', () => {
  const text = formatChannels(new Set([CHANNEL.TRF_IN, CHANNEL.DIRECT]))
  assert.equal(text, 'Purchase + Internal TRF IN')
})

test('the order does not depend on the order they were found in', () => {
  const a = formatChannels(new Set([CHANNEL.RETURN_IN, CHANNEL.ISSUE, CHANNEL.DIRECT]))
  const b = formatChannels(new Set([CHANNEL.DIRECT, CHANNEL.RETURN_IN, CHANNEL.ISSUE]))
  assert.equal(a, b)
  assert.equal(a, 'Purchase + Issue to Store + Return IN')
})

test('Needs Review drops away as soon as a real channel is known', () => {
  assert.equal(formatChannels(new Set([CHANNEL.REVIEW, CHANNEL.DIRECT])), 'Purchase')
})

test('Needs Review stands alone when nothing else is known', () => {
  assert.equal(formatChannels(new Set([CHANNEL.REVIEW])), 'Needs Review')
})

test('no channels is blank, not a label', () => {
  assert.equal(formatChannels(new Set()), null)
  assert.equal(formatChannels(null), null)
})

/* ------------------------------------------------- the slicer ------------ */

test('no selection matches everything, including rows with no channel', () => {
  assert.ok(matchesChannelFilter(null, []))
  assert.ok(matchesChannelFilter(new Set([CHANNEL.DIRECT]), []))
})

test('an article with several channels is found under EACH of them', () => {
  const held = new Set([CHANNEL.DIRECT, CHANNEL.TRF_IN])
  assert.ok(matchesChannelFilter(held, [CHANNEL.DIRECT]))
  assert.ok(matchesChannelFilter(held, [CHANNEL.TRF_IN]))
  // ...and once, not twice - this returns a boolean about the row, so it can
  // never expand it.
  assert.equal(matchesChannelFilter(held, [CHANNEL.DIRECT, CHANNEL.TRF_IN]), true)
})

test('a channel the article does not have excludes it', () => {
  assert.equal(matchesChannelFilter(new Set([CHANNEL.DIRECT]), [CHANNEL.RETURN_IN]), false)
})

test('a row with no channel is excluded once a selection is made', () => {
  assert.equal(matchesChannelFilter(null, [CHANNEL.DIRECT]), false)
  assert.equal(matchesChannelFilter(new Set(), [CHANNEL.DIRECT]), false)
})

/* ---------------------------------------- the separation from Supply ----- */

test('nothing here can reach the existing Supply labels', () => {
  // Supply is 'Warehouse' / 'Direct Supply' / 'Made In-House' and is produced
  // by withSupply from the outbound table alone.
  //
  // Until 28 Oct 2026 the two columns SHARED the string 'Direct Supply' while
  // answering different questions from different evidence - the reason this
  // one was renamed to 'Purchase'. Nothing is shared now, and this pins it.
  const all = Object.values(CHANNEL)
  assert.ok(!all.includes('Warehouse'))
  assert.ok(!all.includes('Made In-House'))
  assert.ok(!all.includes('Direct Supply'))
  assert.equal(CHANNEL.DIRECT, 'Purchase')
})

/* ------------------- column and slicer must agree exactly ---------------- */

test('the slicer filters on the same set the column prints', () => {
  // Measured 22 Oct 2026: 20 articles carry Needs Review alongside a real
  // channel over a 12-month window. The column hides the flag in that case,
  // so the slicer must not still match it - that would be a filter
  // contradicting the cell it filters.
  const held = new Set([CHANNEL.DIRECT, CHANNEL.RETURN_IN, CHANNEL.REVIEW])
  assert.equal(formatChannels(held), 'Purchase + Return IN')
  assert.equal(matchesChannelFilter(held, [CHANNEL.REVIEW]), false)
  assert.equal(matchesChannelFilter(held, [CHANNEL.DIRECT]), true)
})

test('Needs Review is still selectable when it is all there is', () => {
  const held = new Set([CHANNEL.REVIEW])
  assert.equal(formatChannels(held), 'Needs Review')
  assert.equal(matchesChannelFilter(held, [CHANNEL.REVIEW]), true)
})

/* ---------------------- latest movement only (25 Oct 2026) --------------- */

test('only the most recent movement decides the cell', () => {
  // The case that prompted the change: four weeks of ordinary activity read
  // as "Purchase + Issue to Store + Internal TRF IN" all at once.
  const held = latestChannels([
    { date: '2026-10-01', channel: CHANNEL.DIRECT },
    { date: '2026-10-11', channel: CHANNEL.ISSUE },
    { date: '2026-10-24', channel: CHANNEL.TRF_IN },
  ])
  assert.equal(formatChannels(held), 'Internal TRF IN')
})

test('order of arrival does not matter - the date does', () => {
  const held = latestChannels([
    { date: '2026-10-24', channel: CHANNEL.TRF_IN },
    { date: '2026-10-01', channel: CHANNEL.DIRECT },
  ])
  assert.equal(formatChannels(held), 'Internal TRF IN')
})

test('two movements on the same day both count', () => {
  // Nothing in the data orders two movements within one day, so picking one
  // would be inventing a fact.
  const held = latestChannels([
    { date: '2026-10-02', channel: CHANNEL.TRF_IN },
    { date: '2026-10-24', channel: CHANNEL.DIRECT },
    { date: '2026-10-24', channel: CHANNEL.ISSUE },
  ])
  assert.equal(formatChannels(held), 'Purchase + Issue to Store')
})

/* ---------------------- the Path column (31 Oct 2026) -------------------- */

test('the path comes from the same movement the channel does', () => {
  const { channels, paths } = latestMovement([
    { date: '2026-10-02', channel: CHANNEL.TRF_IN, path: 'Central Warehouse → CKU/CPU' },
    { date: '2026-10-24', channel: CHANNEL.ISSUE, path: 'Central Warehouse → BBT' },
  ])
  assert.equal(formatChannels(channels), 'Issue to Store')
  assert.equal(formatPaths(paths), 'Central Warehouse → BBT')
})

test('two paths on the same day are both kept, joined with a semicolon', () => {
  // " ; " rather than " + ", so a path can never be misread as a second
  // Transaction Type value.
  const { paths } = latestMovement([
    { date: '2026-10-24', channel: CHANNEL.ISSUE, path: 'Central Warehouse → BBT' },
    { date: '2026-10-24', channel: CHANNEL.DIRECT, path: 'Supplier → BBT' },
  ])
  assert.equal(formatPaths(paths), 'Central Warehouse → BBT ; Supplier → BBT')
})

test('the same path twice on one day is said once', () => {
  const { paths } = latestMovement([
    { date: '2026-10-24', channel: CHANNEL.ISSUE, path: 'Central Warehouse → BBT' },
    { date: '2026-10-24', channel: CHANNEL.ISSUE, path: 'Central Warehouse → BBT' },
  ])
  assert.equal(formatPaths(paths), 'Central Warehouse → BBT')
})

/* --------------------------------- paths, narrowed to the row's brand --- */

test("a row shows only its own brand's leg of a fan-out, and names the rest", () => {
  /*
   * The narrowing is unchanged; what changed on 5 Nov 2026 is that the legs
   * belonging to other brands are summarised instead of vanishing. Passing no
   * `issuedTo` here, so the other leg is reported as a movement rather than as
   * a transfer - see the two summary lines in `pathsForBrand`.
   */
  const paths = ['Central Warehouse → MM', 'Central Warehouse → TBL']
  assert.equal(
    formatPaths(pathsForBrand(paths, 'MM')),
    "Central Warehouse → MM ; Another brand's movement → TBL"
  )
  assert.equal(
    formatPaths(pathsForBrand(paths, 'TBL')),
    "Central Warehouse → TBL ; Another brand's movement → MM"
  )
})

test('a path with no brand at either end is kept for every row', () => {
  // The warehouse and the kitchens belong to no brand, so narrowing by brand
  // must not take an internal transfer or a supplier receipt off the row.
  const paths = ['Supplier → Central Warehouse', 'Central Warehouse → CKU/CPU']
  assert.deepEqual(pathsForBrand(paths, 'MM'), paths)
})

test('a store code is read as the brand above it', () => {
  assert.equal(brandOfCostCentre('MM-PLC'), 'MM')
  assert.equal(brandOfCostCentre('YELO COOP'), 'YP')
  // ...and PRINTED as it too, once the row already carries the brand.
  assert.equal(formatPaths(pathsForBrand(['Central Warehouse → YP-DFC'], 'YP')),
    'Central Warehouse → YP')
})

test("one brand's store-level legs collapse to one leg per source", () => {
  // The row that prompted this: four legs, every one of them YP's.
  const paths = [
    'CKU/CPU → YP',
    'CKU/CPU → YP-PLC',
    'CKU/CPU → YP-DFC',
    'Yelo Al Salam Mall → YP',
  ]
  assert.equal(
    formatPaths(pathsForBrand(paths, 'YP')),
    'CKU/CPU → YP ; Yelo Al Salam Mall → YP'
  )
})

test('the source end is never collapsed', () => {
  // "Yelo Al Salam Mall → YP" is the only evidence for the Brand Transfer the
  // Transaction Type column names, so it must not fold away into "YP → YP".
  assert.deepEqual(pathsForBrand(['Yelo Al Salam Mall → YP'], 'YP'), [
    'Yelo Al Salam Mall → YP',
  ])
})

test("FM-JHR is FM's, so an FM row keeps both of its own legs", () => {
  // The brand column calls both of them FM. Dropping the Johor leg would hide
  // a destination that belongs to the very brand on the row.
  const paths = ['CKU/CPU → FM', 'CKU/CPU → FM-JHR']
  assert.equal(brandOfCostCentre('FM-JHR'), 'FM')
  // Both are FM's and both come from the kitchen, so they are one leg.
  assert.equal(formatPaths(pathsForBrand(paths, 'FM')), 'CKU/CPU → FM')
  // ...and it is still not PAT's. PAT is told whose it is rather than nothing,
  // and told it ONCE, because FM-JHR resolves to FM like the other leg.
  assert.equal(
    formatPaths(pathsForBrand(paths, 'PAT')),
    "Another brand's movement → FM"
  )
})

test('a row with no brand keeps every path', () => {
  // The component view merges brands, so there is no row-level brand for a
  // destination to disagree with.
  const paths = ['Central Warehouse → MM', 'Central Warehouse → TBL']
  assert.deepEqual(pathsForBrand(paths, ''), paths)
  assert.deepEqual(pathsForBrand(paths, null), paths)
})

test("another brand's leg is never printed as though it were this row's", () => {
  /*
   * The original rule, and still the point: an MM row must never read
   * "Central Warehouse → TBL", which looks like MM received it. It used to go
   * blank; from 5 Nov 2026 it says whose leg it was instead, which is the same
   * protection with the missing-data look removed.
   */
  const out = formatPaths(pathsForBrand(['Central Warehouse → TBL'], 'MM'))
  assert.equal(out, "Another brand's movement → TBL")
  assert.ok(!out.includes('Central Warehouse → TBL'))
})

/* ------------------------------------------- Transfer Status ----------- */

test('a Swish issue to the row\'s own brand is a Direct Transfer', () => {
  assert.equal(
    transferStatus({ article: '106400606', issuedTo: new Set(['MM']), moved: true }),
    TRANSFER_STATUS.DIRECT
  )
})

test('an issue to a DIFFERENT brand is ALSO a Direct Transfer', () => {
  /*
   * The 5 Nov 2026 change, and the reason for it. Under the old rule this read
   * No on every brand row but PAT's and TBL's - and 514 of 586 CK/CPU articles
   * reach exactly one brand, so the column said No about articles that
   * demonstrably transfer out. Which brands is now the Path column's job.
   */
  assert.equal(
    transferStatus({ article: '106400606', issuedTo: new Set(['PAT', 'TBL']), moved: true }),
    TRANSFER_STATUS.DIRECT
  )
})

test('a store code still counts as a brand', () => {
  assert.equal(
    transferStatus({ article: '1', issuedTo: new Set(['YP-DFC']), moved: true }),
    TRANSFER_STATUS.DIRECT
  )
})

test('Swish-to-Swish only is No Direct Transfer - it MOVED, just not to a brand', () => {
  assert.equal(
    transferStatus({ article: '1', issuedTo: new Set(), moved: true }),
    TRANSFER_STATUS.NONE
  )
})

test('no movement at all is No Movement, NOT No Direct Transfer', () => {
  /*
   * Split out on 5 Nov 2026. These two used to share a label, which asserted a
   * negative from an absence of evidence - 208 of 901 CK/CPU articles have no
   * movement row at all in October and every one was being reported as a
   * finding about transfers.
   *
   * An article the model never saw is simply absent from the map, so the caller
   * passes `moved: false` and `issuedTo` undefined.
   */
  assert.equal(
    transferStatus({ article: '1', issuedTo: undefined, moved: false }),
    TRANSFER_STATUS.NO_MOVEMENT
  )
  // `moved` defaults to false, so a caller that forgets it cannot accidentally
  // publish a No.
  assert.equal(transferStatus({ article: '1' }), TRANSFER_STATUS.NO_MOVEMENT)
})

test('a prep step is Not traceable, never a No', () => {
  // No article number in any of the nine models, so nothing was looked up.
  assert.equal(
    transferStatus({ article: '', issuedTo: undefined, moved: false }),
    TRANSFER_STATUS.UNTRACEABLE
  )
  assert.equal(
    transferStatus({ article: null, issuedTo: new Set(['BBT']), moved: true }),
    TRANSFER_STATUS.UNTRACEABLE
  )
})

test('an unreachable model leaves the column blank, and a brandless row does not', () => {
  // An unreachable warehouse model is not evidence of absence.
  assert.equal(
    transferStatus({ article: '1', issuedTo: undefined, moved: false, known: false }),
    null
  )
  /*
   * An `__unattributed` row - one that reached no brand - now gets a real
   * answer. The question is about the ARTICLE, so having no brand on the row no
   * longer makes it unanswerable, which is what used to blank these.
   */
  assert.equal(
    transferStatus({ article: '1', issuedTo: new Set(['BBT']), moved: true }),
    TRANSFER_STATUS.DIRECT
  )
})

/* --------------------------------- Path: the other brands get named ---- */

test('a leg to another brand is summarised rather than dropped', () => {
  // Scenario B in the 5 Nov 2026 brief: nothing of this row's own to show, so
  // the cell used to be blank beside a Transaction Type reading Issue to Store.
  assert.deepEqual(
    pathsForBrand(['CKU/CPU → PAT'], 'MM', new Set(['PAT'])),
    ['Transferred to a different brand → PAT']
  )
})

test('several other brands are listed once each, in order', () => {
  assert.deepEqual(
    pathsForBrand(['CKU/CPU → PAT'], 'MM', new Set(['TBL', 'PAT', 'TBL'])),
    ['Transferred to different brands → PAT, TBL']
  )
})

test('store codes collapse to their brand and do not repeat it', () => {
  assert.deepEqual(
    pathsForBrand([], 'MM', new Set(['YP-DFC', 'YP', 'YP-PLC'])),
    ['Transferred to a different brand → YP']
  )
})

test('this row\'s own leg is kept, with the others named beside it', () => {
  // "Preserve the actual transfer path wherever it is available" - Scenario A
  // and B together on one row.
  assert.deepEqual(
    pathsForBrand(['CKU/CPU → MM', 'CKU/CPU → PAT'], 'MM', new Set(['MM', 'PAT'])),
    ['CKU/CPU → MM', 'Transferred to a different brand → PAT']
  )
})

test('reaching only this row\'s brand adds no summary line', () => {
  assert.deepEqual(
    pathsForBrand(['CKU/CPU → MM'], 'MM', new Set(['MM'])),
    ['CKU/CPU → MM']
  )
})

test('a Swish-to-Swish leg is untouched and earns no summary', () => {
  assert.deepEqual(
    pathsForBrand(['CKU/CPU → SWISH BAKERY'], 'BBT', new Set()),
    ['CKU/CPU → SWISH BAKERY']
  )
})

test('a dropped leg that was NOT a transfer is named, but not called one', () => {
  /*
   * 475 of 16,290 brand rows, measured 5 Nov 2026: a supplier delivering into
   * another brand. `issuedTo` is empty because that is not an Issue to Store,
   * so the transfer line cannot cover it - and calling a purchase a transfer
   * would be false.
   */
  assert.deepEqual(
    pathsForBrand(['Supplier → FM'], 'BBT', new Set()),
    ["Another brand's movement → FM"]
  )
  // A brand-to-brand transfer between two OTHER brands, same treatment.
  assert.deepEqual(
    pathsForBrand(['MM → MM-PLC'], 'BBT', new Set()),
    ["Another brand's movement → MM"]
  )
})

test('a brand named as a transfer is not repeated as a stray leg', () => {
  assert.deepEqual(
    pathsForBrand(['CKU/CPU → PAT'], 'MM', new Set(['PAT'])),
    ['Transferred to a different brand → PAT']
  )
})

test('both lines can appear, each naming its own brands', () => {
  assert.deepEqual(
    pathsForBrand(['CKU/CPU → PAT', 'Supplier → FM'], 'MM', new Set(['PAT'])),
    ['Transferred to a different brand → PAT', "Another brand's movement → FM"]
  )
})

test('a path belonging to a dropped Needs Review does not survive it', () => {
  // Needs Review falls away once a real channel is known, and its path must
  // fall with it - otherwise the Path column describes a movement the
  // Transaction Type column no longer mentions.
  const { channels, paths } = latestMovement([
    { date: '2026-10-24', channel: CHANNEL.REVIEW, path: 'Central Warehouse → NEW SITE' },
    { date: '2026-10-24', channel: CHANNEL.ISSUE, path: 'Central Warehouse → BBT' },
  ])
  assert.equal(formatChannels(channels), 'Issue to Store')
  assert.equal(formatPaths(paths), 'Central Warehouse → BBT')
})

test('no path at all is null, not an empty string', () => {
  assert.equal(formatPaths([]), null)
  assert.equal(formatPaths(null), null)
  assert.equal(formatPaths([null, '']), null)
})

test('a later real movement outranks an earlier Needs Review', () => {
  const held = latestChannels([
    { date: '2026-10-20', channel: CHANNEL.REVIEW },
    { date: '2026-10-21', channel: CHANNEL.TRF_IN },
  ])
  assert.equal(formatChannels(held), 'Internal TRF IN')
})

test('dates compare as ISO strings across a month boundary', () => {
  const held = latestChannels([
    { date: '2026-09-30', channel: CHANNEL.DIRECT },
    { date: '2026-10-01', channel: CHANNEL.TRF_IN },
  ])
  assert.equal(formatChannels(held), 'Internal TRF IN')
})

test('an undated or channel-less event is ignored, not crashed on', () => {
  const held = latestChannels([
    { date: null, channel: CHANNEL.DIRECT },
    { date: '2026-10-05', channel: null },
    { date: '2026-10-04', channel: CHANNEL.TRF_IN },
  ])
  assert.equal(formatChannels(held), 'Internal TRF IN')
  assert.equal(formatChannels(latestChannels([])), null)
  assert.equal(formatChannels(latestChannels(null)), null)
})
