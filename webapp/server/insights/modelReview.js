import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'

/**
 * A review of the forecast model itself, per brand.
 *
 * The digest reports what the forecast *said*. This reports how it is *built* —
 * problems in the measures and in the shape of the data that no amount of
 * reading the numbers will reveal.
 *
 * Findings come from two places, and each one says which:
 *
 *   measured    asked of the live model. Change the measure and the finding
 *               disappears on the next check.
 *   model file  read from the .pbip in this repository. Those files are a
 *               snapshot and can be older than what is deployed, so a
 *               finding of this kind may already be fixed in the service.
 *
 * That distinction is not pedantry. Two findings here used to be asserted
 * from the template and reported forever — including after the measures had
 * been corrected in the service, which is exactly how a review loses its
 * credibility. Both are now measured.
 */

const num = (v) => Number(v) || 0
const pc = (v) => `${(v * 100).toFixed(1)}%`
const int = (v) => Math.round(num(v)).toLocaleString('en-US')

/**
 * One query per brand gathering everything the checks below need.
 *
 * Deliberately a single round trip: this runs for nine models and a check per
 * finding would be thirty-odd queries for a panel nobody reads more than once
 * a morning.
 */
async function probe(brand, window) {
  const pin = brand.chain ? `\n  TREATAS({"${brand.chain}"}, Forecast_Product_Table[CHAINID]),` : ''
  const dates = `TREATAS(CALENDAR(DATE(${window.from.replaceAll('-', ',')}), DATE(${window.to.replaceAll('-', ',')})), DateTable[Date])`
  const noSm =
    'FILTER(ALL(Forecast_Product_Table[ProductName_Fixed_Option]), NOT(LEFT(Forecast_Product_Table[ProductName_Fixed_Option], 2) = "SM"))'

  const dax = `EVALUATE
SUMMARIZECOLUMNS(${pin}
  ${dates},
  ${noSm},
  "Actual", [Total_Actual_Qty],
  "Forecast", [Total_Forecast_Qty],
  "Accuracy", [Forecast Accuracy %],
  "SoldNoForecast", CALCULATE(
      SUMX(VALUES(Forecast_Product_Table[Clean_ItemID]),
        VAR a = [Total_Actual_Qty] VAR f = [Total_Forecast_Qty]
        RETURN IF(a > 0 && (ISBLANK(f) || f = 0), a, 0))),
  "LinesSoldNoForecast", CALCULATE(
      SUMX(VALUES(Forecast_Product_Table[Clean_ItemID]),
        VAR a = [Total_Actual_Qty] VAR f = [Total_Forecast_Qty]
        RETURN IF(a > 0 && (ISBLANK(f) || f = 0), 1, 0))),
  "ForecastNoSale", CALCULATE(
      SUMX(VALUES(Forecast_Product_Table[Clean_ItemID]),
        VAR a = [Total_Actual_Qty] VAR f = [Total_Forecast_Qty]
        RETURN IF(f > 0 && (ISBLANK(a) || a = 0), f, 0))),
  "Articles", DISTINCTCOUNT(Forecast_Product_Table[Clean_ItemID]),
  "ProductNames", DISTINCTCOUNT(Forecast_Product_Table[ProductName_Fixed_Option]),
  "Unrounded", CALCULATE(SUMX(Forecast_Product_Table,
      Forecast_Product_Table[Incidence Rate Final] * Forecast_Product_Table[Forecast_Orders]))
)`

  const rows = await executeQuery(dax, brand.datasetId)
  return rows[0] ?? {}
}

/**
 * The checks. Each returns a finding or null, and each states the change that
 * would fix it — a review that only lists problems is a complaint.
 */
/**
 * What is the accuracy measure actually doing today?
 *
 * The service will not return measure expressions to a service principal, so
 * this asks the model instead. It pulls articles where the two candidate
 * definitions must disagree and compares the measure against both, then pulls
 * articles that sold with no forecast to see whether they still score 100%.
 *
 * Reading the DAX out of the repository would be easier and wrong: those files
 * are a snapshot, and a measure fixed in the service still looks broken there.
 */
