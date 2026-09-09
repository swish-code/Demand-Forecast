/**
 * Warehouse forecast analysis — a living investigation.
 *
 * Three things make this different from a report that happens to have charts:
 *
 * Every bar is a filter. Click "Under 20%" and the table below shows those
 * articles, with the reason each one is failing. The chart and the list are cut
 * by the same keys, computed once on the server, so the count on a bar and the
 * number of rows it produces cannot drift apart.
 *
 * Recommendations check themselves. Each one carries a test against the live
 * figures; when the test says the problem is gone, it stops being advice and
 * moves to the change log as resolved. Nothing has to be remembered or manually
 * retired, and the page cannot go on recommending something already done.
 *
 * The language is plain on purpose. The analysis underneath is unchanged — the
 * same thresholds, the same measurements — but a manager should not have to
 * decode "degradation under high demand volatility" to learn that a forecast
 * struggles when demand jumps about.
 *
 * Administrators only, enforced by the route as well as the rail.
 */
import { useMemo, useState } from 'react'
import { api, fmtInt, fmtQty, fmtPct } from '../api.js'
import { useData } from '../useData.js'
import { DataTable } from '../components/DataTable.jsx'
import { ChartSkeleton, Empty, ErrorBanner, MetricCard, Panel, Pill } from '../components/ui.jsx'

const SEVERITY = { Critical: 'red', High: 'amber', Medium: 'blue', Low: 'slate' }

/** A forecast at or above this counts as one that worked — the server's line. */
const GOOD = 0.6

/*
 * Where the swing bands sit. These mirror whDiagnostics.js exactly; the server
 * decides which band each article is in (`keys.volatility`) and these are only
 * for wording a badge, so the two cannot disagree about who is in which group.
 */
const CV_STEADY = 0.3
const CV_VOLATILE = 0.6
const CV_ERRATIC = 1.0

/* ------------------------------------------------------------- findings --- */

/**
 * The things worth fixing, each with a test that says whether it still applies.
 *
 * `check` runs against the live figures every time the page loads. While it
 * returns true the item is an open recommendation; when it returns false the
 * item moves itself into the change log as resolved. That is what stops this
 * page from recommending something that was done last week.
 *
 * The tests are deliberately about outcomes rather than about code: "are
 * articles that stopped shipping still being forecast?" rather than "has
 * somebody edited whConstant.js?". An issue that comes back is caught the same
 * way it was caught the first time.
 */
const FINDINGS = [
  {
    id: 'stopped',
    severity: 'Critical',
    title: 'Articles that stopped selling are still being ordered',
    plain:
      'Some articles shipped steadily for months and then stopped completely. The forecast still asks for them, because it works from six months of history and nothing tells it the line has ended.',
    why:
      'The rate is an average of the last six months. Those months were real, so the average is confident — it simply describes a period that is over.',
    affects: 'Discontinued lines, and anything switched to a different supplier or pack size.',
    cost: (s) => `${fmtQty(s.stoppedForecast)} units of demand for stock nobody is moving.`,
    fix:
      'Stop forecasting an article once it has had no shipments for two months, and list it separately so somebody can confirm it has really gone.',
    check: (s) => s.stoppedCount > 0,
    resolvedNote: 'No article in this selection has stopped shipping while still being forecast.',
    filter: { type: 'issue', key: 'stopped' },
  },
  {
    id: 'volatility',
    severity: 'Critical',
    title: 'One method is used for every kind of demand',
    plain:
      'When an article ships about the same amount each month, the forecast is good. When the amount jumps about, it is poor. Both get exactly the same treatment: an average of the last six months.',
    why:
      'An average describes steady demand well and unstable demand badly. Averaging a series that swings wildly gives a number that was never typical of any month in it.',
    affects: 'Articles whose monthly shipping swings by more than about half its own size.',
    cost: (s, seg) => {
      const steady = seg.volatility?.find((v) => v.key === 'steady')
      const erratic = seg.volatility?.find((v) => v.key === 'erratic')
      return steady && erratic
        ? `${fmtPct(steady.share ?? 0, 0)} of steady articles forecast well, against ${fmtPct(erratic.share ?? 0, 0)} of the most unstable ones.`
        : 'Accuracy falls steadily as demand becomes less stable.'
    },
    fix:
      'For articles that jump about, use the middle month rather than the average. One unusual month then stops setting the figure for the next six.',
    check: (s, seg) => {
      const steady = seg.volatility?.find((v) => v.key === 'steady')
      const erratic = seg.volatility?.find((v) => v.key === 'erratic')
      // Still a problem while stable articles do much better than unstable ones.
      return Boolean(steady && erratic && (steady.share ?? 0) - (erratic.share ?? 0) > 0.15)
    },
    resolvedNote: 'Unstable articles now forecast about as well as steady ones.',
    filter: { type: 'volatility', key: 'erratic' },
  },
  {
    id: 'bias',
    severity: 'High',
    title: 'The forecast leans in one direction',
    plain:
      'The misses are not random. Across everything, the forecast consistently asks for more than the warehouse ships, or consistently less. That is a fault in the method rather than bad luck.',
    why:
      'Every month counts equally, so six months ago carries as much weight as last month. If demand is drifting up or down, the forecast is always behind it.',
    affects: 'Everything, but most visibly articles whose demand is trending.',
    cost: (s) =>
      `In total the forecast is ${fmtPct(Math.abs(s.biasPct ?? 0), 1)} ${s.biasPct > 0 ? 'above' : 'below'} what actually shipped — ${fmtQty(Math.abs(s.totalVariance))} units.`,
    fix:
      'Give recent months more weight than old ones, so the forecast follows a trend instead of trailing it. Test it on a past month before switching over.',
    check: (s) => Math.abs(s.biasPct ?? 0) > 0.05,
    resolvedNote: 'Forecast and actual now agree within 5% overall, so there is no consistent lean.',
    filter: { type: 'direction', key: 'over' },
  },
  {
    id: 'low-volume',
    severity: 'Medium',
    title: 'Tiny articles produce meaningless percentages',
    plain:
      'For an article that shipped four units, being two units out is a 50% error. The percentage is technically right and tells you nothing useful.',
    why:
      'Accuracy is a percentage of what shipped. When that number is very small, ordinary rounding and a single case become enormous percentages.',
    affects: 'Articles moving under a hundred units in the period.',
    cost: (s, seg, issues) => `${fmtInt(issues('low-volume'))} articles are in this position.`,
    fix:
      'Show how many units out we were, but not a percentage, below a sensible volume. Rank problems by units so the big ones surface first.',
    check: (s, seg, issues) => issues('low-volume') > 0,
    resolvedNote: 'No article small enough for its percentage to be misleading.',
    filter: { type: 'volume', key: 'tiny' },
  },
  {
    id: 'spike',
    severity: 'High',
    title: 'One big delivery distorts the next six months',
    plain:
      'If an article had one unusually large delivery, that month is averaged in at full weight and keeps inflating the forecast long after it was a one-off.',
    why: 'An average has no way of knowing a month was unusual. It treats a one-off exactly like a pattern.',
    affects: 'Articles with occasional bulk orders rather than regular deliveries.',
    cost: (s, seg, issues) => `${fmtInt(issues('spike'))} articles have one month at three times the others.`,
    fix: 'Use the middle month, or set aside the most extreme month before averaging.',
    check: (s, seg, issues) => issues('spike') > 0,
    resolvedNote: 'No article is being carried by a single unusual month.',
    filter: { type: 'issue', key: 'spike' },
  },
  /*
   * "New articles are forecast from very little" used to sit here, and was
   * removed on 8 Sep 2026 rather than reworded. Measuring it showed articles
   * with 3-4 months of history score about the same as those with 5-6, so it
   * described a fault that is not there. It is in "what we ruled out" below,
   * where a tested-and-rejected idea is worth more than a plausible one.
   */
]

