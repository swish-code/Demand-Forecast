/**
 * Warehouse Insights — the warehouse's own forecast, measured against what it
 * actually issued.
 *
 * Every article figure on this page comes from `/api/component-level`: the same
 * endpoint, the same filters and the same rows the Stock Article page draws. It
 * is not a second view of the warehouse built from a second calculation — it is
 * the same numbers aggregated differently, which is the only arrangement where
 * "do the two pages agree?" cannot become a question worth asking.
 *
 * Only the daily series comes from elsewhere (`/api/warehouse-trend`), because a
 * trend needs a grain the table does not have. That endpoint decomposes the same
 * window forecast across days by each day's share of forecast sales, so its
 * total is the window total by construction rather than by coincidence.
 */
import { useMemo, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, fmtInt, fmtQty, fmtPct, fmtDate, downloadCsv } from '../api.js'
import { useData } from '../useData.js'
import { DataTable } from '../components/DataTable.jsx'
import {
  ChartSkeleton,
  Empty,
  ErrorBanner,
  InfoBanner,
  MetricCard,
  Panel,
  Pill,
} from '../components/ui.jsx'
import { W } from '../columns.js'

/**
 * The accuracy bands, and the one measure they are cut on.
 *
 * Identical to the Stock Article page's, deliberately — an article in the 0–20%
 * band there is in the 0–20% band here. Banded on WH ACC% and nothing else: not
 * forecast accuracy, not sales accuracy, which are different measures over
 * different populations.
 */
const BANDS = [
  // Open-ended at the bottom, so an article that fell off the scale is counted.
  { key: '0-20', label: 'Under 20%', lo: -Infinity, hi: 0.2 },
  { key: '20-40', label: '20–40%', lo: 0.2, hi: 0.4 },
  { key: '40-60', label: '40–60%', lo: 0.4, hi: 0.6 },
  { key: '60-85', label: '60–85%', lo: 0.6, hi: 0.85 },
  { key: '85-100', label: '85–100%', lo: 0.85, hi: 1.0001 },
]

/*
 * The same explainer the Stock Article table carries, for the columns that
 * differ here — this table adds Variance, and its reader is asking a warehouse
 * question rather than a demand one.
 */
const HELP_WH = [
  {
    term: 'WH forecast',
    text: 'What the warehouse would be expected to ship, based on how much it has shipped per unit sold.',
    formula: `Step 1 — for each of the last 6 whole months: units the warehouse shipped ÷ that brand’s sales that month. That is a rate.
Step 2 — average those 6 rates.
Step 3 — multiply by the forecast sales for the dates on screen.`,
    example:
      'Shipped 2,000 in a month the brand sold 100,000 → a rate of 0.02. If we forecast 150,000 sales, the warehouse forecast is 3,000.',
  },
  {
    term: 'Outbound',
    text: 'What actually left the Central Warehouse for the shops.',
    formula:
      'Add up the quantity on every transfer where the source is the Central Warehouse, the destination is anywhere except the warehouse itself, and the status is Booked, Delivered or Declined. Dated on the requested delivery date.',
    example:
      'A dash means the warehouse has never shipped this article to this brand. A zero means it normally does and did not this time.',
  },
  {
    term: 'Variance',
    text: 'How many units out we were, and in which direction.',
    formula: 'WH forecast − Outbound',
    example: 'Forecast 3,000, shipped 2,500 → +500, meaning we expected more than moved.',
  },
  {
    term: 'WH ACC%',
    text: 'How close the warehouse forecast was to what actually shipped.',
    formula: '1 − ( difference between WH forecast and Outbound ÷ whichever of the two is larger )',
    example:
      'Forecast 8, shipped 10 → 1 − (2 ÷ 10) = 80%. Always between 0% and 100%: equal is 100%, one side twice the other is 50%, nothing shipped against a real forecast is 0%.',
  },
  {
    term: 'Why it can look wrong',
    text: 'The warehouse ships in full cases on an ordering cycle, so a short date range catches one delivery or none.',
    example: 'Judge this over a full month; under about three weeks it is mostly noise.',
  },
]

const inBand = (v, b) => v !== null && v !== undefined && v >= b.lo && v < b.hi

/** Under 40% is what "low accuracy" means everywhere on this page. */
const LOW = 0.4