async function probeAccuracy(brand, window) {
  const pin = brand.chain
    ? `\n      TREATAS({"${brand.chain}"}, Forecast_Product_Table[CHAINID]),`
    : ''
  const dates = `TREATAS(CALENDAR(DATE(${window.from.replaceAll('-', ',')}), DATE(${window.to.replaceAll('-', ',')})), DateTable[Date])`
  const noSm =
    'FILTER(ALL(Forecast_Product_Table[ProductName_Fixed_Option]), NOT(LEFT(Forecast_Product_Table[ProductName_Fixed_Option], 2) = "SM"))'

  const dax = `
DEFINE
  VAR Base =
    SUMMARIZECOLUMNS(
      Forecast_Product_Table[Clean_ItemID],${pin}
      ${dates},
      ${noSm},
      "A", [Total_Actual_Qty],
      "F", [Total_Forecast_Qty],
      "Acc", [Forecast Accuracy %]
    )
EVALUATE
UNION(
  TOPN(40, FILTER(Base, [A] > 0 && [F] > 0 && ABS([A] - [F]) > 5), [A], DESC),
  TOPN(15, FILTER(Base, [A] > 0 && ([F] = 0 || ISBLANK([F]))), [A], DESC)
)`

  const rows = await executeQuery(dax, brand.datasetId)
  const g = (r, k) => Number(r[`[${k}]`] ?? r[k] ?? 0)
  const accOf = (r) => {
    const v = r['[Acc]'] ?? r.Acc
    return v === null || v === undefined ? null : Number(v)
  }

  let byForecast = 0
  let byActual = 0
  let zeroPerfect = 0
  let zeroBlank = 0

  for (const r of rows) {
    const a = g(r, 'A')
    const f = g(r, 'F')
    const m = accOf(r)

    if (!f) {
      if (m === null) zeroBlank++
      else if (Math.abs(m - 1) < 1e-6) zeroPerfect++
      continue
    }
    if (m === null || !a) continue

    const dF = Math.abs(m - (1 - Math.abs(a - f) / f))
    const dA = Math.abs(m - (1 - Math.abs(a - f) / a))
    if (dF < dA) byForecast++
    else if (dA < dF) byActual++
  }

  const judged = byForecast + byActual
  return {
    sampled: rows.length,
    // Only called when the sample is one-sided. A near-tie means the two
    // definitions did not separate on this data, and guessing there would put
    // us back where we started.
    denominator:
      judged < 5
        ? 'unknown'
        : byForecast > byActual * 4
          ? 'forecast'
          : byActual > byForecast * 4
            ? 'actual'
            : 'unknown',
    zeroForecast:
      zeroPerfect + zeroBlank < 3 ? 'unknown' : zeroPerfect > zeroBlank ? 'scores-perfect' : 'blank',
    byForecast,
    byActual,
    zeroPerfect,
    zeroBlank,
  }
}