/**
 * The plan to 85%, in the priority the business set on 8 Sep 2026.
 *
 * Separate from the findings above, which each describe one fault. This is the
 * order of work: what to do, why, what it is worth, and what it costs to try.
 *
 * `gain` distinguishes what was measured from what is expected, in those words,
 * because the two are not the same kind of claim and a plan that blurs them is
 * how a target gets set that the data cannot support.
 *
 * `state` lets a step say it is already done. The page then stops advertising
 * work that has been finished, the same way the findings retire themselves.
 */
const ROUTE = [
  {
    step: 0,
    state: 'blocked',
    title: 'Agree what the 85% is measured over',
    do: 'Decide whether the card averages every article, or only the articles we actively plan — and show the count beside it either way.',
    why:
      'This decides whether the target is reachable at all. Averaged over every article, a forecast that knew each one’s true level perfectly would still score far below 85%. Averaged over active articles only, it is a different and much more answerable question.',
    gain: 'Nothing else on this list can be judged until the thing being judged is settled.',
    effort: 'A decision, not a code change. Everything below assumes it is made first.',
  },
  {
    step: 1,
    state: 'done',
    title: 'Classify every article by how long since it moved',
    do: 'Five statuses from Swish SPS V3 2026 — Active, Slow-Moving, Super Slow-Moving, Non-Moving, To Be Deactivated.',
    why:
      'One method is currently used for articles that ship every week and articles that stopped last spring. They are not the same problem and cannot have the same answer.',
    gain:
      'The single largest lever. Most articles carry a small share of the volume, and in an average across articles each one counts as much as the largest line.',
    effort: 'Done. Shown above; it does not change what is forecast yet.',
  },
  {
    step: 2,
    title: 'Forecast occasional articles as how often, not how much per day',
    do: 'For articles that ship in bursts, forecast the chance of an order and the size of one, instead of spreading a monthly average across every day.',
    why:
      'An article ordered every third week does not have a weekly demand. An average is too high on the silent weeks and too low on the ordering week, so it is wrong in both directions at once.',
    gain:
      'Expected to be large: this is the shape most of the silent weeks have. It also converts articles that look volatile — but are only on a delivery cycle — into predictable ones.',
    effort: 'A second forecasting method, scoped to the Slow-Moving group first.',
  },
  {
    step: 3,
    title: 'Test whether a longer window lifts the ceiling',
    do: 'Score the same forecast over a quarter as well as a month, and compare.',
    why:
      'Swings that are unpredictable week to week partly cancel over a longer period. If they do here, the achievable accuracy rises without changing the forecast at all.',
    gain:
      'Not yet measured properly — the attempt so far had too few periods to trust. This is a measurement to run, not a change to make.',
    effort: 'Analysis only. No change to the app until the result is in.',
  },
  {
    step: 4,
    title: 'Use stock on hand to suppress orders, not to reduce them',
    do: 'Where shops already hold well over the usual cover, forecast zero for the period rather than a smaller number.',
    why:
      'Outbound already reflects somebody looking at the shelf before ordering. Subtracting stock from a forecast built on outbound counts the same decision twice.',
    gain:
      'Unproven. Stock levels were tested against what ships next and showed no relationship. The narrower question — whether high stock explains the zero weeks specifically — has not been tested yet and should be, before this is built.',
    effort: 'Test first. The inventory model has the data, from January 2026 onwards.',
  },
  {
    step: 5,
    title: 'Spread the forecast by the days an article actually ships on',
    do: 'Weight each weekday by that article’s own history instead of splitting the window evenly.',
    why:
      'An article that only ever ships on Wednesdays is forecast something every Monday, and misses every time.',
    gain:
      'Helps short windows most — a day, a week, month-to-date. Over a full month it moves quantity around inside the window and changes the total very little.',
    effort: 'Needs a minimum amount of history per article before its shape is trusted.',
  },
  {
    step: 6,
    title: 'Correct the overall lean',
    do: 'Apply one calibration factor so the total forecast matches the total shipped.',
    why: 'Every month counts equally in the rate, so a drift in demand leaves a standing bias in one direction.',
    gain: 'Small but free, and it applies to every article rather than a group of them.',
    effort: 'One number. Backtest on a past month before switching over.',
  },
  {
    step: 7,
    title: 'Stop one big delivery setting the next six months',
    do: 'Cap an exceptional month at about three times the median of the others before averaging, rather than dropping it.',
    why: 'An average cannot tell a one-off from a pattern, and carries the one-off forward at full weight.',
    gain: 'The damage is concentrated in a small number of articles, so this is narrow but cheap.',
    effort: 'Small, inside the rate calculation. Cap rather than delete — the stock really was consumed.',
  },
]

/**
 * Ideas that were tested and did not survive.
 *
 * On the page for one reason: without it, a sensible theory that has already
 * been measured and rejected gets proposed again every few months, and somebody
 * spends a week re-discovering the same answer. A null result is a finding, and
 * it is worth as much page space as a positive one.
 */
const RULED_OUT = [
  {
    id: 'soh-buffering',
    title: 'Stock on hand explains why less ships than forecast',
    theory:
      'Shops that already hold stock order less, so outbound falls below forecast — and picks up again once the stock runs down.',
    test:
      'Compared shop stock cover against what shipped the following period, at both monthly and weekly grain, across roughly 1,300 articles and 45,000 article-weeks.',
    result:
      'No relationship at either grain, and the weekly direction runs the wrong way — articles holding the most stock shipped slightly more the following week, not less.',
    verdict: 'Rejected as an explanation. Kept as a possible zero-suppression signal, which is a different claim.',
  },
  {
    id: 'history-length',
    title: 'New articles forecast badly because they have less history',
    theory: 'An article with three months of history should forecast worse than one with six.',
    test: 'Split every scored article by how many months of deliveries it has and compared accuracy.',
    result:
      'Almost no difference — 3–4 months and 5–6 months both score about the same. What separates good from bad is how steadily the article ships, not how long it has been shipping.',
    verdict:
      'Rejected. No separate method is needed for new articles, which is one less thing to build. Judge an article by its steadiness instead.',
  },
  {
    id: 'consumption',
    title: 'Forecast what shops consume, then convert it into shipments',
    theory:
      'Shipments are a purchasing decision; consumption is the real demand underneath, and should be steadier and easier to forecast.',
    test:
      'Compared month-to-month variation in recorded shop consumption against variation in warehouse shipments, for every article present in both.',
    result:
      'Consumption came out noisier, not steadier — and for most articles it is barely recorded at all. Shop transfer-in matches warehouse shipments closely, so the data lines up; the consumption columns themselves are largely empty.',
    verdict:
      'Blocked by the data rather than disproven. Worth revisiting if those columns are ever populated upstream.',
  },
]

/**
 * What has already been changed.
 *
 * Fixed entries, as opposed to the findings above which retire themselves. Both
 * end up in the same list at the bottom of the page.
 */
