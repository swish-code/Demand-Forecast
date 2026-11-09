/**
 * HOW an article reached a cost centre, per movement.
 *
 * CORRECTED 31 Oct 2026. The previous version had "internal transfer" the wrong
 * way round: it stamped Internal TRF on movements between BRAND cost centres,
 * because the only thing narrowing the data was a brand-code scope. The
 * business means the opposite - an internal transfer is a movement between two
 * SWISH cost centres, which is where the brands are not.
 *
 * TWO KINDS OF COST CENTRE
 *
 *   BRAND  the nine forecast brands, plus FM / FM-JHR and the store-level
 *          codes underneath them. These are the selling end.
 *   SWISH  the facilities - the warehouse, CKU/CPU, Swish Bakery, Yelo
 *          Factory, R&D. These are the supplying end.
 *
 * A third group is EXCLUDED outright at the user's instruction (31 Oct 2026):
 * HO, Marketing, Merchandise, LVB and SM are neither, and movements touching
 * them produce no transaction type at all.
 *
 * THE VALUES
 *
 *   Purchase         an external supplier delivered into any cost centre
 *                    except the Main Warehouse
 *   Internal TRF IN  a Swish cost centre received from another Swish cost
 *                    centre (warehouse -> production)
 *   Issue to Store   a Swish cost centre sent stock out to a brand or store
 *   Brand Transfer   one brand sent stock to another brand
 *   Return IN        a cost centre sent goods BACK to an external supplier -
 *                    the reverse of a receipt, which is why it is found in the
 *                    inbound table as a negative quantity
 *
 * Two flows deliberately produce NOTHING, both by the user's explicit choice:
 * a supplier delivery into the Main Warehouse, and a brand sending stock back
 * to a Swish cost centre.
 *
 * THE DESTINATION END ONLY
 *
 * A movement has two ends, and the column has ONE ROW PER ARTICLE with no cost
 * centre on it. Stamping both ends therefore put both halves of the same
 * movement on the same row: measured 1-28 Oct 2026, 654 of 1,807 articles read
 * "Internal TRF IN + Internal TRF OUT", which is 36% of the column saying
 * nothing. So only the RECEIVING end is stamped (31 Oct 2026) and the source is
 * carried separately in the Path column, where it has room to be named.
 *
 * That is why there is no `Internal TRF OUT` value any more. It could never be
 * produced, and a slicer entry that always returns nothing is worse than none.
 *
 * WHY THIS IS NOT THE EXISTING `Supply` COLUMN
 *
 * `Supply` (api.js `withSupply`) answers a different question and is left
 * exactly as it was. It asks "has the Central Warehouse ever issued this
 * article", is a per-article global fact with no time window, and reads the
 * OUTBOUND table only. It calls everything else "Direct Supply", which is a
 * label by elimination rather than evidence of a supplier delivery.
 */

export const CHANNEL = {
  /*
   * "Purchase", not "Direct Supply" - renamed 28 Oct 2026.
   *
   * The Supply column beside this one has its OWN value called Direct Supply,
   * meaning "the warehouse has not issued this article in six months". It is a
   * different question answered from different evidence, and two columns
   * showing the same words for different things was the confusion to remove.
   * That column is untouched; it keeps its own wording in `SUPPLY_DIRECT`.
   */
  DIRECT: 'Purchase',
  TRF_IN: 'Internal TRF IN',
  /*
   * RESTORED 31 Oct 2026, on request, having been removed earlier the same day.
   *
   * Be aware of what it does and does not tell you. An internal transfer is
   * Swish -> Swish, and BOTH ends of that movement land on the SAME article row,
   * because the row is one per article with no cost centre on it. So TRF OUT
   * appears on exactly the rows that already say TRF IN - measured 1-28 Oct
   * 2026, all 375 of them, and on no other row. Ticking it in the slicer returns
   * the same articles as ticking Internal TRF IN.
   *
   * It is here because the business vocabulary has both words and the user
   * asked for both. The Path column is what actually distinguishes direction.
   */
  TRF_OUT: 'Internal TRF OUT',
  ISSUE: 'Issue to Store',
  BRAND_TRF: 'Brand Transfer',
  RETURN_IN: 'Return IN',
  REVIEW: 'Needs Review',
}