const COLUMNS = [
  {
    key: 'Item',
    label: 'Article',
    strong: true,
    required: true,
    // The Stock Article table's rule, unchanged: sized to 95% of the names, and
    // the few longer ones wrap rather than being cut off.
    autoWidth: { min: 140, max: null, percentile: 0.95 },
    wrap: true,
    // The column that absorbs whatever width is left over, so the table always
    // ends flush with its panel instead of trailing off into white.
    flex: true,
  },
  { key: 'CHAINID', label: 'Brand', width: W.brand },
  /*
   * No location column, and it is worth saying why rather than shipping an
   * empty one.
   *
   * Outbound is known per brand, not per shop: the transfer records name
   * destinations and the forecast uses branch codes, and the two lists do not
   * yet correspond. Asking this endpoint to split by branch makes it return a
   * blank outbound for every row — deliberately, because attributing a brand's
   * whole consumption to one branch would be a wrong number rather than a
   * missing one. A Location column here could therefore only ever be empty or
   * wrong, so there isn't one.
   */
  {
    key: 'Supply',
    label: 'Supply',
    width: 118,
    render: (v) =>
      v ? (
        <Pill tone={v === 'Warehouse' ? 'green' : 'slate'}>{v}</Pill>
      ) : (
        <span className="muted" title="No article number, so there is nothing to look up">
          –
        </span>
      ),
  },
  {
    key: 'WH_Constant_Forecast_Qty',
    label: 'WH forecast',
    autoWidth: true,
    num: true,
    group: 'wh',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No warehouse history for this article in the last six months, so there is no rate to forecast from."
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
  },
  {
    key: 'Consumed_Qty',
    label: 'Outbound',
    autoWidth: true,
    num: true,
    strong: true,
    group: 'wh',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title={
            row?.Consumed_Unknown
              ? 'The warehouse has never issued this article to this brand, so there is nothing to measure.'
              : 'Not known for this selection.'
          }
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
  },
  {
    key: 'Variance',
    label: 'Variance',
    autoWidth: true,
    num: true,
    group: 'wh',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted">–</span>
      ) : (
        <span className={v > 0 ? 'pos' : v < 0 ? 'neg' : undefined}>
          {v > 0 ? '+' : ''}
          {fmtQty(v)}
        </span>
      ),
  },
  {
    key: 'WH_Accuracy',
    label: 'WH ACC%',
    autoWidth: true,
    num: true,
    group: 'wh',
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Nothing to compare: either the warehouse has no history for this article, or nothing was forecast and nothing moved."
        >
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    // Averaged per article, not derived from the column totals: each score is
    // already a unit-free ratio, and totalling first would let the millions of
    // "Each" decide the answer for kilograms too.
    total: (list) => {
      const scored = list.filter((r) => r.WH_Accuracy !== null && r.WH_Accuracy !== undefined)
      if (!scored.length) return null
      return scored.reduce((a, r) => a + r.WH_Accuracy, 0) / scored.length
    },
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },
  { key: 'Item No.', label: 'Article No.', width: 104, hiddenByDefault: true },
  { key: 'Node Type', label: 'Type', width: 96, hiddenByDefault: true },
  { key: 'BU', label: 'Unit', autoWidth: true, hiddenByDefault: true },
]

/**
 * A short ranked list of articles worth looking at.
 *
 * Bars against the leader rather than against a total: these lists are eight
 * rows out of thousands, so a share of the whole would be eight slivers.
 */