const CHANGES = [
  {
    date: '09 Sep 2026',
    status: 'Implemented',
    title: 'Consumables are no longer blanked by the menu rule',
    problem:
      'Gloves, napkins, paper bags and face masks are all named in the recipe master, so the forecast treated them as menu-driven and waited for a menu signal that can never arrive — nothing on a menu is measured in gloves. Their forecast was blank while the warehouse shipped 1.75 million units of them in thirty days.',
    change:
      'The menu rule now applies only where a menu actually drives the article. Where no brand’s menu wants it at all, the question falls back to the one asked of every other warehouse-only article: is it still moving?',
    impact:
      '89 brand-article forecasts restored, worth 1,747,201 units — Gloves Blue Vinyl alone is 1,169,700. Verified to add forecasts only: no article that was forecast before lost one.',
  },
  {
    date: '09 Sep 2026',
    status: 'Implemented',
    title: 'Article status added to the table and the slicers',
    problem:
      'The five statuses were worked out and shown as a summary, but there was no way to see which status a given article had, or to look at one group.',
    change:
      'Every row now carries its status, there is a Status slicer beside Supply, and a Status column in the table. Classification only — it does not change what is forecast.',
    impact:
      'A reader can filter to Non-Moving or Slow-Moving and see exactly those articles, cut to the end of the window on screen.',
  },
  {
    date: '08 Sep 2026',
    status: 'Implemented',
    title: 'Every article now has a status',
    problem:
      'One forecasting method was used for articles that ship every week and for articles that stopped last spring. Nothing on the page said which was which.',
    change:
      'The five statuses from Swish SPS V3 2026 — Active through To Be Deactivated — worked out from how long since the warehouse last issued each article, measured in rolling days so a status does not change just because a new month began.',
    impact:
      'Shown, filterable and groupable. It does not change what is forecast yet: the classification is meant to be checked against what people expect before anything is suppressed.',
  },
  {
    date: '08 Sep 2026',
    status: 'Implemented',
    title: 'Articles that cannot be forecast are now named as such',
    problem:
      'A low score looked the same whether the forecast was wrong or the article was simply unpredictable. Those need opposite responses and there was no way to tell them apart.',
    change:
      'Each article now carries the best score any forecast could achieve on it, given how much it swings. Where accuracy has already reached that figure, it says so.',
    impact:
      'Effort can go to articles where there is something to win, rather than to ones that are already as good as they can get.',
  },
  {
    date: '08 Sep 2026',
    status: 'Investigated — no change made',
    title: 'Stock on hand tested again, at weekly grain this time',
    problem:
      'The first test was monthly, and a monthly test cannot see a buffer that turns over inside the month. That was a fair objection to it.',
    change:
      'Re-tested weekly, where the shops hold about two and a half weeks of cover so a buffer would show. Also checked whether shop consumption is steadier than warehouse shipments.',
    impact:
      'Same answer, more firmly: no relationship at weekly grain either, and the direction runs slightly the wrong way. Consumption came out noisier than shipments, and is barely recorded for most articles. Stock stays useful for suppressing orders, not for sizing them.',
  },
  {
    date: '08 Sep 2026',
    status: 'Removed',
    title: '"New articles are forecast from very little" taken off this page',
    problem:
      'It was listed as a fault to fix. Measuring it showed articles with 3–4 months of history score about the same as those with 5–6.',
    change:
      'Removed as a finding and moved to "what we tested and ruled out", with the measurement beside it.',
    impact:
      'One less thing to build. What actually separates good forecasts from bad ones is how steadily an article ships, not how long it has been shipping.',
  },
  {
    date: '06 Sep 2026',
    status: 'Implemented',
    title: 'Recipe articles now follow the menu, not their own history',
    problem:
      'An ingredient kept being ordered even when nothing on the menu used it any more, because its shipping history looked healthy.',
    change:
      'An ingredient is only forecast while a dish that uses it is still being planned for tomorrow or later.',
    impact: 'What we order now follows what the kitchens are actually planning to make.',
  },
  {
    date: '06 Sep 2026',
    status: 'Implemented',
    title: 'Articles with no recent movement are no longer forecast',
    problem:
      'Articles that stopped shipping months ago were still generating orders from old history. The canned drinks range shipped 42,000–57,000 a month until July and then stopped, and the forecast kept asking for tens of thousands.',
    change: 'An article with no shipments in the last three months is left out of the forecast.',
    impact: 'Stops the order list recommending stock nobody is moving.',
  },
  {
    date: '06 Sep 2026',
    status: 'Implemented',
    title: 'Accuracy is calculated one way everywhere',
    problem: 'The summary card and the table total used different sums, so the two disagreed by about 50 points.',
    change: 'Both now use one calculation, so they always agree.',
    impact: 'The number on the card can be checked against the table underneath it.',
  },
  {
    date: '06 Sep 2026',
    status: 'Implemented',
    title: 'Menu breakdown now shows only the right brand',
    problem:
      'Opening an article showed the same dish under every brand, because the recipe list is shared across all of them.',
    change: 'The breakdown now matches recipes to the brand that actually sells the dish.',
    impact: 'One combo went from 25 dishes across nine brands to 11, in the one brand that sells it.',
  },
  {
    date: '06 Sep 2026',
    status: 'Investigated — no change made',
    title: 'Stock on hand does not explain the gaps',
    problem:
      'A sensible theory: the warehouse ships less than forecast because stores already have stock, and more when they have run out.',
    change:
      'Tested it. If stock levels were the cause, a low month would be followed by a high one as stock ran down. Across 1,128 articles and 5,640 pairs of months there is no such pattern — the errors repeat in the same direction rather than reversing.',
    impact:
      'Stock on hand is worth having for other reasons, but it is not what is costing accuracy here. The method itself is.',
  },
]

/* ------------------------------------------------------------------ bits -- */