/** Display order, so two rows with the same channels read identically. */
export const CHANNEL_ORDER = [
  CHANNEL.DIRECT,
  CHANNEL.TRF_IN,
  CHANNEL.TRF_OUT,
  CHANNEL.ISSUE,
  CHANNEL.BRAND_TRF,
  CHANNEL.RETURN_IN,
  CHANNEL.REVIEW,
]

const norm = (v) => String(v ?? '').trim()
const key = (v) => norm(v).toLowerCase()

/**
 * The warehouse, under both names it goes by.
 *
 * `fact_po_period_lifecycle[Cost Center]` calls it "MAIN WAREHOUSE";
 * `fact_outbound_line[Mapped Cost Center/Store]` calls it "Central Warehouse".
 * Measured 22 Oct 2026, those are the two spellings in use and they are the
 * same place. Matched case-insensitively so a change of case upstream cannot
 * silently turn the warehouse into an ordinary cost centre - which would make
 * every warehouse receipt look like a direct supplier delivery.
 */
const WAREHOUSE_NAMES = new Set(['main warehouse', 'central warehouse'])

export const isWarehouse = (costCentre) => WAREHOUSE_NAMES.has(key(costCentre))

/**
 * A cost centre's name as the Path column should print it.
 *
 * Only one name is adjusted. The warehouse arrives spelled "MAIN WAREHOUSE"
 * from the inbound table and "Central Warehouse" from the outbound one, and the
 * Path column is the first place both spellings sit in the same column - a
 * reader would reasonably take them for two different places. Settled on
 * "Central Warehouse", which is the spelling behind the large majority of
 * paths. Everything else is printed exactly as the model holds it.
 */
export const pathLabel = (costCentre) =>
  isWarehouse(costCentre) ? 'Central Warehouse' : norm(costCentre)

/*
 * The cost centre lists, enumerated rather than inferred.
 *
 * Every value measured 31 Oct 2026 across `fact_po_period_lifecycle[Cost
 * Center]` (18 values), `fact_outbound_line[Mapped Cost Center/Store]` (24) and
 * `fact_outbound_line[Mapped Transfer To]` (26) appears in exactly one of these
 * three sets, verified by a dry run that found no unclassified value.
 *
 * Written out in full, rather than "Swish is anything that is not a brand",
 * because the EXCLUDED group breaks that complement - and because a list a
 * person can read and check by eye is the point.
 */
const BRAND_COST_CENTRES = new Set(
  [
    // The nine forecast brands.
    'BBT', 'SS', 'MM', 'PAT', 'YP', 'SLC', 'BUR', 'CHP', 'TBL',
    /*
     * FM is a separate company the forecast does not cover, and FM-JHR sits
     * under it. They are still the SELLING end of a movement, so for this
     * column they belong with the brands - corrected 31 Oct 2026, having been
     * treated as facilities in the earlier investigation.
     */
    'FM', 'FM-JHR',
    // Store-level codes underneath the brands above.
    'YP-Salam Mall', 'YP-DFC', 'YP-PLC', 'MM-PLC',
    'Yelo Al Salam Mall', 'YELO COOP', 'LB COOP',
  ].map(key)
)

/*
 * R&D was here until 1 Nov 2026, and is now excluded at the user's instruction.
 *
 * It is a development kitchen rather than a supplying one: stock reaching it is
 * being trialled, not produced for sale, so a movement into R&D is not the same
 * event as a movement into the Central Kitchen and should not read as one.
 */
const SWISH_COST_CENTRES = new Set(
  ['MAIN WAREHOUSE', 'Central Warehouse', 'CKU/CPU', 'SWISH BAKERY', 'YELO FACTORY'].map(key)
)

/*
 * Neither brand nor Swish - "dont consider them", 31 Oct 2026.
 *
 * HO, Marketing and Merchandise are internal departments rather than places
 * stock is sold or produced. LVB is "Love bird", which recipeBrands.js already
 * documents as a cost centre sitting BESIDE the nine forecast brands rather
 * than inside any of them. SM is 18 lines in total.
 *
 * R&D joined them on 1 Nov 2026 - see the note on SWISH_COST_CENTRES above.
 */
const EXCLUDED_COST_CENTRES = new Set(
  ['HO', 'Marketing', 'Merchandise', 'LVB', 'SM', 'R&D'].map(key)
)

