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
  {
    id: 'thin-history',
    severity: 'Medium',
    title: 'New articles are forecast from very little',
    plain:
      'An article with one or two months of deliveries gets a forecast built on those months alone, which is closer to a guess than a rate.',
    why: 'An average of one or two numbers is just those numbers. There is no pattern yet to find.',
    affects: 'Newly listed articles and seasonal ones returning after a gap.',
    cost: (s, seg, issues) => `${fmtInt(issues('thin-history'))} articles have under three months of history.`,
    fix:
      'For recipe articles, use the menu forecast instead — that is a real signal. For others, hold off until there is enough history to average.',
    check: (s, seg, issues) => issues('thin-history') > 0,
    resolvedNote: 'Every article being forecast has enough history to average.',
    filter: { type: 'issue', key: 'thin-history' },
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

  if (error) return <ErrorBanner error={error} onRetry={reload} />
  if (loading && !data) return <ChartSkeleton height={420} />
  if (!s) return <Empty title="No warehouse history in this selection" />

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

          <Insight
            tone="blue"
            figure={`${s.biasPct > 0 ? '+' : ''}${fmtPct(s.biasPct ?? 0, 1)}`}
            title="The misses lean one way"
          >
            {fmtPct(s.overShare, 0)} of articles are over-ordered and {fmtPct(s.underShare, 0)} under.
            A consistent lean means the method is off, not that the world is unpredictable.
          </Insight>
        </div>
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