/** A clickable bar: label, length, value. Selected bars are outlined. */
function Bar({ label, value, display, max, tone = 'good', note, active, onPick }) {
  const pct = max > 0 ? Math.max(0, (value / max) * 100) : 0
  return (
    <button
      type="button"
      className={`bandrow${active ? ' bandrow--on' : ''}`}
      onClick={onPick}
      disabled={!onPick}
      title={note}
      aria-pressed={active || undefined}
    >
      <span className="bandrow__key">{label}</span>
      <span className="bandrow__track">
        <span className={`bandrow__fill bandrow__fill--${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="bandrow__count">{display}</span>
    </button>
  )
}

/**
 * A bar that is only a bar.
 *
 * Same visual language as the clickable ones, but a div rather than a disabled
 * button — a disabled control is drawn faded, which would say "this is switched
 * off" about a chart that is simply not a filter.
 */
function Meter({ label, value, display, max, tone = 'good', note }) {
  const pct = max > 0 ? Math.max(0, (value / max) * 100) : 0
  return (
    <div className="bandrow bandrow--static" title={note}>
      <span className="bandrow__key">{label}</span>
      <span className="bandrow__track">
        <span className={`bandrow__fill bandrow__fill--${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="bandrow__count">{display}</span>
    </div>
  )
}

/** A finding: the number that carries it, the claim, one line of why. */
function Insight({ figure, title, children, tone = 'slate' }) {
  return (
    <article className={`ins ins--${tone}`}>
      <span className="ins__figure">{figure}</span>
      <h3 className="ins__title">{title}</h3>
      <p className="ins__body">{children}</p>
    </article>
  )
}

/** How a step is labelled when it is not simply outstanding work. */
const STEP_STATE = {
  done: { tone: 'green', label: 'Done' },
  blocked: { tone: 'red', label: 'Decision needed first' },
}

/** One step on the route: what to do, why, what it is worth, what it costs. */
function Step({ entry }) {
  const state = STEP_STATE[entry.state]
  return (
    <article className={`step${entry.state ? ` step--${entry.state}` : ''}`}>
      <span className="step__num" aria-hidden="true">
        {entry.step}
      </span>
      <div className="step__body">
        <h3 className="step__title">
          {entry.title}
          {state ? (
            <>
              {' '}
              <Pill tone={state.tone}>{state.label}</Pill>
            </>
          ) : null}
        </h3>
        <p className="step__do">{entry.do}</p>
        <dl className="step__fields">
          <dt>Why</dt>
          <dd>{entry.why}</dd>
          <dt>Worth</dt>
          <dd>{entry.gain}</dd>
          <dt>Cost</dt>
          <dd>{entry.effort}</dd>
        </dl>
      </div>
    </article>
  )
}

/** One entry in the change history. */
function Change({ entry }) {
  const done = entry.status.startsWith('Implemented') || entry.status.startsWith('Resolved')
  return (
    <li className={`tl__item${done ? '' : ' tl__item--planned'}`}>
      <span className="tl__dot" aria-hidden="true" />
      <div className="tl__card">
        <header className="tl__head">
          <time>{entry.date}</time>
          <h3>{entry.title}</h3>
          <Pill tone={done ? 'green' : 'slate'}>{entry.status}</Pill>
        </header>
        <dl className="tl__body">
          <dt>Problem</dt>
          <dd>{entry.problem}</dd>
          <dt>Change</dt>
          <dd>{entry.change}</dd>
          <dt>Result</dt>
          <dd>{entry.impact}</dd>
        </dl>
      </div>
    </li>
  )
}

/**
 * One article's monthly shipments, as a shape and as the numbers behind it.
 *
 * The tallest month is picked out because that is usually the one doing the
 * damage — an unweighted six-month mean carries a single spike forward for half
 * a year, and seeing which month it was is the first step to deciding whether
 * it was real demand or a one-off.
 */
function Trail({ series }) {
  if (!series?.length) return <span className="muted">–</span>
  const peak = Math.max(...series.map((d) => d.qty), 0)
  return (
    <div className="trail" title={series.map((d) => `${d.month}: ${fmtQty(d.qty)}`).join('\n')}>
      <div className="trail__bars" aria-hidden="true">
        {series.map((d) => (
          <span
            key={d.month}
            className={`trail__bar${peak > 0 && d.qty === peak ? ' trail__bar--peak' : ''}`}
            style={{ height: `${peak > 0 ? Math.max(4, (d.qty / peak) * 100) : 4}%` }}
          />
        ))}
      </div>
      <span className="trail__nums">{series.map((d) => fmtQty(d.qty)).join(' → ')}</span>
    </div>
  )
}

/**
 * One rung of the status ladder: the count leads, the rule explains it.
 *
 * A button rather than a tile, because the point of showing 506 articles in one
 * status is to be able to ask which ones — and the same key filters the table
 * below, so the number on the card and the rows it produces are the same cut.
 */
function StatusCard({ entry, active, onPick }) {
  return (
    <button
      type="button"
      className={`stat stat--${entry.tone}${active ? ' stat--on' : ''}`}
      onClick={onPick}
      aria-pressed={active || undefined}
    >
      <span className="stat__head">
        <span className="stat__dot" aria-hidden="true" />
        <span className="stat__label">{entry.label}</span>
      </span>
      <span className="stat__count">
        {fmtInt(entry.count)}
        <span className="stat__share">{fmtPct(entry.share, 0)}</span>
      </span>
      <span className="stat__crit">{entry.plain}</span>
      <span className="stat__plan">{entry.plan}</span>
    </button>
  )
}

/** The status ladder as a table cell, with the date behind it on hover. */
const STATUS_COLUMN = {
  key: 'statusLabel',
  label: 'Status',
  width: 170,
  render: (v, row) => (
    <span
      title={
        row?.lastShipped
          ? `Last shipped ${row.lastShipped} — ${fmtInt(row.daysIdle ?? 0)} days before the end of this window`
          : 'The warehouse has no record of ever issuing this article'
      }
    >
      <Pill tone={row?.statusTone ?? 'slate'}>{v || '—'}</Pill>
      {row?.thinEvidence ? <span className="ceil__cap"> · one delivery</span> : null}
    </span>
  ),
}

/** How much an article swings, said in words rather than as a coefficient. */
const SWING = (cv) =>
  cv >= CV_ERRATIC
    ? { tone: 'red', label: 'Very unpredictable' }
    : cv >= CV_VOLATILE
      ? { tone: 'amber', label: 'Unpredictable' }
      : cv >= CV_STEADY
        ? { tone: 'blue', label: 'Some variation' }
        : { tone: 'green', label: 'Steady' }

/* ---------------------------------------------------------------- table --- */

const COLUMNS = [
  {
    key: 'name',
    label: 'Article',
    strong: true,
    required: true,
    autoWidth: { min: 160, max: null, percentile: 0.95 },
    wrap: true,
    flex: true,
  },
  {
    key: 'recipe',
    label: 'Type',
    width: 118,
    render: (v) => <Pill tone={v ? 'green' : 'slate'}>{v ? 'Recipe' : 'Non-recipe'}</Pill>,
  },
  STATUS_COLUMN,
  {
    key: 'months',
    label: 'Months shipped',
    autoWidth: true,
    num: true,
    // "2/6" says the demand is on-and-off faster than either number alone.
    render: (v, row) => `${row?.activeMonths ?? 0} of ${v}`,
  },
  {
    key: 'cv',
    label: 'How much it varies',
    autoWidth: true,
    num: true,
    render: (v) => (v ? `±${fmtPct(v, 0)}` : '–'),
  },
  { key: 'forecast', label: 'Forecast', autoWidth: true, num: true, total: 'sum', render: fmtQty, renderTotal: fmtQty },
  { key: 'outbound', label: 'Shipped', autoWidth: true, num: true, total: 'sum', render: fmtQty, renderTotal: fmtQty },
  {
    key: 'variance',
    label: 'Difference',
    autoWidth: true,
    num: true,
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted">–</span>
      ) : (
        <span className={v > 0 ? 'pos' : 'neg'}>
          {v > 0 ? '+' : ''}
          {fmtQty(v)}
        </span>
      ),
  },
  {
    key: 'accuracy',
    label: 'Accuracy',
    autoWidth: true,
    num: true,
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted">–</span>
      ) : (
        <span className={v < 0.2 ? 'neg' : undefined}>{fmtPct(v, 1)}</span>
      ),
  },
  {
    key: 'issue',
    label: 'Why',
    width: 200,
    render: (v) =>
      v ? (
        <span title={v.detail}>
          <Pill tone={v.code === 'stopped' || v.code === 'erratic' ? 'red' : 'amber'}>{v.label}</Pill>
        </span>
      ) : (
        '–'
      ),
  },
]

/**
 * The unpredictable articles, with the evidence for the claim beside it.
 *
 * Deliberately not the same columns as the table below. That one asks "how far
 * out is this?"; this one asks "could it ever have been right?" — so it leads
 * with the months themselves and ends with the ceiling, and a reader can settle
 * the question without knowing what a coefficient of variation is.
 */