/**
 * Which kind of cost centre is this?
 *
 * Returns 'brand', 'swish', 'excluded', or 'unknown'.
 *
 * An unrecognised value is 'unknown' rather than quietly falling into 'swish'.
 * Nothing in the data is unknown today; something that appears later is a new
 * site or a renamed one, and the honest answer is to surface it as Needs Review
 * rather than to guess a side - guessing wrong would silently relabel every
 * movement into that centre.
 */
export function costCentreKind(costCentre) {
  const k = key(costCentre)
  if (!k) return 'unknown'
  if (EXCLUDED_COST_CENTRES.has(k)) return 'excluded'
  if (BRAND_COST_CENTRES.has(k)) return 'brand'
  if (SWISH_COST_CENTRES.has(k)) return 'swish'
  return 'unknown'
}

/**
 * One inbound receipt's channel.
 *
 * `costCentre` is the receiving cost centre, already resolved from the
 * receiving location - see `warehouseToCostCentre` in powerbi/orderingChannel.js.
 * It is the ROLLED-UP value from `fact_po_period_lifecycle[Cost Center]`, not
 * the shop-level `Warehouse`, because the business rule is stated in those
 * terms.
 *
 * Returns null where the receipt is real but belongs to no brand channel - a
 * delivery into the warehouse itself, which is the ordinary purchasing flow and
 * is explicitly NOT a Purchase.
 */
export function classifyInbound({ costCentre, qty }) {
  const cc = norm(costCentre)
  const n = Number(qty)

  /*
   * No resolvable cost centre is not a direct supply.
   *
   * Stated as a rule because the opposite is the easy mistake: an unmatched
   * receipt has a supplier on it and no warehouse, which looks exactly like a
   * direct delivery until you notice nothing identified where it went.
   */
  if (!cc) return CHANNEL.REVIEW

  /*
   * An excluded cost centre produces nothing at all, before anything else is
   * considered - not even Return IN. "Dont consider them" is a decision about
   * the cost centre, not about the direction of one movement.
   */
  const kind = costCentreKind(cc)
  if (kind === 'excluded') return null

  /*
   * An unrecognised cost centre is surfaced, not called a Purchase.
   *
   * Same reasoning as the transfer side, and the same reasoning the caller
   * already applies to an unmapped receiving LOCATION: an unmatched receipt has
   * a supplier on it and no warehouse, which looks exactly like a direct
   * delivery until you notice nothing identified where it went. All 18 cost
   * centres in the data are classified today, so this only fires on something
   * new upstream - which is precisely when a silent guess would be worst.
   */
  if (kind === 'unknown') return CHANNEL.REVIEW

  if (!Number.isFinite(n) || n === 0) return CHANNEL.REVIEW

  /*
   * A negative receipt is goods going back to the supplier.
   *
   * Measured 21 Oct 2026: 1,480 negative GRN lines, -64,790,509 units, and
   * ZERO negative lines anywhere in the outbound table. So the sign is the only
   * direction evidence the data carries, and a return is only ever RECORDED in
   * the inbound table even though the goods travel outwards. The warehouse
   * returns stock too, and that is still a return.
   */
  if (n < 0) return CHANNEL.RETURN_IN

  /*
   * A delivery into the warehouse is ordinary purchasing, not a Purchase.
   *
   * Left as a blank cell rather than given a name of its own, at the user's
   * explicit choice on 31 Oct 2026 when offered a "Warehouse Receipt" value.
   */
  if (isWarehouse(cc)) return null

  /*
   * Everything else is a Purchase, brands included.
   *
   * Confirmed 31 Oct 2026: "all cost centres except the warehouse" covers brand
   * cost centres too, so a supplier delivering straight into BBT reads Purchase.
   * That is the warehouse-bypassing flow this column exists to surface.
   */
  return CHANNEL.DIRECT
}

/**
 * One outbound movement, as the stamps it produces.
 *
 * Returns an ARRAY of `{ costCentre, channel, path }`, or null where the
 * movement produces no transaction type at all. An array because a Swish ->
 * Swish move names BOTH of its ends - Internal TRF OUT at the source and
 * Internal TRF IN at the destination - while every other pairing names one.
 *
 * The four pairings, per the business definitions of 31 Oct 2026:
 *
 *   swish -> swish   Internal TRF OUT at source, Internal TRF IN at destination
 *   swish -> brand   Issue to Store    warehouse -> BBT
 *   brand -> brand   Brand Transfer    BBT -> SS
 *   brand -> swish   (nothing)         BBT -> warehouse, left blank by choice
 *
 * WHAT THE TWO-ENDED CASE COSTS, STATED PLAINLY
 *
 * The caller holds one row per article and no cost centre, so both stamps from
 * one movement land on the same row and it reads "Internal TRF IN + Internal
 * TRF OUT". That is one movement said twice rather than two facts, and it is
 * why the Path column exists beside it. Restored on request after being
 * removed earlier the same day; see CHANNEL.TRF_OUT above.
 */