function review(brand, p, acc) {
  const out = []
  const actual = num(p.Actual)
  const forecast = num(p.Forecast)

  // --- 1. Complete misses score as perfect accuracy ------------------------
  // `1 - ABS(DIVIDE(a - f, f, 0))` falls back to 0 when the forecast is zero,
  // so the subtraction yields 1: a full 100%. The worst possible outcome —
  // selling something nobody forecast — is recorded as flawless.
  const missedUnits = num(p.SoldNoForecast)
  const missedLines = num(p.LinesSoldNoForecast)
  // Only a finding if the measure still scores those rows as perfect. Articles
  // selling with no forecast are worth knowing about either way, but that is a
  // fact about the data rather than a defect in the model.
  if (missedLines > 0 && acc?.zeroForecast === 'scores-perfect') {
    out.push({
      severity: missedUnits / (actual || 1) > 0.01 ? 'high' : 'medium',
      code: 'zero-forecast-scores-100',
      basis: 'measured',
      title: 'Products sold with no forecast are scored as 100% accurate',
      evidence: `${int(missedLines)} article${missedLines === 1 ? '' : 's'} sold ${int(missedUnits)} units against no forecast at all — ${pc(missedUnits / (actual || 1))} of everything sold. Each one currently contributes a perfect score.`,
      why: 'DIVIDE(actual − forecast, forecast, 0) returns 0 when the forecast is zero, and 1 − ABS(0) is 1. The measure cannot tell "we predicted this exactly" from "we predicted nothing".',
      fix: 'Return BLANK() rather than 0 for the zero-forecast case, so those rows are excluded from the average instead of inflating it: 1 - ABS( DIVIDE( _actual - _forecast, _forecast ) ). Blank rows drop out of an average; zeros do not.',
    })
  }

  // --- 2. The denominator makes the measure asymmetric --------------------
  // Asserted unconditionally in an earlier version, so it kept being reported
  // after the measure had already been corrected. It is now decided by asking
  // the model which definition its own answers agree with.
  if (acc?.denominator === 'forecast') {
    out.push({
      severity: 'high',
      code: 'accuracy-denominator',
      basis: 'measured',
      title: 'Accuracy is measured against the forecast, not against what sold',
    evidence:
      'Sell 100 against a forecast of 1,000 and the measure reads 10%. Sell 1,000 against a forecast of 100 and it reads −800%. The same absolute miss, scored eighty times more harshly in one direction.',
    why: 'The denominator is the number being judged. Over-forecasting inflates it and shrinks the apparent error, so the measure rewards forecasting high — the opposite of what a prep plan wants.',
    fix: 'Divide by the actual instead: 1 - ABS( DIVIDE( _actual - _forecast, _actual ) ). If a symmetric figure is wanted, divide by the average of the two. Either way it changes reported accuracy, so agree it before switching — the app follows whatever the model says.',
    })
  }

  // --- 3. Forecast for things that never sold -----------------------------
  const wasted = num(p.ForecastNoSale)
  if (wasted / (forecast || 1) > 0.02) {
    out.push({
      severity: 'medium',
      code: 'forecast-no-sale',
      title: 'A measurable share of the forecast is for products that sold nothing',
      evidence: `${int(wasted)} forecast units — ${pc(wasted / (forecast || 1))} of the total — sat on articles with no sales at all in the period.`,
      why: 'Usually delisted lines still carrying a forecast, or article codes that have been replaced. They inflate the prep plan and drag the accuracy figure down without anyone having done anything wrong.',
      fix: 'Exclude articles with no sales in the trailing window from the forecast spine, or add a flag for discontinued lines and filter on it. Worth reviewing the list before deleting anything — some will be seasonal.',
    })
  }

  // --- 4. Two grains presented as one ratio -------------------------------
  const articles = num(p.Articles)
  const names = num(p.ProductNames)
  if (articles > names) {
    out.push({
      severity: 'medium',
      code: 'mixed-grain-counts',
      title: 'The prep counters mix articles with product names',
      evidence: `This brand has ${int(articles)} articles across ${int(names)} product names. "Products To Prepare" counts articles (SUMMARIZE on Clean_ItemID); "High Demand Products" and "Low Demand Products" count product names (SUMX over ProductName_Fixed_Option).`,
      why: 'Reading one as a share of the other — "85 of 400 need extra prep" — divides a product count by an article count. The percentage is not wrong by a little; it is not a percentage of anything.',
      fix: 'Pick one grain and use it in all three. Article is the safer choice because that is what a branch actually prepares, so change the two demand counters to SUMX over VALUES(Clean_ItemID).',
    })
  }

  // --- 5. New lines are invisible to the demand alerts --------------------
  out.push({
    severity: 'medium',
    code: 'new-lines-invisible',
    title: 'Brand-new products never trigger a demand alert',
    evidence:
      '"Demand Change %" returns BLANK() when the two-weekday baseline is under 1, and the high and low demand counters are built on it. A product launched this week has no baseline, so it cannot be flagged however much it sells.',
    why: 'The guard exists to avoid dividing by zero, which is right. The side effect is that the products most likely to need a prep decision — the ones nobody has experience of yet — are the ones the alerts ignore.',
    fix: 'Count new lines separately rather than forcing them through the same measure: a "New this week" counter over articles with a forecast for tomorrow and no actual in the trailing 14 days would surface them without touching the existing logic.',
  })

  // --- 6. TODAY() is the service clock, not the local one -----------------
  out.push({
    severity: 'low',
    code: 'today-timezone',
    title: 'Tomorrow is calculated from the service clock',
    evidence:
      '"Tomorrow Forecast Qty", "Products To Prepare" and "Last 2 Weekdays Avg Actual" all derive from TODAY(), which in the Power BI service is UTC.',
    why: 'Kuwait runs three hours ahead of UTC, so between midnight and 3am local the service still thinks it is the previous day. Anything read or sent in that window plans for the wrong day.',
    fix: 'Anchor to a local-time expression instead — UTCNOW() + TIME(3,0,0) — or drive it from a dedicated "today" flag in the refresh so it is fixed at load time rather than evaluated per query. The 7am reports are unaffected; a late-night refresh would not be.',
  })

  // --- 7. Component demand is computed the expensive way -------------------
  out.push({
    severity: 'low',
    code: 'component-perf',
    title: 'Component demand iterates the whole forecast table per recipe row',
    evidence:
      'Component_Forecast_Qty uses SUMX over RECIPE TABLE with FILTER(Forecast_Product_Table, …) inside, matching Clean_ItemID to Product PLU by scanning.',
    why: 'FILTER over an unrestricted table forces a row-by-row scan for every recipe line, so the cost is recipes × forecast rows. It is the slowest query in the app by a wide margin.',
    fix: 'Replace the scan with TREATAS to push the match into the engine, or better, add a real relationship between RECIPE TABLE[Product PLU] and Forecast_Product_Table[Clean_ItemID] and let CALCULATE use it.',
  })

  /* --------------------------------------------------------------------
   * How to make the forecast more accurate.
   *
   * Everything above is a defect - something the model gets wrong. These are
   * different: the logic is sound, but there are choices inside it that are
   * costing accuracy and can be changed.
   *
   * The forecast resolves to one line:
   *
   *   Forecast_Qty     = ROUND( [Incidence Rate Final] * [Forecast_Orders] )
   *   Forecast_Orders  = [Total_Sales] / [AOV]
   *
   * So every unit forecast passes through exactly two numbers - the incidence
   * rate and AOV - and an error in either scales the whole branch-day. That is
   * where the leverage is, and that is what these look at.
   * ------------------------------------------------------------------- */

  const improve = []

  // --- A. Rounding, measured rather than asserted --------------------------
  // ROUND() is applied per article. Across a few hundred low-volume lines the
  // half that rounds down is not cancelled by the half that rounds up, because
  // the distribution is not symmetric - most articles sit near zero.
  const unrounded = num(p.Unrounded)
  if (unrounded > 0) {
    const drift = forecast - unrounded
    const share = Math.abs(drift) / unrounded
    if (share > 0.002) {
      improve.push({
        id: 'rounding-bias',
        kind: 'improve',
        basis: 'measured',
        severity: share > 0.01 ? 'high' : 'medium',
        area: 'Forecast_Product_Table[Forecast_Qty_7(last 28+2)]',
        title: 'Rounding every article separately shifts the total',
        detail: `Forecast_Qty rounds each article to a whole unit before anything is summed. Across ${int(articles)} articles that is not noise that cancels out - most lines sit near zero, so the rounding mostly goes one way.`,
        evidence: `Rounded total ${int(forecast)} against ${int(unrounded)} unrounded: a ${drift > 0 ? 'gain' : 'loss'} of ${int(Math.abs(drift))} units, ${pc(share)} of the forecast.`,
        fix: 'Drop ROUND() and keep the decimals: Forecast_Qty = [Incidence Rate Final] * [Forecast_Orders]. Round in the visual instead, where it is a display choice rather than a change to the data. If whole units are needed in a table, round the total rather than each row.',
      })
    }
  }

  // --- B. AOV is a plain mean of three days --------------------------------
  improve.push({
    id: 'aov-mean-of-three',
    kind: 'improve',
    basis: 'model file',
    severity: 'high',
    area: 'Forecast_Product_Table[AOV]',
    title: 'AOV is the plain average of three days, so one odd day moves everything',
    detail:
      'AOV takes the last three matching weekdays and averages them with no protection against an outlier. Because Forecast_Orders = Total_Sales / AOV, the error runs backwards into every product in that branch that day: an AOV 10% too high makes every forecast about 9% too low. One promotion, one closure, one delivery-heavy day is enough to do it.',
    evidence:
      'The column peels _date1, _date2 and _date3, then returns DIVIDE(_aov1 + _aov2 + _aov3, _count) - an unweighted mean of at most three values.',
    fix: 'Two small changes. Take the median of the three rather than the mean, which ignores a single outlier: MEDIANX(TOPN(3, _allMatchingDates, [AOV_Date]), [DayAOV]). Then widen the search to the last five matching weekdays so the median has something to work with. If you would rather keep a mean, take five and drop the highest and lowest.',
  })

  // --- C. AOV can rest on a single day -------------------------------------
  improve.push({
    id: 'aov-thin-history',
    kind: 'improve',
    basis: 'model file',
    severity: 'medium',
    area: 'Forecast_Product_Table[AOV]',
    title: 'A branch with one matching weekday forecasts off that single day',
    detail:
      '_count is however many of the three dates were found, so a new branch, a reopening, or a gap in the data leaves the whole branch-day resting on one AOV - and nothing anywhere says that it did.',
    evidence:
      'RETURN DIVIDE(COALESCE(_aov1,0) + COALESCE(_aov2,0) + COALESCE(_aov3,0), _count) divides by 1 when only _date1 was found.',
    fix: 'Require at least two matching days and fall back to the branch 28-day average otherwise: IF(_count >= 2, <the average>, CALCULATE(AVERAGE(AOV_Table[Daily_AOV]), <same branch, last 28 days>)). A blunter number beats a confident one built from a single day.',
  })

  // --- D. The tuning constants are buried in nine copies of the DAX --------
  improve.push({
    id: 'tuning-constants',
    kind: 'improve',
    basis: 'model file',
    severity: 'medium',
    area: 'Incidence_Table[Incidence Rate % Final]',
    title: 'The numbers that steer the forecast are hard-coded in every model',
    detail:
      'The decay rate, the weekday split, the adaptive weights and the drastic-change threshold are all literals inside the column. Tuning any of them means editing DAX in nine models and keeping them in step, so in practice nobody tunes them - and that is the real cost, more than any single value being wrong.',
    evidence:
      'EXP(-0.08 * [Age]) for the decay; (_week1Rate * 0.7) + (_week2Rate * 0.3) for weekday memory; IF(_sellFreq >= 0.50, 0.50, 0.25) for the blend; _relativeChange > 0.20 for the drastic switch.',
    fix: 'Move those constants into a one-row Parameters table in each model and reference them by name. They then become something you can change in the morning, measure accuracy against, and change back - which is what turns them from settings into something you can actually improve.',
  })

  // --- E. The drastic-change switch is a step, not a ramp ------------------
  improve.push({
    id: 'drastic-step',
    kind: 'improve',
    basis: 'model file',
    severity: 'medium',
    area: 'Incidence_Table[Incidence Rate % Final]',
    title: 'The drastic-change switch flips all at once at 20%',
    detail:
      'Below 20% the rate is a smoothed 28-day blend; above it, the raw last-7-days rate with no smoothing at all. Two products either side of that line are treated completely differently, and a product hovering near 20% flips between them day to day - which reaches a branch as a forecast that jumps for no reason they can see.',
    evidence:
      'RETURN IF(_isDrastic, _last7Rate, _blendedRate), where _isDrastic is _relativeChange > 0.20.',
    fix: 'Fade between them instead of switching: VAR _w = MIN(1, MAX(0, DIVIDE(_relativeChange - 0.15, 0.20))) then RETURN (_last7Rate * _w) + (_blendedRate * (1 - _w)). Nothing changes below 15%, the last-7 rate takes over fully by 35%, and in between it moves gradually.',
  })

  // --- F. The sell-frequency denominator is one day out -------------------
  improve.push({
    id: 'sellfreq-denominator',
    kind: 'improve',
    basis: 'model file',
    severity: 'low',
    area: 'Incidence_Table[Incidence Rate % Final]',
    title: 'Sell frequency divides by 28 but measures 27 days',
    detail:
      '_history spans strictly between _monthStart and _currentDate, which is 27 days, while _sellFreq divides by 28. Every product scores slightly less regular than it is, and products sitting near the 0.50 cut-off take the lower weekday weight when they should take the higher one.',
    evidence:
      'VAR _history = FILTER(..., VOUCHERDATE > _monthStart && VOUCHERDATE < _currentDate) with _monthStart = _currentDate - 28, against VAR _sellFreq = DIVIDE(_daysSold, 28, 0).',
    fix: 'Divide by what was actually measured: DIVIDE(_daysSold, COUNTROWS(DISTINCT(SELECTCOLUMNS(_history, "d", Incidence_Table[VOUCHERDATE]))), 0). That also stays right for a branch with less than a month of history, which the fixed 28 does not.',
  })

  // --- G. Numerator and denominator are aggregated differently ------------
  improve.push({
    id: 'aggregation-mismatch',
    kind: 'improve',
    basis: 'model file',
    severity: 'low',
    area: 'Incidence_Table[Incidence Rate % Final]',
    title: 'The two halves of the blend aggregate the same column differently',
    detail:
      'The 28-day half takes MAX of the daily quantity per date; the weekday half takes SUM across the matching rows. Those agree only while there is exactly one row per item, branch and date. If that ever stops being true - a second till, a re-import, a split voucher - the two halves of the same blend quietly start measuring different things.',
    evidence:
      'SUMMARIZE(_history, VOUCHERDATE, "DailyQty", MAX(...[Numerator (Total Qty)])) against SUMX(FILTER(..., VOUCHERDATE = _week1Date), ...[Numerator (Total Qty)]).',
    fix: 'Use one aggregation in both places. SUM is the safer of the two, because MAX silently discards the extra rows instead of failing.',
  })

  return {
    brand: brand.code,
    brandLabel: brand.label,
    accuracy: num(p.Accuracy),
    actual,
    forecast,
    articles,
    productNames: names,
    soldWithNoForecast: { units: missedUnits, lines: missedLines },
    forecastWithNoSale: wasted,
    findings: out,
    improvements: improve,
  }
}