const HARD_COLUMNS = [
  {
    key: 'name',
    label: 'Article',
    strong: true,
    required: true,
    autoWidth: { min: 160, max: null, percentile: 0.95 },
    wrap: true,
    flex: true,
  },
  { key: 'brands', label: 'Brand', width: 110, render: (v) => v || <span className="muted">–</span> },
  STATUS_COLUMN,
  {
    /*
     * Keyed on the number of months that actually shipped, not on the series.
     *
     * Every header in this table is a sort button, and an array cannot be
     * ordered meaningfully — so the column sorts on how on-and-off the article
     * is, which puts the articles that ship in bursts together. That is the
     * useful ordering here, and it is the one thing the shape is showing.
     */
    key: 'activeMonths',
    label: 'Month by month',
    width: 190,
    render: (v, row) => <Trail series={row?.series} />,
  },
  {
    key: 'avgMonthly',
    label: 'Average month',
    autoWidth: true,
    num: true,
    render: (v) => (v === null || v === undefined ? <span className="muted">–</span> : fmtQty(v)),
  },
  {
    key: 'cv',
    label: 'How much it swings',
    width: 168,
    num: true,
    render: (v) => {
      const s = SWING(v ?? 0)
      return (
        <span title={`The monthly rate varies by about ${fmtPct(v ?? 0, 0)} around its own average`}>
          <Pill tone={s.tone}>
            {s.label} · ±{fmtPct(v ?? 0, 0)}
          </Pill>
        </span>
      )
    },
  },
  { key: 'forecast', label: 'Forecast', autoWidth: true, num: true, total: 'sum', render: fmtQty, renderTotal: fmtQty },
  { key: 'outbound', label: 'Shipped', autoWidth: true, num: true, total: 'sum', render: fmtQty, renderTotal: fmtQty },
  {
    key: 'accuracy',
    label: 'Accuracy',
    autoWidth: true,
    num: true,
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted">–</span>
      ) : (
        <span className={v < 0.2 ? 'neg' : undefined}>{fmtPct(v, 1)}</span>
      ),
  },
  {
    key: 'reachable',
    label: 'Best possible',
    width: 150,
    num: true,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span className="muted">–</span>
      ) : (
        <span
          className="ceil"
          title={
            'Even a forecast that landed exactly on this article’s own average would score about ' +
            `${fmtPct(v, 0)}, because the article itself moves this much from month to month.`
          }
        >
          {fmtPct(v, 0)}
          {row?.accuracy !== null && row?.accuracy !== undefined && row.accuracy >= v - 0.05 ? (
            <span className="ceil__cap">· at its limit</span>
          ) : null}
        </span>
      ),
  },
]

/* ----------------------------------------------------------------- page --- */