export function classifyTransfer({ source, destination }) {
  const from = norm(source)
  const to = norm(destination)
  // A movement with one end missing cannot be placed on either side of the
  // brand/Swish line, and the rule says not to name it without that evidence.
  if (!from || !to) return null
  // A cost centre moving stock to itself is a correction or a re-bin, not a
  // transfer between two cost centres.
  if (key(from) === key(to)) return null

  const fromKind = costCentreKind(from)
  const toKind = costCentreKind(to)

  // Either end excluded means the whole movement is not considered.
  if (fromKind === 'excluded' || toKind === 'excluded') return null

  const path = `${pathLabel(from)} → ${pathLabel(to)}`
  // A new or renamed cost centre is surfaced, not guessed onto a side.
  if (fromKind === 'unknown' || toKind === 'unknown') {
    return [{ costCentre: to, channel: CHANNEL.REVIEW, path }]
  }

  if (fromKind === 'swish' && toKind === 'swish') {
    // The only two-ended case. Destination first, so a reader meeting the row
    // sees where the goods ARE before where they came from.
    return [
      { costCentre: to, channel: CHANNEL.TRF_IN, path },
      { costCentre: from, channel: CHANNEL.TRF_OUT, path },
    ]
  }
  if (fromKind === 'swish' && toKind === 'brand') {
    return [{ costCentre: to, channel: CHANNEL.ISSUE, path }]
  }
  if (fromKind === 'brand' && toKind === 'brand') {
    return [{ costCentre: to, channel: CHANNEL.BRAND_TRF, path }]
  }
  // brand -> swish. Left blank at the user's explicit choice, 31 Oct 2026.
  return null
}

/**
 * The channels of the article's LATEST movement, and nothing earlier.
 *
 * Changed 25 Oct 2026 at the user's instruction: the column answers "how is
 * this article moving now", so a receipt three weeks ago is not an answer.
 * Before this it carried every channel seen in the window, which read as
 * "Purchase + Internal TRF IN + Internal TRF OUT" on an article with four
 * weeks of ordinary activity behind it.
 *
 * `events` is [{ date, channel }] - one entry per movement that produced a
 * channel for a cost centre in scope. The date is compared as an ISO string,
 * which sorts correctly without parsing.
 *
 * Several channels on the SAME day are all kept. Nothing in the data says
 * which of two movements on one date came first, so picking one would be
 * inventing a fact; two true statements are better than one guessed one.
 */
export function latestMovement(events) {
  let latest = null
  let held = []
  for (const e of events ?? []) {
    const date = e?.date
    const channel = e?.channel
    if (!date || !channel) continue
    if (latest === null || date > latest) {
      latest = date
      held = [e]
    } else if (date === latest) {
      held.push(e)
    }
  }
  const channels = new Set(held.map((e) => e.channel))
  /*
   * Paths are kept only for the channels that survive `effectiveChannels`, so a
   * Needs Review dropped from the column cannot leave its path behind in the
   * one beside it. Deduplicated because two movements on the same day between
   * the same pair of cost centres are one path, said twice.
   */
  const kept = effectiveChannels(channels)
  const paths = [...new Set(held.filter((e) => e.path && kept.has(e.channel)).map((e) => e.path))]
  return { channels, paths }
}

/** The channel half alone - the shape this had before the Path column. */
export function latestChannels(events) {
  return latestMovement(events).channels
}

/*
 * Store-level cost centres, and the brand each one sits under.
 *
 * Only the codes that are not already their own brand need naming here; every
 * other brand cost centre IS the brand code, so it needs no translation. Yelo
 * is YP - see recipeBrands.js, where YP's recipe groups are the Yelo Pizza
 * ones. "LB COOP" is deliberately absent: it is a brand-side cost centre whose
 * owner none of the nine forecast brands can be shown to be, and inventing one
 * would attribute its movements to a brand that never made them.
 */