const idOf = (f) => f.code ?? f.id ?? f.title

/**
 * Split what every brand shares from what is particular to one.
 *
 * The nine models came from the same template, so most findings appear nine
 * times. Listing them nine times buries the one thing that is only true of
 * Yelo under eight repetitions of something true everywhere — which is the
 * opposite of what a review is for.
 *
 * "Common" means every brand that could actually be read. A brand that errored
 * is not evidence either way, so it neither creates nor breaks a common
 * finding.
 */
function splitCommon(reviewed, key) {
  const readable = reviewed.filter((r) => !r.error)
  if (readable.length < 2) return { common: [], perBrand: reviewed }

  const seen = new Map()
  for (const r of readable) {
    for (const f of r[key] ?? []) {
      const id = idOf(f)
      if (!seen.has(id)) seen.set(id, [])
      seen.get(id).push({ brand: r.brand, finding: f })
    }
  }

  const commonIds = new Set(
    [...seen.entries()].filter(([, hits]) => hits.length === readable.length).map(([id]) => id)
  )

  const common = [...commonIds].map((id) => {
    const hits = seen.get(id)
    return {
      ...hits[0].finding,
      brands: hits.map((h) => h.brand),
      // The wording is shared but the numbers are not, so each brand's own
      // evidence is carried rather than one brand's standing in for all nine.
      evidencePerBrand: hits.map((h) => ({ brand: h.brand, evidence: h.finding.evidence })),
    }
  })

  const perBrand = reviewed.map((r) =>
    r.error ? r : { ...r, [key]: (r[key] ?? []).filter((f) => !commonIds.has(idOf(f))) }
  )

  return { common, perBrand }
}

/** The whole review: what every brand shares, then what is particular to one. */
export async function reviewModels(window) {
  const out = []
  for (const brand of config.brands) {
    try {
      const [stats, accuracy] = await Promise.all([
        probe(brand, window),
        // A failed accuracy probe must not cost the rest of the review; the two
        // findings it governs simply stay quiet rather than guessing.
        probeAccuracy(brand, window).catch(() => null),
      ])
      out.push(review(brand, stats, accuracy))
    } catch (err) {
      out.push({
        brand: brand.code,
        brandLabel: brand.label,
        error: err.message,
        findings: [],
        improvements: [],
      })
    }
  }

  const f = splitCommon(out, 'findings')
  const i = splitCommon(f.perBrand, 'improvements')

  return {
    brands: i.perBrand,
    commonFindings: f.common,
    commonImprovements: i.common,
    brandCount: out.filter((r) => !r.error).length,
  }
}