export function WarehouseAnalysis({ filters, ready, refreshNonce, onLoaded }) {
  const request = useMemo(() => ({ ...filters }), [filters])
  const { data, error, loading, reload } = useData(api.warehouseDiagnostics, request, {
    enabled: ready,
    nonce: refreshNonce,
    onLoaded,
  })

  /** What the reader has clicked: `{ type, key, label }`, or null for all. */
  const [pick, setPick] = useState(null)

  const s = data?.summary
  const seg = data?.segments ?? {}
  const articles = data?.articles ?? []

  const issues = useMemo(() => {
    const m = new Map((data?.issues ?? []).map((i) => [i.code, i.count]))
    return (code) => m.get(code) ?? 0
  }, [data])

  /** Open findings and settled ones, decided by each finding's own test. */
  const { open, settled } = useMemo(() => {
    if (!s) return { open: [], settled: [] }
    const open = []
    const settled = []
    for (const f of FINDINGS) (f.check(s, seg, issues) ? open : settled).push(f)
    return { open, settled }
  }, [s, seg, issues])

  /*
   * Group labels as plain fields.
   *
   * Grouping folds on a value, and the values it would otherwise see are codes
   * ("under-20") or objects (the diagnosis). Flattening them here keeps the
   * heading readable without the table having to know what any of them mean.
   */
  const BANDS = {
    'under-20': 'Under 20%',
    '20-40': '20–40%',
    '40-60': '40–60%',
    '60-85': '60–85%',
    '85-100': '85–100%',
  }
  const VOL = {
    steady: 'Steady',
    moderate: 'Moderate',
    volatile: 'Volatile',
    erratic: 'Very volatile',
  }

  const labelled = useMemo(
    () =>
      articles.map((a) => ({
        ...a,
        issueLabel: a.issue?.label ?? '—',
        bandLabel: BANDS[a.keys?.band] ?? 'Not scored',
        volatilityLabel: VOL[a.keys?.volatility] ?? '—',
      })),
    [articles]
  )

  const shown = useMemo(() => {
    if (!pick) return labelled
    return labelled.filter((a) => a.keys?.[pick.type] === pick.key)
  }, [labelled, pick])

  /*
   * The articles nobody could forecast well, worst first.
   *
   * Cut on the server's own volatility key rather than on a threshold repeated
   * here, so this list and the "Volatile"/"Erratic" bars above always hold the
   * same articles. Ranked by the swing itself: the question this table answers
   * is "which of these is hopeless", not "which cost the most units".
   */
  const hardRows = useMemo(
    () =>
      labelled
        .filter((a) => a.keys?.volatility === 'volatile' || a.keys?.volatility === 'erratic')
        .filter((a) => a.accuracy !== null && a.accuracy !== undefined)
        .sort((a, b) => (b.cv ?? 0) - (a.cv ?? 0)),
    [labelled]
  )

  if (error) return <ErrorBanner error={error} onRetry={reload} />
  if (loading && !data) return <ChartSkeleton height={420} />
  if (!s) return <Empty title="No warehouse history in this selection" />

  const u = data.unpredictable
  const c = data.ceiling
  const pat = data.patterns
  const band = (k) => s.bands.find((b) => b.key === k)?.count ?? 0
  const good = band('60-85') + band('85-100')
  const goodShare = s.scored ? good / s.scored : 0
  const steady = seg.volatility?.find((v) => v.key === 'steady')
  const erratic = seg.volatility?.find((v) => v.key === 'erratic')

  const on = (type, key) => pick?.type === type && pick?.key === key
  const choose = (type, key, label) => () =>
    setPick(on(type, key) ? null : { type, key, label })

  const tone = (v) => (v.share >= 0.6 ? 'good' : v.share >= 0.4 ? 'fair' : 'poor')

  /** Every segment bar is a share of its own group, so all run 0–100%. */
  const shareBars = (list, type) =>
    (list ?? []).map((v) => (
      <Bar
        key={v.key}
        label={v.label}
        value={v.share ?? 0}
        display={v.share === null ? '–' : fmtPct(v.share, 0)}
        max={1}
        tone={tone(v)}
        note={`${fmtInt(v.count)} articles · click to see them`}
        active={on(type, v.key)}
        onPick={choose(type, v.key, v.label)}
      />
    ))

  return (
    <>
      <div className="unitrow" style={{ '--cards': 4 }}>
        <MetricCard
          label="Forecast accuracy"
          accent={s.averageAccuracy >= GOOD ? 'green' : 'amber'}
          progress={s.averageAccuracy ?? 0}
          value={s.averageAccuracy === null ? '–' : fmtPct(s.averageAccuracy, 1)}
          foot={`Typical article · ${fmtInt(s.scored)} could be scored`}
        />
        <MetricCard
          label="Articles looked at"
          accent="slate"
          value={fmtInt(s.articles)}
          foot={`${fmtInt(s.unscored)} shipped nothing, so there was nothing to compare`}
        />
        <MetricCard
          label="Forecast vs shipped"
          accent={Math.abs(s.biasPct ?? 0) <= 0.1 ? 'green' : 'amber'}
          value={s.biasPct === null ? '–' : `${s.biasPct > 0 ? '+' : ''}${fmtPct(s.biasPct, 1)}`}
          foot={`${fmtQty(s.totalForecast)} asked for · ${fmtQty(s.totalOutbound)} shipped`}
        />
        <MetricCard
          label="Articles to look at"
          accent={s.lowAccuracy ? 'red' : 'slate'}
          value={fmtInt(s.lowAccuracy)}
          foot={`Under 40% accurate · ${fmtInt(s.stoppedCount)} have stopped shipping`}
        />
      </div>

      <Panel title="What we found" sub="The short version — click any figure below to see the articles behind it">
        <div className="insgrid">
          <Insight tone="green" figure={fmtPct(goodShare, 0)} title="Most articles are forecast well">
            {fmtInt(good)} of {fmtInt(s.scored)} articles are within a reasonable margin. The overall
            number looks worse because a handful of articles are wrong by enormous percentages and
            drag the average down.
          </Insight>

          <Insight
            tone="red"
            figure={steady && erratic ? `${fmtPct(steady.share ?? 0, 0)} → ${fmtPct(erratic.share ?? 0, 0)}` : '–'}
            title="Accuracy falls when demand jumps about"
          >
            Articles that ship a similar amount each month are forecast well. Articles whose amount
            swings around are not. The same method is used for both.
          </Insight>

          <Insight tone="amber" figure={fmtInt(s.stoppedCount)} title="Some articles have stopped selling">
            They shipped for months, then stopped — but the forecast still asks for{' '}
            {fmtQty(s.stoppedForecast)} units, because it only knows the history.
          </Insight>

          {/*
            * The lean used to be repeated here from the card at the top of the
            * page. Replaced on 8 Sep 2026 with the ceiling, which is the fact
            * that changes what somebody should expect from all the others.
            */}
          <Insight
            tone="blue"
            figure={c?.all === null || c?.all === undefined ? '–' : fmtPct(c.all, 0)}
            title="The best any forecast could do"
          >
            A forecast that knew every article&rsquo;s true average and nothing else would score
            this. It is not a target — it is the line no method can go above while these are the
            articles being scored.
          </Insight>
        </div>
      </Panel>

      <Panel
        title="Can we reach 85%?"
        sub="What the target is up against, measured on the articles currently being scored"
      >
        {c ? (
          <>
            <div className="unitrow" style={{ '--cards': 3 }}>
              <MetricCard
                label="Ceiling — every scored article"
                accent={(c.all ?? 0) >= 0.85 ? 'green' : 'red'}
                progress={c.all ?? 0}
                value={c.all === null ? '–' : fmtPct(c.all, 0)}
                foot={`A perfect forecast, averaged over all ${fmtInt(c.allCount)}`}
              />
              <MetricCard
                label="Ceiling — active articles only"
                accent={(c.active ?? 0) >= 0.85 ? 'green' : 'amber'}
                progress={c.active ?? 0}
                value={c.active === null ? '–' : fmtPct(c.active, 0)}
                foot={`The same, over the ${fmtInt(c.activeCount)} still moving`}
              />
              <MetricCard
                label="Ceiling — steady articles only"
                accent={(c.steady ?? 0) >= 0.85 ? 'green' : 'amber'}
                progress={c.steady ?? 0}
                value={c.steady === null ? '–' : fmtPct(c.steady, 0)}
                foot={`The ${fmtInt(c.steadyCount)} that ship a similar amount each month`}
              />
            </div>

            <p className="pnote">
              An article that swings up and down cannot be forecast accurately by anyone, because
              nothing says which month will be the big one. The more it swings, the lower the best
              possible score — and that is arithmetic, not a shortcoming of the method:
            </p>

            <div className="bandchart__rows bandchart__rows--wide">
              {c.curve.map((p) => (
                <Meter
                  key={p.cv}
                  label={`±${fmtPct(p.cv, 0)}`}
                  value={p.best}
                  display={fmtPct(p.best, 0)}
                  max={1}
                  tone={p.best >= 0.85 ? 'good' : p.best >= 0.6 ? 'fair' : 'poor'}
                  note={`An article swinging ±${fmtPct(p.cv, 0)} month to month can score at best ${fmtPct(p.best, 0)}`}
                />
              ))}
            </div>

            <p className="pnote">
              Reading it the other way round: <strong>85% needs articles that swing less than about
              ±{fmtPct(c.swingFor85, 0)} a month.</strong>{' '}
              {c.typicalSwing !== null && c.typicalSwing !== undefined ? (
                <>
                  The typical article here swings <strong>±{fmtPct(c.typicalSwing, 0)}</strong>. That
                  gap is the whole problem, and it is closed by choosing which articles are in the
                  average and by matching the method to the demand pattern — not by a better formula
                  applied to everything.
                </>
              ) : null}
            </p>
          </>
        ) : (
          <Empty title="Not enough scored articles to work out a ceiling" />
        )}
      </Panel>

      <div className="whgrid">
        <Panel title="How accurate is each article" sub="Click a band to see those articles">
          <div className="bandchart__rows bandchart__rows--wide">
            {s.bands.map((b) => (
              <Bar
                key={b.key}
                label={b.label}
                value={b.count}
                display={fmtInt(b.count)}
                max={Math.max(1, ...s.bands.map((x) => x.count))}
                tone={b.key === 'under-20' || b.key === '20-40' ? 'poor' : b.key === '40-60' ? 'fair' : 'good'}
                note={`${fmtInt(b.count)} articles · click to see them`}
                active={on('band', b.key)}
                onPick={choose('band', b.key, `Accuracy ${b.label}`)}
              />
            ))}
          </div>
          <p className="pnote">
            Two groups, not one: most articles do well, and a smaller group does badly. An average
            of the two describes neither.
          </p>
        </Panel>

        <Panel title="Are we ordering too much or too little" sub="Click a bar to see those articles">
          <div className="bandchart__rows bandchart__rows--wide">
            <Bar
              label="Too much"
              value={s.overShare}
              display={fmtPct(s.overShare, 0)}
              max={1}
              tone="fair"
              note={`${fmtInt(s.overCount)} articles · click to see them`}
              active={on('direction', 'over')}
              onPick={choose('direction', 'over', 'Ordered too much')}
            />
            <Bar
              label="About right"
              value={s.closeShare}
              display={fmtPct(s.closeShare, 0)}
              max={1}
              tone="good"
              note="Within 10% either way · click to see them"
              active={on('direction', 'close')}
              onPick={choose('direction', 'close', 'About right')}
            />
            <Bar
              label="Too little"
              value={s.underShare}
              display={fmtPct(s.underShare, 0)}
              max={1}
              tone="poor"
              note={`${fmtInt(s.underCount)} articles · click to see them`}
              active={on('direction', 'under')}
              onPick={choose('direction', 'under', 'Ordered too little')}
            />
          </div>

          <div className="bandchart__rows bandchart__rows--wide split__totals">
            <Bar label="Asked for" value={s.totalForecast} display={fmtQty(s.totalForecast)} max={Math.max(s.totalForecast, s.totalOutbound)} tone="fair" />
            <Bar label="Shipped" value={s.totalOutbound} display={fmtQty(s.totalOutbound)} max={Math.max(s.totalForecast, s.totalOutbound)} tone="good" />
          </div>
          <p className="pnote">
            Altogether we asked for {fmtQty(Math.abs(s.totalVariance))} units{' '}
            {s.totalVariance > 0 ? 'more' : 'less'} than the warehouse shipped.
          </p>
        </Panel>
      </div>

      <Panel
        title="What makes the difference"
        sub="How many articles are forecast well, grouped four ways. Click any bar to see them."
      >
        <div className="segrid">
          <section className="seg">
            <h4>By how much demand varies</h4>
            <div className="bandchart__rows bandchart__rows--wide">{shareBars(seg.volatility, 'volatility')}</div>
            <p className="pnote">The clearest pattern on the page — and the one the method ignores.</p>
          </section>

          <section className="seg">
            <h4>By how long we have shipped it</h4>
            <div className="bandchart__rows bandchart__rows--wide">{shareBars(seg.history, 'history')}</div>
            <p className="pnote">Almost no difference. More history does not help; steady demand does.</p>
          </section>

          <section className="seg">
            <h4>By how much ships</h4>
            <div className="bandchart__rows bandchart__rows--wide">{shareBars(seg.volume, 'volume')}</div>
            <p className="pnote">
              Small articles look worse, but mostly because a single case is a big percentage of a
              small number.
            </p>
          </section>

          <section className="seg">
            <h4>Recipe against non-recipe</h4>
            <div className="bandchart__rows bandchart__rows--wide">{shareBars(seg.recipe, 'recipe')}</div>
            <p className="pnote">
              Barely any difference, which matters: the problem is how demand behaves, not where the
              requirement comes from.
            </p>
          </section>
        </div>
      </Panel>

      <Panel
        title="Article status"
        sub={
          'Every article by how long since the warehouse last issued it' +
          (data.classifiedAt ? ` · as at ${data.classifiedAt}` : '') +
          ' · click a status to see those articles'
        }
      >
        <div className="statgrid">
          {(data.statuses ?? [])
            .filter((e) => e.count > 0 || e.key !== 'never-shipped')
            .map((e) => (
              <StatusCard
                key={e.key}
                entry={e}
                active={on('status', e.key)}
                onPick={choose('status', e.key, e.label)}
              />
            ))}
        </div>
        <p className="pnote">
          These are the statuses from <strong>Swish SPS V3 2026</strong>, not ones invented here.
          &ldquo;Current + 2 Months&rdquo; means nothing shipped for two months and the current one,
          counted in rolling days so an article does not change status merely because a new month
          began. The last group is a <strong>proposal for somebody to review</strong> — nothing is
          deactivated automatically, and nothing here changes what is forecast yet.
        </p>
      </Panel>

      {pat ? (
        <Panel
          title="How often articles actually ship"
          sub={`Measured over the ${pat.weeks} weeks to ${pat.to}, across ${fmtInt(pat.articles)} articles the warehouse issued in that time`}
        >
          <div className="insgrid">
            <Insight
              tone="amber"
              figure={pat.zeroShare === null ? '–' : fmtPct(pat.zeroShare, 0)}
              title="of article-weeks had no shipment at all"
            >
              {fmtInt(pat.zeroWeeks)} silent weeks out of {fmtInt(pat.articleWeeks)}. This is not
              missing data — it is what the demand looks like. Predicting a zero correctly is as
              much a part of accuracy as predicting a quantity.
            </Insight>

            <Insight tone="blue" figure="Why?" title="A zero can mean six different things">
              It was not needed · the shop already had stock · this is not an ordering day · the
              article only moves occasionally · it is seasonal · it has stopped moving for good.
              Only the first is a genuine forecast miss. The rest are predictable once we know
              which is which.
            </Insight>

            <Insight
              tone="green"
              figure={fmtInt(pat.regularity.find((r) => r.key === 'intermittent')?.count ?? 0)}
              title="articles ship only occasionally"
            >
              These do not have a weekly demand. They have a frequency and an order size — ordered
              every few weeks, and a batch when they are. An average is too high on the quiet weeks
              and too low on the ordering week.
            </Insight>
          </div>

          <div className="segrid">
            <section className="seg">
              <h4>How regularly each article ships</h4>
              <div className="bandchart__rows bandchart__rows--wide">
                {pat.regularity.map((r) => (
                  <Meter
                    key={r.key}
                    label={r.label}
                    value={r.count}
                    display={fmtInt(r.count)}
                    max={Math.max(1, ...pat.regularity.map((x) => x.count))}
                    tone={r.key === 'regular' ? 'good' : r.key === 'irregular' ? 'fair' : 'poor'}
                    note={`${r.note} — ${r.plan}`}
                  />
                ))}
              </div>
              <p className="pnote">
                Hover any bar for what it means. The further down this list an article sits, the
                less an average describes it — which is the case for forecasting occasional
                articles as <strong>how often × how much</strong> instead.
              </p>
            </section>

            <section className="seg">
              <h4>The same thing, as an example</h4>
              <div className="egpair">
                <div className="eg">
                  <span className="eg__tag">Steady demand</span>
                  <span className="eg__nums">100 → 110 → 105 → 95</span>
                  <span className="eg__note">An average of 102 is right every week.</span>
                </div>
                <div className="eg eg--alt">
                  <span className="eg__tag">Occasional demand</span>
                  <span className="eg__nums">0 → 0 → 80 → 0 → 0 → 100</span>
                  <span className="eg__note">
                    An average of 30 is wrong every single week. What is true is: ordered about
                    every third week, around 90 units at a time.
                  </span>
                </div>
              </div>
            </section>
          </div>
        </Panel>
      ) : null}

      {pat?.weekday ? (
        <Panel
          title="Which days articles ship on"
          sub="Spreading a forecast evenly across the week guarantees a miss when an article only ships on one day"
        >
          <div className="segrid">
            <section className="seg">
              <h4>When the warehouse ships, overall</h4>
              <div className="bandchart__rows bandchart__rows--wide">
                {pat.weekday.overall.map((d) => (
                  <Meter
                    key={d.key}
                    label={d.label}
                    value={d.share}
                    display={fmtPct(d.share, 0)}
                    max={Math.max(0.01, ...pat.weekday.overall.map((x) => x.share))}
                    tone="good"
                    note={`${d.key} — ${fmtQty(d.qty)} units`}
                  />
                ))}
              </div>
              <p className="pnote">
                Across everything the pattern is mild. Per article it is not, which is the point.
              </p>
            </section>

            <section className="seg">
              <h4>How concentrated each article is</h4>
              <div className="bandchart__rows bandchart__rows--wide">
                {pat.weekday.concentration.map((k) => (
                  <Meter
                    key={k.key}
                    label={k.label}
                    value={k.count}
                    display={fmtInt(k.count)}
                    max={Math.max(1, ...pat.weekday.concentration.map((x) => x.count))}
                    tone={k.key === 'spread' ? 'good' : k.key === 'leaning' ? 'fair' : 'poor'}
                    note={k.note}
                  />
                ))}
              </div>
              <p className="pnote">
                An article with more than half its volume on one weekday is forecast something on
                every other day and misses each time. This costs most on{' '}
                <strong>short windows</strong> — a day, a week, month-to-date. Over a full month it
                moves quantity around inside the window and barely changes the total.
              </p>
            </section>
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Articles that are naturally hard to forecast"
        count={hardRows.length}
        sub="Not a forecasting mistake — these articles move too much from month to month for any forecast to follow"
      >
        {hardRows.length ? (
          <>
            <div className="insgrid">
              <Insight
                tone="amber"
                figure={`${fmtInt(u?.count ?? hardRows.length)} of ${fmtInt(s.scored)}`}
                title="Articles that jump about"
              >
                Their shipments change by more than {fmtPct(u?.threshold ?? 0.6, 0)} from one month
                to the next. That is {fmtPct(u?.share ?? 0, 0)} of everything we can score.
              </Insight>

              <Insight
                tone="blue"
                figure={
                  u?.averageAccuracy === null || u?.averageAccuracy === undefined
                    ? '–'
                    : `${fmtPct(u.averageAccuracy, 0)} → ${fmtPct(u.reachable ?? 0, 0)}`
                }
                title="Scoring now, against the best possible"
              >
                The second number is what a perfect forecast would score on these articles. The gap
                between the two is all we could ever win back by forecasting better.
              </Insight>

              <Insight
                tone="green"
                figure={
                  u?.averageWithout === null || u?.averageWithout === undefined
                    ? '–'
                    : fmtPct(u.averageWithout, 0)
                }
                title="What the rest score without them"
              >
                Set these {fmtInt(u?.count ?? 0)} aside and the remaining {fmtInt(u?.restCount ?? 0)}{' '}
                articles score this. The headline is being held down by articles that cannot be
                forecast, not by the method used on the ones that can.
              </Insight>
            </div>

            <p className="pnote">
              <strong>Why is this article difficult to forecast?</strong> Look at the month-by-month
              column. An article that ships 100, then 20, then 250, then 50 has no pattern to follow
              — the forecast lands on the average and every month is a long way from it. An article
              that ships 100, 105, 95, 110 is easy. Nothing in our data says which month will be the
              big one, so the &ldquo;best possible&rdquo; column is a ceiling, not a target. Where
              accuracy already sits at that ceiling, the forecast is working correctly and the
              article is simply unpredictable — those need a different plan, not a better formula.
            </p>

            <DataTable
              columns={HARD_COLUMNS}
              rows={hardRows}
              tableId="wh-analysis-hard"
              groupable={[
                { key: 'volatilityLabel', label: 'How much demand varies' },
                { key: 'statusLabel', label: 'Status' },
                { key: 'brands', label: 'Brand' },
                { key: 'issueLabel', label: 'Why it is off' },
                { key: 'recipe', label: 'Recipe / non-recipe' },
                { key: 'unit', label: 'Unit' },
              ]}
              maxHeight={560}
              totals
              initialSort={{ key: 'cv', dir: 'desc' }}
              searchPlaceholder="Search an article…"
            />

            <p className="pnote">
              Shown per article across every brand it reaches. The warehouse copy records what
              shipped and on which day, but not which branch it went to, so there is no location
              column to give — that mapping is still unsettled.
            </p>
          </>
        ) : (
          <Empty title="Nothing here is badly behaved">
            Every article that could be scored moves steadily enough for a forecast to follow.
          </Empty>
        )}
      </Panel>

      <Panel title="Why each article is off" sub="One reason per article, chosen by what to do about it. Click to see them.">
        <div className="bandchart__rows bandchart__rows--wide">
          {(data.issues ?? []).map((i) => (
            <Bar
              key={i.code}
              label={i.label}
              value={i.count}
              display={fmtInt(i.count)}
              max={Math.max(1, ...(data.issues ?? []).map((x) => x.count))}
              tone={i.code === 'ok' ? 'good' : i.code === 'low-volume' || i.code === 'drift' ? 'fair' : 'poor'}
              note={`${fmtInt(i.count)} articles · click to see them`}
              active={on('issue', i.code)}
              onPick={choose('issue', i.code, i.label)}
            />
          ))}
        </div>
      </Panel>

      <Panel
        title={pick ? `Articles — ${pick.label}` : 'All articles'}
        count={shown.length}
        sub={
          pick
            ? 'Filtered by the bar you clicked. Clear it to see everything again.'
            : 'Click any bar above to narrow this list to the articles behind it.'
        }
        tools={
          pick ? (
            <button type="button" className="btn btn--ghost" onClick={() => setPick(null)}>
              Clear filter
            </button>
          ) : null
        }
      >
        {shown.length ? (
          <DataTable
            columns={COLUMNS}
            rows={shown}
            tableId="wh-analysis-articles"
            groupable={[
              { key: 'statusLabel', label: 'Status' },
              { key: 'recipe', label: 'Recipe / non-recipe' },
              { key: 'issueLabel', label: 'Why it is off' },
              { key: 'bandLabel', label: 'Accuracy band' },
              { key: 'volatilityLabel', label: 'How much demand varies' },
              { key: 'unit', label: 'Unit' },
            ]}
            maxHeight={620}
            totals
            initialSort={{ key: 'variance', dir: 'desc' }}
            searchPlaceholder="Search an article…"
          />
        ) : (
          <Empty title="No articles in this group" />
        )}
      </Panel>

      <Panel
        title="What to fix"
        count={open.length}
        sub="Only problems that are still present. Anything fixed drops off this list on its own."
      >
        {open.length ? (
          <div className="issgrid">
            {open.map((f) => (
              <article key={f.id} className="iss">
                <header className="iss__head">
                  <Pill tone={SEVERITY[f.severity] ?? 'slate'}>{f.severity}</Pill>
                  <h3>{f.title}</h3>
                </header>
                <dl className="iss__body">
                  <dt>What happens</dt>
                  <dd>{f.plain}</dd>
                  <dt>Why</dt>
                  <dd>{f.why}</dd>
                  <dt>How big</dt>
                  <dd>{f.cost(s, seg, issues)}</dd>
                  <dt>Affects</dt>
                  <dd>{f.affects}</dd>
                  <dt>What to do</dt>
                  <dd className="iss__fix">{f.fix}</dd>
                </dl>
                {f.filter && (
                  <button
                    type="button"
                    className="btn btn--ghost iss__see"
                    onClick={() => setPick({ ...f.filter, label: f.title })}
                  >
                    See the articles
                  </button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty title="Nothing outstanding">
            Every problem this page checks for has been resolved for the current selection.
          </Empty>
        )}
      </Panel>

      <Panel
        title="What we tested and ruled out"
        count={RULED_OUT.length}
        sub="Sensible theories that were measured and did not hold — kept so they are not proposed again"
      >
        <div className="issgrid">
          {RULED_OUT.map((r) => (
            <article key={r.id} className="iss iss--ruled">
              <header className="iss__head">
                <Pill tone="slate">Ruled out</Pill>
                <h3>{r.title}</h3>
              </header>
              <dl className="iss__body">
                <dt>The idea</dt>
                <dd>{r.theory}</dd>
                <dt>How we checked</dt>
                <dd>{r.test}</dd>
                <dt>What came back</dt>
                <dd>{r.result}</dd>
                <dt>So</dt>
                <dd>
                  <strong>{r.verdict}</strong>
                </dd>
              </dl>
            </article>
          ))}
        </div>
      </Panel>

      <Panel
        title="The plan to 85%"
        count={ROUTE.filter((r) => r.state !== 'done').length}
        sub="What to do, in the priority agreed on 8 September — with what is already finished marked as such"
      >
        <ol className="steps">
          {ROUTE.map((r) => (
            <Step key={r.step} entry={r} />
          ))}
        </ol>
      </Panel>

      <Panel title="What has changed" sub="Fixes already made, and problems that have since cleared">
        <ol className="tl">
          {settled.map((f) => (
            <Change
              key={f.id}
              entry={{
                date: 'Now',
                status: 'Resolved',
                title: f.title,
                problem: f.plain,
                change: f.fix,
                impact: f.resolvedNote,
              }}
            />
          ))}
          {CHANGES.map((c) => (
            <Change key={c.title} entry={c} />
          ))}
        </ol>
      </Panel>
    </>
  )
}