const BRAND_OF_COST_CENTRE = new Map(
  Object.entries({
    'YP-Salam Mall': 'YP',
    'YP-DFC': 'YP',
    'YP-PLC': 'YP',
    'Yelo Al Salam Mall': 'YP',
    'YELO COOP': 'YP',
    'MM-PLC': 'MM',
    /*
     * FM-JHR sits under FM - the same note as on BRAND_COST_CENTRES above, read
     * the other way round. The brand column calls both of them "FM", so without
     * this an FM row's own Johor leg looks like another brand's business.
     * Measured 2 Nov 2026 over 1-31 Oct: 83 PA articles went to FM and FM-JHR
     * and to nothing else, which is most of what the Production and Swish
     * Bakery pages show two legs for.
     */
    'FM-JHR': 'FM',
  }).map(([k, v]) => [key(k), v])
)

/**
 * The brand a cost centre belongs to, or null where it is not a brand at all.
 *
 * Null is the answer for the warehouse, the kitchens and "Supplier" - they are
 * ends of a path that belong to no brand, which is why `pathsForBrand` keeps
 * them for every row rather than treating them as another brand's business.
 */
export function brandOfCostCentre(costCentre) {
  const k = key(costCentre)
  if (!k) return null
  if (BRAND_OF_COST_CENTRE.has(k)) return BRAND_OF_COST_CENTRE.get(k)
  return costCentreKind(costCentre) === 'brand' ? norm(costCentre) : null
}

/**
 * The paths that belong to the brand the ROW is already shown under.
 *
 * A warehouse issue fans out to whichever brands asked for the article that
 * day, so one article's latest movement can legitimately name several. The
 * table, though, has already split that article into a row per brand - so on
 * the MM row, "Central Warehouse → TBL" is another row's fact, and printing it
 * reads as MM having received it.
 *
 * Kept: every path whose destination is not a brand (Supplier → Central
 * Warehouse, Central Warehouse → CKU/CPU), and the brand destinations that are
 * this row's own brand. Dropped: the other brands'.
 *
 * With no brand on the row - the component view, where brands are merged - the
 * list is returned untouched, because there is no row-level brand for a
 * destination to disagree with.
 *
 * The column can come out blank where Transaction Type does not: an article
 * whose latest movement went only to TBL has nothing to say on the MM row.
 * That is the honest reading rather than a gap.
 *
 * THE DESTINATION IS THEN NAMED AS THE BRAND - 2 Nov 2026.
 *
 * Surviving the filter was not enough to read as one answer. A YP row printed
 * "CKU/CPU → YP ; CKU/CPU → YP-PLC ; CKU/CPU → YP-DFC ; Yelo Al Salam Mall →
 * YP" - four legs, every one of them YP's, which reads as four destinations
 * rather than as the store-level detail of one. The destination is rewritten to
 * the brand above it and the list de-duplicated, so that row now says
 * "CKU/CPU → YP ; Yelo Al Salam Mall → YP": one leg per SOURCE.
 *
 * The source end is deliberately left alone. Collapsing it too would turn
 * "Yelo Al Salam Mall → YP" into "YP → YP" and then into nothing, and that leg
 * is the only evidence for the Brand Transfer the column beside it names - a
 * channel with no path under it is worse than a path with two lines.
 *
 * THE OTHER BRANDS ARE NOW NAMED RATHER THAN HIDDEN - 5 NOV 2026.
 *
 * Dropping them left the cell blank beside a Transaction Type reading "Issue to
 * Store", which reads as missing data rather than as "this leg belongs to
 * another row". Measured over 1-30 Oct: of the 586 CK/CPU articles that did
 * reach a brand, 514 reached exactly one - so on eight of nine brand rows the
 * only leg there was got filtered away.
 *
 * So the legs still go, and one summary line takes their place, naming the
 * distinct brands this article actually reached. Any real leg for THIS row is
 * kept beside it, so the cell never loses a path it could have shown.
 *
 * `issuedTo` is the source of truth for that summary, not `paths`. The paths
 * describe the LATEST movement only, while `issuedTo` is the whole window - an
 * article issued to PAT on the 3rd and moved to the bakery on the 28th has no
 * brand leg left in `paths`, and the reader still needs to be told about PAT.
 */