function Attention({ title, sub, rows, valueOf, format, tone }) {
  const peak = Math.max(1, ...rows.map((r) => Math.abs(valueOf(r))))
  return (
    <Panel title={title} sub={sub} count={rows.length} calc="wh-acc,variance">
      {rows.length ? (
        <ol className="attn">
          {rows.map((r) => (
            <li key={r.__key} className="attn__row">
              <span className="attn__name" title={r.Item}>
                {r.Item}
              </span>
              <span className="attn__bar">
                <span
                  className={`attn__fill attn__fill--${tone}`}
                  style={{ width: `${(Math.abs(valueOf(r)) / peak) * 100}%` }}
                />
              </span>
              <span className="attn__value">{format(valueOf(r))}</span>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="Nothing to show">No articles match this selection.</Empty>
      )}
    </Panel>
  )
}

export function WarehouseInsights({ filters, ready, refreshNonce, onLoaded }) {
  /*
   * Split by brand, because the brand is a column here.
   *
   * Without it the endpoint merges an article across brands — a component in
   * two brands is one thing to order — and the brand column would then have no
   * single answer to give. Split, each row belongs to one brand and the totals
   * still add to the same figure.
   */
  const request = useMemo(() => ({ ...filters, grain: ['brand'] }), [filters])

  /*
   * The same request the Stock Article page makes, so the two share a cache
   * entry as well as a calculation: switching between the pages costs nothing
   * and cannot return different numbers.
   */
  const { data, error, loading: busy, reload } = useData(api.componentLevel, request, {
    enabled: ready,
    nonce: refreshNonce,
    onLoaded,
  })
  const trend = useData(api.warehouseTrend, request, { enabled: ready, nonce: refreshNonce })
  const soh = useData(api.sohTrend, request, { enabled: ready, nonce: refreshNonce })
  const runRate = useData(api.salesRunRate, request, { enabled: ready, nonce: refreshNonce })

  const [band, setBand] = useState(null)
  const [view, setView] = useState(null)

  const rows = data?.rows ?? []

  /*
   * The latest week's stock reading, for the three cards.
   *
   * Taken from the last week that could be scored rather than the last week in
   * the range: a part-week at the end has a full stock figure against partial
   * outbound, which reads as a sudden collapse in usage that did not happen.
   */
  /** The run-rate cards, worded so a part-month never reads as a collapse. */
  const rr = useMemo(() => {
    const s = runRate.data?.summary
    const cur = s?.current ?? null
    const pace = s?.pace ?? null
    return {
      soFar: cur ? fmtQty(cur.soFar) : '–',
      soFarFoot: cur ? `${cur.days} of ${cur.daysInMonth} days · ${cur.month}` : 'No month in progress',
      runRate: cur?.runRate ? fmtQty(cur.runRate) : '–',
      previous: s?.previous ? fmtQty(s.previous.total) : '–',
      previousFoot: s?.previous ? s.previous.month : 'None complete yet',
      pace: pace === null ? '–' : `${pace > 0 ? '+' : ''}${fmtPct(pace, 1)}`,
      paceTone: pace === null ? 'slate' : pace >= 0 ? 'green' : 'amber',
    }
  }, [runRate.data])

  const sohRead = useMemo(() => {
    const weeks = (soh.data?.weeks ?? []).filter((w) => w.cover !== null)
    const last = weeks.length ? weeks[weeks.length - 1] : null
    const cover = soh.data?.summary?.latest?.cover ?? last?.cover ?? null
    return {
      cover: cover === null ? '–' : fmtPct(cover, 0),
      // Under half a week of cover is where the shortfall showed up in testing.
      tone: cover === null ? 'slate' : cover > 1 ? 'red' : cover > 0.5 ? 'amber' : 'green',
      shortCount: last?.short ?? 0,
      dryCount: last?.dry ?? 0,
    }
  }, [soh.data])

  /*
   * One row per article, rolled up and scored exactly as Stock Article does it.
   *
   * The endpoint returns a row per recipe group, so an article used by four
   * recipes arrives four times with its warehouse figures on one of them. Both
   * sides have to be added back up before they can be compared — the warehouse
   * issues flour, not flour-for-the-burger — and this roll-up is what every
   * figure on the page is built from, cards included.
   */
  const articles = useMemo(() => {
    const byArticle = new Map()

    for (const r of rows) {
      const article = String(r['Item No.'] ?? '').trim() || String(r.Item ?? '')
      if (!article) continue
      // Keyed on brand as well, so an article used by two brands stays two
      // rows — which is what the brand column is for.
      const key = `${r.CHAINID ?? ''}|${article}`

      let held = byArticle.get(key)
      if (!held) {
        held = {
          __key: key,
          Item: r.Item,
          'Item No.': r['Item No.'] ?? '',
          BU: r.BU ?? '',
          'Node Type': r['Node Type'] ?? '',
          CHAINID: r.CHAINID ?? '',
          Supply: r.Supply ?? null,
          WH_Constant_Forecast_Qty: null,
          Consumed_Qty: null,
          Consumed_Unknown: Boolean(r.Consumed_Unknown),
        }
        byArticle.set(key, held)
      }

      if (r.WH_Constant_Forecast_Qty !== null && r.WH_Constant_Forecast_Qty !== undefined) {
        held.WH_Constant_Forecast_Qty =
          (held.WH_Constant_Forecast_Qty ?? 0) + (Number(r.WH_Constant_Forecast_Qty) || 0)
      }
      if (r.Consumed_Qty !== null && r.Consumed_Qty !== undefined) {
        held.Consumed_Qty = (held.Consumed_Qty ?? 0) + (Number(r.Consumed_Qty) || 0)
        held.Consumed_Unknown = false
      }
      if (!held.Supply && r.Supply) held.Supply = r.Supply
      if (!held.CHAINID && r.CHAINID) held.CHAINID = r.CHAINID
    }

    return [...byArticle.values()].map((a) => {
      const f = a.WH_Constant_Forecast_Qty
      const o = a.Consumed_Qty
      const measured = o !== null && o !== undefined && f !== null
      return {
        ...a,
        // Variance as asked: forecast minus what actually left. Positive is
        // over-forecast, negative under-forecast, and blank where one side is
        // missing rather than a difference against nothing.
        Variance: measured ? f - o : null,
        /*
         * WH ACC%, the same expression the Stock Article page uses.
         *
         * Symmetric — divided by the larger of the two — so equal quantities
         * score 100%, one side double the other scores 50%, and a real forecast
         * against nothing issued scores 0%.
         *
         * Blank where there is nothing to compare: no warehouse history for the
         * article, or an article the warehouse has never issued to this brand.
         * Blank is not zero. It is excluded from every count and average here,
         * because scoring "we have no evidence" as a total failure is what made
         * this measure unreadable before.
         */
        /*
         *   1 − |Forecast − Actual| / MAX(Forecast, Actual)
         *
         * Symmetric and bounded 0–1: equal quantities score 100%, one side
         * twice the other scores 50%, and a real forecast against nothing
         * issued scores 0%. Blank only where there is nothing to compare.
         */
        WH_Accuracy: measured && Math.max(o, f) > 0 ? 1 - Math.abs(f - o) / Math.max(o, f) : null,
      }
    })
  }, [rows])

  const bandCounts = useMemo(() => {
    const counts = new Map(BANDS.map((b) => [b.key, 0]))
    for (const a of articles) {
      for (const b of BANDS) {
        if (inBand(a.WH_Accuracy, b)) {
          counts.set(b.key, counts.get(b.key) + 1)
          break
        }
      }
    }
    return counts
  }, [articles])

  const banded = useMemo(() => {
    if (!band) return articles
    const b = BANDS.find((x) => x.key === band)
    return b ? articles.filter((a) => inBand(a.WH_Accuracy, b)) : articles
  }, [articles, band])

  /*
   * What the table is showing, fed back to everything above it.
   *
   * The search box lives inside the table and the band chart narrows it; a card
   * that ignores the filter beside it is a card nobody can trust. The table
   * already reports its visible rows for the CSV export, and the same set
   * answers this.
   */
  const shownKeys = useMemo(() => {
    if (!view?.rows) return null
    return new Set(view.rows.map((r) => r.__key))
  }, [view])

  const focused = useMemo(
    () => (shownKeys ? banded.filter((a) => shownKeys.has(a.__key)) : banded),
    [banded, shownKeys]
  )

  const kpi = useMemo(() => {
    let forecast = 0
    let outbound = 0
    let scoredForecast = 0
    let scoredOutbound = 0
    let scored = 0
    let withOutbound = 0
    let low = 0

    for (const a of focused) {
      forecast += Number(a.WH_Constant_Forecast_Qty) || 0
      if (a.Consumed_Qty !== null && a.Consumed_Qty !== undefined) {
        outbound += Number(a.Consumed_Qty) || 0
        if (Number(a.Consumed_Qty) > 0) withOutbound += 1
      }
      /*
       * The headline accuracy is measured over the articles it can score, and
       * both of its totals come from that same set. Comparing a forecast for
       * one population against outbound for another is how a card ends up
       * reporting how often it ran off its own scale.
       */
      if (a.WH_Accuracy !== null) {
        scored += 1
        scoredForecast += Number(a.WH_Constant_Forecast_Qty) || 0
        scoredOutbound += Number(a.Consumed_Qty) || 0
        if (a.WH_Accuracy < LOW) low += 1
      }
    }

    return {
      forecast,
      outbound,
      articles: focused.length,
      withOutbound,
      scored,
      low,
      accuracy:
        scored && Math.max(scoredOutbound, scoredForecast) > 0
          ? 1 -
            Math.abs(scoredForecast - scoredOutbound) /
              Math.max(scoredOutbound, scoredForecast)
          : null,
    }
  }, [focused])

  const supplySplit = useMemo(() => {
    const groups = new Map([
      ['Warehouse', { name: 'Warehouse', articles: 0, forecast: 0, outbound: 0, sum: 0, scored: 0 }],
      [
        'Direct Supply',
        { name: 'Direct Supply', articles: 0, forecast: 0, outbound: 0, sum: 0, scored: 0 },
      ],
    ])
    for (const a of focused) {
      const held = groups.get(a.Supply)
      if (!held) continue
      held.articles += 1
      held.forecast += Number(a.WH_Constant_Forecast_Qty) || 0
      held.outbound += Number(a.Consumed_Qty) || 0
      if (a.WH_Accuracy !== null) {
        held.sum += a.WH_Accuracy
        held.scored += 1
      }
    }
    return [...groups.values()].map((g) => ({ ...g, accuracy: g.scored ? g.sum / g.scored : null }))
  }, [focused])

  const ranked = useMemo(() => {
    const scored = focused.filter((a) => a.WH_Accuracy !== null)
    const varied = focused.filter((a) => a.Variance !== null && a.Variance !== 0)
    return {
      worst: [...scored].sort((a, b) => a.WH_Accuracy - b.WH_Accuracy).slice(0, 8),
      over: varied.filter((a) => a.Variance > 0).sort((a, b) => b.Variance - a.Variance).slice(0, 8),
      under: varied.filter((a) => a.Variance < 0).sort((a, b) => a.Variance - b.Variance).slice(0, 8),
    }
  }, [focused])

  const series = trend.data?.rows ?? []
  const scoredDays = useMemo(() => series.filter((r) => r.WH_Accuracy !== null).length, [series])

  /*
   * The warehouse forecast is a brand-level fact, and the page says so.
   *
   * Outbound names a brand rather than a branch, and the sales total behind the
   * constant has no product column — so under a branch or product filter the
   * numerator would stay whole while the denominator shrank, and every warehouse
   * figure would read several times too high. The existing rule is to return
   * nothing; this page inherits it rather than inventing an answer, and explains
   * the blank instead of leaving somebody to wonder.
   */
  const narrowed = Boolean(
    filters?.locations?.length || filters?.products?.length || filters?.articles?.length
  )

  const tooltipStyle = {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 12,
  }

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  return (
    <>
      {narrowed && (
        <InfoBanner tone="warn">
          A branch, product or article filter is applied. The warehouse forecast is measured per
          brand — outbound names a brand, not a branch — so it is left blank rather than split into
          a figure the data cannot support. Clear those filters to see it.
        </InfoBanner>
      )}

      <div className="unitrow" style={{ '--cards': 3 }}>
        <MetricCard
          label="WH forecast"
          calc="wh-forecast"
          accent="amber"
          loading={busy}
          value={fmtQty(kpi.forecast)}
          foot={`Six-month rate applied to the sales forecast · ${fmtInt(kpi.articles)} articles`}
        />
        <MetricCard
          label="Outbound"
          calc="outbound"
          accent="amber"
          loading={busy}
          value={fmtQty(kpi.outbound)}
          foot={`Left the warehouse · ${fmtInt(kpi.withOutbound)} articles moved`}
        />
        <MetricCard
          label="WH ACC%"
          calc="card-warehouse,wh-acc"
          accent={kpi.accuracy === null ? 'slate' : kpi.accuracy >= 0.85 ? 'green' : 'amber'}
          progress={kpi.accuracy ?? 0}
          loading={busy}
          value={kpi.accuracy === null ? '–' : fmtPct(kpi.accuracy, 1)}
          foot={`Totals compared · ${fmtInt(kpi.scored)} scored`}
        />
      </div>

      <div className="unitrow" style={{ '--cards': 3 }}>
        <MetricCard
          label="Articles"
          accent="slate"
          loading={busy}
          value={fmtInt(kpi.articles)}
          foot="In the current filter context"
        />
        <MetricCard
          label="Articles with outbound"
          accent="slate"
          loading={busy}
          value={fmtInt(kpi.withOutbound)}
          foot={
            kpi.articles
              ? `${fmtPct(kpi.withOutbound / kpi.articles, 0)} of them moved in this window`
              : 'Nothing in this selection'
          }
        />
        <MetricCard
          label="Low accuracy articles"
          calc="low-accuracy,wh-acc"
          accent={kpi.low ? 'red' : 'slate'}
          loading={busy}
          value={fmtInt(kpi.low)}
          foot={`Scoring under ${fmtPct(LOW, 0)} · of ${fmtInt(kpi.scored)} scored`}
        />
      </div>

      <Panel
        calc="wh-forecast,outbound"
        title="WH forecast against outbound"
        sub="Daily. Bars are what actually left the warehouse; the line is what the six-month rate expected. Follows the slicers above."
      >
        {trend.loading ? (
          <ChartSkeleton height={280} />
        ) : series.length < 2 ? (
          <Empty title="Not enough days to draw a trend">
            Widen the date range to see whether forecast performance is improving.
          </Empty>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke="var(--line-soft)" vertical={false} />
              <XAxis
                dataKey="Date"
                tickFormatter={fmtDate}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                stroke="var(--line)"
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                stroke="var(--line)"
                width={64}
                tickFormatter={fmtInt}
              />
              <Tooltip
                labelFormatter={fmtDate}
                formatter={(v, n) => [fmtQty(v), n]}
                contentStyle={tooltipStyle}
              />
              <Bar dataKey="Outbound" name="Outbound" fill="var(--amber)" radius={[3, 3, 0, 0]} />
              <Line
                dataKey="WH_Forecast"
                name="WH forecast"
                stroke="var(--plain)"
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel
        title="Sales run rate"
        sub="Total sales value across every brand, month by month. This is the warehouse forecast's own denominator — every WH figure is the rate times this number. Last 12 months, regardless of the date slicer."
      >
        {runRate.loading ? (
          <ChartSkeleton height={260} />
        ) : runRate.data?.unavailable || !(runRate.data?.months ?? []).length ? (
          <Empty title="No sales loaded yet">
            The sales value table has nothing in it for this period.
          </Empty>
        ) : (
          <>
            <div className="unitrow" style={{ '--cards': 4 }}>
              <MetricCard
                label="This month so far"
                accent="slate"
                value={rr.soFar}
                foot={rr.soFarFoot}
              />
              <MetricCard
                label="On course for"
                accent={rr.paceTone}
                value={rr.runRate}
                foot="At the pace set so far this month"
              />
              <MetricCard
                label="Last full month"
                accent="slate"
                value={rr.previous}
                foot={rr.previousFoot}
              />
              <MetricCard
                label="Against the same point last month"
                accent={rr.paceTone}
                value={rr.pace}
                foot="Like for like — same number of days in"
              />
            </div>

            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={runRate.data.months} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="var(--line-soft)" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  stroke="var(--line)"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  stroke="var(--line)"
                  width={72}
                  tickFormatter={fmtQty}
                />
                <Tooltip
                  formatter={(v, n) => [fmtQty(v), n]}
                  contentStyle={tooltipStyle}
                />
                {/*
                  * Two lines rather than a stack, because the reason to look at
                  * this is the shape over twelve months and a line carries a
                  * shape better than twelve separate heights.
                  *
                  * They sit on top of each other for every finished month, where
                  * sold and total are the same number. They separate only at the
                  * current month, and that separation is exactly the thing worth
                  * seeing: the solid line stops at what has been sold, the
                  * dashed one carries on to what the models still expect.
                  */}
                <Line
                  dataKey="total"
                  name="Including what is still expected"
                  stroke="var(--amber)"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  dot={{ r: 3 }}
                  connectNulls
                />
                <Line
                  dataKey="actual"
                  name="Sold"
                  stroke="var(--plain)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls
                />
                <Line
                  dataKey="runRate"
                  name="On course for"
                  stroke="var(--red)"
                  strokeWidth={0}
                  dot={{ r: 5 }}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>

            <p className="pnote">
              The solid line is what has been sold; the dashed line adds the rest of the month the
              models still expect. They are the same figure for every finished month, so the two
              only separate at the month in progress. The red dot shows what that month is{' '}
              <strong>on course for</strong> at the pace set so far — where it sits above or below
              the dashed line, the pace and the models disagree, and that gap is worth a look.
              Everything here is value, not units, and every brand is included.
            </p>
          </>
        )}
      </Panel>

      <Panel
        title="Stock on hand against what left"
        sub="Weekly. How much of the stock it was holding the typical article shipped — 100% means it shipped exactly what it held. Follows the date slicer."
      >
        {soh.loading ? (
          <ChartSkeleton height={260} />
        ) : soh.data?.unavailable ? (
          <Empty title="No inventory model connected">
            Stock on hand comes from a separate model. Without it this chart has nothing to read.
          </Empty>
        ) : soh.data?.tooShort || (soh.data?.weeks ?? []).length < 3 ? (
          <Empty title="Not enough weeks to draw a trend">
            Widen the date range to at least three whole weeks.
          </Empty>
        ) : (
          <>
            <div className="unitrow" style={{ '--cards': 3 }}>
              <MetricCard
                label="Typical stock use"
                accent={sohRead.tone}
                value={sohRead.cover}
                foot="Of what it held, shipped in a week"
              />
              <MetricCard
                label="Shipped more than held"
                accent={sohRead.shortCount ? 'amber' : 'green'}
                value={fmtInt(sohRead.shortCount)}
                foot="Articles last week — replenished mid-week to manage it"
              />
              <MetricCard
                label="Shipped with an empty shelf"
                accent={sohRead.dryCount ? 'red' : 'green'}
                value={fmtInt(sohRead.dryCount)}
                foot="Articles last week with no stock recorded"
              />
            </div>

            <div className="segrid">
              <section className="seg">
                <h4>How much of its stock the typical article shipped</h4>
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={soh.data.weeks} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke="var(--line-soft)" vertical={false} />
                    <XAxis
                      dataKey="week"
                      tickFormatter={fmtDate}
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                      stroke="var(--line)"
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                      stroke="var(--line)"
                      width={54}
                      tickFormatter={(v) => `${Math.round(v * 100)}%`}
                    />
                    <Tooltip
                      labelFormatter={fmtDate}
                      formatter={(v) => [v === null ? '–' : fmtPct(v, 0), 'Stock used']}
                      contentStyle={tooltipStyle}
                    />
                    <Line
                      dataKey="cover"
                      name="Stock used"
                      stroke="var(--plain)"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="pnote">
                  Rising means stock is being drawn down faster relative to what is held; falling
                  means the warehouse is holding more than it is shipping. Read the level as
                  cover: 25% is about four weeks of stock, 100% is one week.
                </p>
              </section>

              <section className="seg">
                <h4>Articles that shipped more than they held</h4>
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={soh.data.weeks} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke="var(--line-soft)" vertical={false} />
                    <XAxis
                      dataKey="week"
                      tickFormatter={fmtDate}
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                      stroke="var(--line)"
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                      stroke="var(--line)"
                      width={54}
                      tickFormatter={fmtInt}
                    />
                    <Tooltip
                      labelFormatter={fmtDate}
                      formatter={(v, n) => [fmtInt(v), n]}
                      contentStyle={tooltipStyle}
                    />
                    <Bar dataKey="short" name="Shipped more than held" fill="var(--amber)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="dry" name="No stock recorded" fill="var(--red)" radius={[3, 3, 0, 0]} />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="pnote">
                  These are the articles most at risk of a stockout. Measured across roughly 47,000
                  article-weeks, a warehouse holding under a quarter-week of cover shipped{' '}
                  <strong>0.60x</strong> that article&rsquo;s average the following week, against{' '}
                  <strong>1.10x</strong> when it held more — so this chart leads the shortfall
                  rather than reporting it.
                </p>
              </section>
            </div>
          </>
        )}
      </Panel>

      <Panel
        calc="wh-acc,wh-forecast,outbound"
        title="WH ACC% over time"
        sub="Each day scored the way an article is: symmetric, against the larger of forecast and outbound. A day with neither is left out rather than scored zero."
      >
        {trend.loading ? (
          <ChartSkeleton height={220} />
        ) : scoredDays < 2 ? (
          <Empty title="Not enough scored days">
            A day is only scored where something was forecast or something moved.
          </Empty>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke="var(--line-soft)" vertical={false} />
              <XAxis
                dataKey="Date"
                tickFormatter={fmtDate}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                stroke="var(--line)"
              />
              <YAxis
                domain={[0, 1]}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                stroke="var(--line)"
                width={52}
                tickFormatter={(v) => fmtPct(v, 0)}
              />
              <Tooltip
                labelFormatter={fmtDate}
                formatter={(v) => [v === null ? '–' : fmtPct(v, 1), 'WH ACC%']}
                contentStyle={tooltipStyle}
              />
              <Line
                dataKey="WH_Accuracy"
                name="WH ACC%"
                stroke="var(--green)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <div className="whgrid">
        <Panel
          calc="bands,wh-acc"
          title="WH accuracy groups"
          sub="Articles by WH ACC%. Click a band to narrow the cards, the lists and the table to it."
        >
          <div className="bandchart__rows">
            <button
              type="button"
              className={`bandrow${band === null ? ' bandrow--on' : ''}`}
              onClick={() => setBand(null)}
              aria-pressed={band === null}
            >
              <span className="bandrow__key">All</span>
              <span className="bandrow__track" />
              <span className="bandrow__count">{fmtInt(articles.length)}</span>
            </button>
            {BANDS.map((b) => {
              const n = bandCounts.get(b.key) ?? 0
              const peak = Math.max(1, ...BANDS.map((x) => bandCounts.get(x.key) ?? 0))
              const on = band === b.key
              return (
                <button
                  key={b.key}
                  type="button"
                  disabled={!n}
                  aria-pressed={on}
                  className={`bandrow${on ? ' bandrow--on' : ''}`}
                  onClick={() => {
                    setBand(on ? null : b.key)
                    /*
                     * Selecting a group moves to the list it selected.
                     *
                     * The table already narrowed to the band, but it sits below
                     * three panels of charts — so from where the click happens
                     * nothing appears to have happened, and the articles the
                     * band was picked to look at are off the bottom of the
                     * screen.
                     */
                    if (!on) {
                      requestAnimationFrame(() =>
                        document
                          .getElementById('wh-article-detail')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      )
                    }
                  }}
                  title={`${fmtInt(n)} articles — click to ${on ? 'clear' : 'show only these'}`}
                >
                  <span className="bandrow__key">{b.label}</span>
                  <span className="bandrow__track">
                    <span
                      className={`bandrow__fill bandrow__fill--${
                        b.hi <= 0.4 ? 'poor' : b.hi <= 0.6 ? 'fair' : 'good'
                      }`}
                      style={{ width: `${(n / peak) * 100}%` }}
                    />
                  </span>
                  <span className="bandrow__count">{fmtInt(n)}</span>
                </button>
              )
            })}
          </div>
        </Panel>

        <Panel
          calc="supply,wh-forecast,outbound"
          title="Warehouse against direct supply"
          sub="Direct supply reaches the CPU or the branch without passing through the warehouse, so it has no outbound by definition. That is the answer, not a gap."
        >
          <table className="dt dt--plain">
            <thead>
              <tr>
                <th>Supply</th>
                <th className="num">Articles</th>
                <th className="num">WH forecast</th>
                <th className="num">Outbound</th>
                <th className="num">WH ACC%</th>
              </tr>
            </thead>
            <tbody>
              {supplySplit.map((g) => (
                <tr key={g.name}>
                  <td>
                    <Pill tone={g.name === 'Warehouse' ? 'green' : 'slate'}>{g.name}</Pill>
                  </td>
                  <td className="num">{fmtInt(g.articles)}</td>
                  <td className="num">{fmtQty(g.forecast)}</td>
                  <td className="num">{fmtQty(g.outbound)}</td>
                  <td className="num">{g.accuracy === null ? '–' : fmtPct(g.accuracy, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <div className="whgrid whgrid--three">
        <Attention
          title="Lowest WH accuracy"
          sub="Scored articles, worst first"
          rows={ranked.worst}
          valueOf={(r) => r.WH_Accuracy}
          format={(v) => fmtPct(v, 1)}
          tone="poor"
        />
        <Attention
          title="Most over-forecast"
          sub="Forecast higher than outbound"
          rows={ranked.over}
          valueOf={(r) => r.Variance}
          format={(v) => `+${fmtQty(v)}`}
          tone="fair"
        />
        <Attention
          title="Most under-forecast"
          sub="Outbound higher than forecast"
          rows={ranked.under}
          valueOf={(r) => r.Variance}
          format={(v) => fmtQty(v)}
          tone="good"
        />
      </div>

      <div id="wh-article-detail" />
      <Panel
        calc="wh-forecast,outbound,wh-acc,variance,supply"
        title={
          band
            ? `Articles scoring ${BANDS.find((b) => b.key === band)?.label ?? band}`
            : 'Warehouse article detail'
        }
        count={banded.length}
        sub={
          band
            ? `Every article in this accuracy group, in full. Clear the band above to see all ${fmtInt(articles.length)}.`
            : 'One row per article. Variance is WH forecast minus outbound, so positive is over-forecast.'
        }
        tools={
          view ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => downloadCsv('warehouse-insights.csv', view.rows, view.columns)}
            >
              CSV
            </button>
          ) : null
        }
      >
        {busy && !banded.length ? (
          <ChartSkeleton height={320} />
        ) : (
          <DataTable
            columns={COLUMNS}
            rows={banded}
            tableId="warehouse-insights"
            groups={{ wh: { label: 'Warehouse', help: HELP_WH } }}
            totals
            initialSort={{ key: 'Consumed_Qty', dir: 'desc' }}
            searchPlaceholder="Search article…"
            onViewChange={setView}
          />
        )}
      </Panel>
    </>
  )
}