/**
 * What a row says when nothing reached its OWN brand.
 *
 * NAMES ONLY THIS BRAND, DELIBERATELY - 8 Nov 2026, on request.
 *
 * Until now these rows listed the brands the article DID reach:
 * "Transferred to different brands → BUR, CHP, FM, MM, SLC, SS" on a TBL row.
 * That was asked for on 5 Nov so the hidden legs were not simply dropped, and
 * it is correct - but it reads as a statement about TBL and is a statement
 * about six other brands, which is not what a reader scanning the TBL page
 * wants to know.
 *
 * Blanking those rows instead was measured first and is much worse: only
 * 32.6% of brand rows have a leg of their own, so 10,974 of 16,317 rows -
 * 67.4% - would have emptied this column. One short line that names the row's
 * own brand and nothing else keeps the answer honest at 0.2% blank.
 */
const noLegLine = (brand) => `Not transferred to ${brand}`

/** Distinct brand names from `values`, excluding `want`, in name order. */
function otherBrands(values, want, exclude = new Set()) {
  // Keyed case-insensitively so "YP-DFC" and "YP" cannot both be listed, and
  // so a store code is named by the brand above it rather than by itself.
  const out = new Map()
  for (const got of values ?? []) {
    const owner = norm(brandOfCostCentre(got) ?? got)
    if (!owner) continue
    const k = key(owner)
    if (k === want || out.has(k) || exclude.has(k)) continue
    out.set(k, owner)
  }
  return [...out.values()].sort()
}

export function pathsForBrand(paths, brand, issuedTo) {
  const want = key(brand)
  const list = (paths ?? []).filter(Boolean)
  if (!want) return list
  const seen = new Set()
  const kept = []
  const droppedTo = []
  for (const p of list) {
    const text = String(p)
    const at = text.lastIndexOf('→')
    const owner = brandOfCostCentre(at < 0 ? text : text.slice(at + 1))
    if (owner !== null && key(owner) !== want) {
      droppedTo.push(owner)
      continue
    }
    // A store code says the brand's name once the row already carries it.
    const line = owner === null || at < 0 ? text : `${text.slice(0, at).trimEnd()} → ${owner}`
    if (seen.has(line)) continue
    seen.add(line)
    kept.push(line)
  }

  /*
   * Did anything actually reach THIS brand?
   *
   * `kept` can hold legs that end at a Swish cost centre - "Supplier → CKU/CPU"
   * - which belong to nobody's brand and are shown on every row. They are not
   * evidence that this brand received anything, so the note is decided on
   * whether a leg ends at the brand itself, not on whether `kept` is empty.
   */
  const reachedThisBrand = list.some((p) => {
    const text = String(p)
    const at = text.lastIndexOf('→')
    const owner = brandOfCostCentre(at < 0 ? text : text.slice(at + 1))
    return owner !== null && key(owner) === want
  })

  /*
   * One line about this brand, where something moved and none of it came here.
   *
   * `issuedTo` is consulted as well as the dropped legs because the two answer
   * different questions - it holds every Swish -> brand issue in the window,
   * while `droppedTo` holds only the latest movement's legs. Either is reason
   * enough to say the article moved and did not reach this brand.
   */
  const movedElsewhere = droppedTo.length > 0 || otherBrands(issuedTo, want).length > 0
  if (!reachedThisBrand && movedElsewhere) kept.push(noLegLine(brand))

  return kept
}

/**
 * Was this article transferred straight from a Swish site to ANY brand?
 *
 * ANY BRAND, FROM 5 NOV 2026. Until then the question was "did it reach the
 * brand on THIS ROW", and that turned out to answer No far more often than the
 * business meant. Measured over 1-30 Oct: 586 CK/CPU articles did transfer
 * directly to a brand, but 514 of them reached exactly one - so of the 5,274
 * brand rows those articles occupy, only 731 could say Direct Transfer. The
 * other 86% read No about an article that demonstrably does transfer out.
 *
 * The rule is now a property of the ARTICLE, not of the article-and-brand pair,
 * so every brand row for an article agrees. Where that article actually went is
 * the Path column's job - see `pathsForBrand`, which names the other brands
 * rather than leaving the cell blank.
 *
 * `issuedTo` is the set of brands that received this article from a Swish cost
 * centre ANYWHERE in the window, which is what `channelsForWindow` accumulates
 * off the transfer rows it already reads. A direct transfer is exactly the
 * `Issue to Store` channel - Swish -> brand - so this and the Transaction Type
 * column are one test rather than two definitions of the same idea. The
 * Central Warehouse is a Swish cost centre, so the ordinary Stock Article flow
 * of warehouse -> brand qualifies exactly as the kitchens' do.
 *
 * FOUR ANSWERS, and the last two are the ones that are easy to merge wrongly:
 *
 *   Direct Transfer      at least one Swish -> brand movement, any brand
 *   No Direct Transfer   the article MOVED, and none of it was Swish -> brand.
 *                        Swish-to-Swish only, typically CKU/CPU -> SWISH BAKERY
 *   No Movement          no movement record at all in the window
 *   Not traceable        there is no article number to look anything up by
 *
 * NO MOVEMENT IS NOT A NO - split out on 5 Nov 2026. It used to fall through to
 * No Direct Transfer, which asserted a negative from an absence of evidence:
 * 208 of 901 CK/CPU articles have no movement row at all in October, and the
 * column was reporting all of them as a finding about transfers. "Nothing
 * shipped here" and "this came out at nought" are different answers, and only
 * the second is a No.
 *
 * NOT TRACEABLE IS NOT A SOFTER "NO" EITHER - it is the absence of a KEY. A prep
 * step carries no ERP article number in any of the nine models (45,312 of
 * 45,312 rows blank, measured 3 Nov 2026) and its name matches a warehouse
 * article in 3 of 978 cases. So nothing in the movement data can be joined to
 * it. Calling that "No Direct Transfer" would publish 978 findings nobody
 * looked up.
 */
export const TRANSFER_STATUS = {
  DIRECT: 'Direct Transfer',
  NONE: 'No Direct Transfer',
  NO_MOVEMENT: 'No Movement',
  UNTRACEABLE: 'Not traceable',
}

/**
 * @param {object}  args
 * @param {string}  args.article   the ERP article number, blank on a prep step
 * @param {Set}     args.issuedTo  brands this article reached from a Swish site
 * @param {boolean} args.moved     does the model hold ANY movement for it
 * @param {boolean} args.known     did the warehouse model answer at all
 */
export function transferStatus({ article, issuedTo, moved = false, known = true }) {
  // No article number is no evidence either way - see above.
  if (!norm(article)) return TRANSFER_STATUS.UNTRACEABLE
  // The warehouse model did not answer. Blank, not "No".
  if (!known) return null
  /*
   * The row's own brand is deliberately NOT consulted. This is article-level,
   * so an `__unattributed` row - one that reached no brand - now gets a real
   * answer too, where it used to be blanked for having no brand to ask about.
   */
  if ((issuedTo?.size ?? 0) > 0) return TRANSFER_STATUS.DIRECT
  return moved ? TRANSFER_STATUS.NONE : TRANSFER_STATUS.NO_MOVEMENT
}

/**
 * The Path column's text: where the article came from and where it went.
 *
 * Joined with " ; " rather than " + " so it cannot be mistaken for the
 * Transaction Type column, which joins its own values with " + ".
 */
export function formatPaths(paths) {
  const list = (paths ?? []).filter(Boolean)
  return list.length ? list.join(' ; ') : null
}

/**
 * The column text for one article, in a fixed order.
 *
 * Joined with " + " only where the latest movement genuinely produced more
 * than one channel on the same day - see `latestChannels`.
 *
 * `Needs Review` is dropped as soon as anything else is known: it is a
 * data-quality state, not a channel, and showing it beside a confirmed one
 * would read as a fifth kind of supply.
 */
export function effectiveChannels(channels) {
  const held = new Set([...(channels ?? [])].filter(Boolean))
  if (held.size > 1) held.delete(CHANNEL.REVIEW)
  return held
}

export function formatChannels(channels) {
  const held = effectiveChannels(channels)
  if (!held.size) return null
  return CHANNEL_ORDER.filter((c) => held.has(c)).join(' + ')
}

/**
 * Does this article's channel set satisfy the slicer?
 *
 * ANY match, so an article supplied two ways is found under either - and found
 * ONCE, because this answers a question about the row rather than expanding it.
 */
export function matchesChannelFilter(channels, wanted) {
  const want = (wanted ?? []).filter(Boolean)
  if (!want.length) return true
  /*
   * The SAME set the column prints.
   *
   * `effectiveChannels` drops Needs Review once a real channel is known, and
   * the filter has to agree: matching on the raw set would return articles
   * under "Needs Review" whose cell plainly reads "Purchase", which is a
   * slicer contradicting the column it filters.
   */
  const held = effectiveChannels(channels)
  if (!held.size) return false
  return want.some((w) => held.has(w))
}
