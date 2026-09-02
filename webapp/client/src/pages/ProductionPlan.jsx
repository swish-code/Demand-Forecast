import { Suspense, lazy, useState, useMemo } from 'react'
import { api, fmtInt, fmtPct, fmtDate, fmtLongDate, downloadCsv } from '../api.js'
import { useData } from '../useData.js'
import { W } from '../columns.js'
import {
  MetricCard,
  Panel,
  ErrorBanner,
  ChartSkeleton,
  Empty,
  StatusBadge,
  Delta,
  InfoBanner,
  Legend,
  Pill,
  FmNotice,
} from '../components/ui.jsx'
import { BrandTag } from '../components/BrandTag.jsx'
import { DataTable } from '../components/DataTable.jsx'

/*
 * The charts are fetched after the page is on screen, not before it.
 *
 * Recharts is 385 kB — twice the whole rest of the application — and importing
 * it here put it on the critical path: nobody saw a KPI card until the browser
 * had downloaded and parsed a charting library it did not need to draw one.
 *
 * Wrapped rather than lazily referenced at each call site, so every existing
 * `<TrendChart …/>` in this file is unchanged and each chart carries its own
 * skeleton — the same one the page already shows while its data loads, so the
 * arrival reads as the chart filling in rather than the layout jumping.
 */
const lazyChart = (load, name, height = 220) => {
  const Inner = lazy(() => load().then((m) => ({ default: m[name] })))
  const Wrapped = (props) => (
    <Suspense fallback={<ChartSkeleton height={props.height ?? height} />}>
      <Inner {...props} />
    </Suspense>
  )
  Wrapped.displayName = name
  return Wrapped
}

const CategoryBarChart = lazyChart(
  () => import('../components/charts/CategoryBarChart.jsx'),
  'CategoryBarChart',
  260
)
const PrepPressureChart = lazyChart(
  () => import('../components/charts/pageInsights.jsx'),
  'PrepPressureChart'
)
const WeekdayLeanChart = lazyChart(() => import('../components/charts/contextViz.jsx'), 'WeekdayLeanChart')
const BranchLeanChart = lazyChart(() => import('../components/charts/contextViz.jsx'), 'BranchLeanChart')
import { fmtSignedPct } from '../api.js'
import { useChartTheme } from '../components/charts/useChartTheme.js'
import { IconDownload, IconCalendar } from '../components/Icons.jsx'

const COLUMNS = [
  // The PLU column is out at the moment — asked for on 25 Aug 2026. The
  // rows are still grouped by it, so two products sharing a name stay on
  // separate lines; only the code itself is hidden. Restore by putting the
  // Clean_ItemID column back here and the article slicers back in App.jsx.
  { key: 'CHAINID', label: 'Brand', width: W.brand, render: (v) => <BrandTag code={v} /> },
  { key: 'LocationID', label: 'Location', width: W.location, strong: true },
  { key: 'ProductName_Fixed_Option', label: 'Product' },
  {
    key: 'Tomorrow_Forecast_Qty',
    label: 'Tmr forecast',
    width: W.qty,
    num: true,
    strong: true,
    total: 'sum',
    render: fmtInt,
    renderTotal: fmtInt,
  },
  { key: 'Last_Avg_Actual', label: 'Recent actual', width: W.qty, num: true, render: fmtInt },
  { key: 'Demand_Change_Pct', label: 'Demand change', width: W.pct, num: true, render: (v) => <Delta value={v} /> },
  { key: 'Prep_Status', label: 'Prep status', width: W.status, render: (v) => <StatusBadge status={v} /> },
]

const DAY = 86_400_000

/**
 * Position on the 60%–120% trust scale, as a percentage of the track.
 *
 * The tick labels are laid out with space-between across the same track, so
 * this mapping has to put 60% at 0 and 120% at 100 — an earlier version used a
 * different multiplier and the labels sat where the values were not.
 */
const TRUST_MIN = 0.6
const TRUST_MAX = 1.2
const pos = (v) => Math.max(0, Math.min(100, ((v - TRUST_MIN) / (TRUST_MAX - TRUST_MIN)) * 100))

/** Mirrors the report's PRODUCTION PLAN page. */
export function ProductionPlan({ filters, options, refreshNonce, onLoaded, onDrill }) {
  const colors = useChartTheme()

  /*
   * What the CSV holds.
   *
   * The table tells us the columns it is showing and the rows left after its
   * search box; the download is that, not the full set behind it. Someone who
   * ticks six columns out of twelve and downloads twelve has not exported the
   * view they built.
   */
  const [view, setView] = useState(null)
  const { data, error, loading, reload } = useData(api.productionPlan, filters, {
    nonce: refreshNonce,
    onLoaded,
  })

  // How this brand has actually been running, so the plan can be read with the
  // right expectations rather than defended afterwards.
  // Deferred behind the plan itself, so the two do not fan out concurrently.
  const { data: context, loading: contextLoading } = useData(api.context, filters, {
    enabled: Boolean(data),
    nonce: refreshNonce,
  })

  const kpis = data?.kpis ?? {}
  const rows = data?.rows ?? []
  const busy = loading

  const tomorrow = options.dateRange?.today
    ? new Date(new Date(`${options.dateRange.today}T00:00:00Z`).getTime() + DAY).toISOString().slice(0, 10)
    : null

  /** The weekday being planned, matched to how that weekday usually behaves. */
  const tomorrowLean = useMemo(() => {
    if (!tomorrow || !context?.enough) return null
    const label = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
      new Date(`${tomorrow}T00:00:00Z`).getUTCDay()
    ]
    const row = context.weekday?.find((w) => w.label === label)
    return row ? { ...row, label } : null
  }, [tomorrow, context])

  /** Branches the reader is actually looking at, for highlighting. */
  const focusLocations = useMemo(() => filters.locations ?? [], [filters.locations])

  const byProduct = useMemo(() => {
    const map = new Map()
    for (const r of rows) {
      const key = r.ProductName_Fixed_Option
      const prev = map.get(key) ?? { ProductName_Fixed_Option: key, Actual_Qty: 0, Forecast_Qty: 0 }
      prev.Forecast_Qty += Number(r.Tomorrow_Forecast_Qty) || 0
      prev.Actual_Qty += Number(r.Last_Avg_Actual) || 0
      map.set(key, prev)
    }
    return [...map.values()].sort((a, b) => b.Forecast_Qty - a.Forecast_Qty).slice(0, 10)
  }, [rows])

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  /*
   * The day the plan is for, taken from the model rather than this browser's
   * clock.
   *
   * [Tomorrow Forecast Qty] resolves off TODAY() as Power BI sees it, which is
   * the service's date. Overnight the two can be a day apart, and a figure that
   * looks wrong against the report is nearly always that. Naming the day makes
   * the comparison possible instead of a guess.
   */
  const planDay = kpis.Plan_Date ?? null

  const toPrepare = kpis.Products_To_Prepare ?? 0
  const high = kpis.High_Demand_Products ?? 0
  const low = kpis.Low_Demand_Products ?? 0

  return (
    <>
      <FmNotice />

      <InfoBanner icon={<IconCalendar size={15} />}>
        Planning for <strong>tomorrow · {tomorrow ? fmtLongDate(tomorrow) : '—'}</strong>
      </InfoBanner>

      {/*
        * The "How much can you trust this prep plan?" card is out at the
        * moment — asked for on 25 Aug 2026.
        *
        * Nothing else changed: /api/context still returns trustNote and the
        * daily email still carries it, so restoring this is putting the section
        * back, not rebuilding it. The band it quotes was also narrowed to the
        * middle half of days at the same time.
        */}

      {/* Read before the plan, not after the complaint: a branch that knows
          Wednesday habitually lands under can prepare for it. */}
      {tomorrowLean && Math.abs(tomorrowLean.lean) >= 0.05 && (
        <InfoBanner tone={Math.abs(tomorrowLean.lean) > 0.15 ? 'warn' : 'info'}>
          <strong>
            {tomorrowLean.label}s usually come in {fmtSignedPct(-tomorrowLean.lean)} against the
            forecast.
          </strong>{' '}
          Across the last {context.days} days this brand
          {tomorrowLean.lean > 0
            ? ` sold less than forecast on ${tomorrowLean.label}s — prepare toward the lower end of these numbers.`
            : ` sold more than forecast on ${tomorrowLean.label}s — the figures below may run short.`}
        </InfoBanner>
      )}

      {/* Four metric cards as a 2x2 block on the left, chart on the right. */}
      <div className="split">
        <div className="metrics--quad">
          <MetricCard
            label="Tomorrow forecast qty"
            accent="green"
            progress={0.68}
            loading={busy}
            value={fmtInt(kpis.Tomorrow_Forecast_Qty)}
            foot={planDay ? `Total units for ${fmtDate(planDay)}` : 'Total units to prepare'}
          />
          <MetricCard
            label="Products to prepare"
            accent="blue"
            progress={0.62}
            loading={busy}
            value={fmtInt(toPrepare)}
            foot="Distinct PLUs"
          />
          <MetricCard
            label="Extra prep needed"
            accent={high > 0 ? 'red' : 'slate'}
            progress={toPrepare ? high / toPrepare : 0}
            loading={busy}
            value={fmtInt(high)}
            foot={`Demand up >20%${toPrepare ? ` · ${fmtPct(high / toPrepare, 0)} of PLUs` : ''}`}
          />
          <MetricCard
            label="Reduced prep needed"
            accent="amber"
            progress={toPrepare ? low / toPrepare : 0}
            loading={busy}
            value={fmtInt(low)}
            foot={`Demand down >20%${toPrepare ? ` · ${fmtPct(low / toPrepare, 0)} of PLUs` : ''}`}
          />
        </div>

        <Panel
          title="Tomorrow's prep vs recent actual"
          sub={byProduct.length ? `Top ${byProduct.length} products by tomorrow's volume` : undefined}
          tools={
            <Legend
              items={[
                { label: 'Recent avg actual', color: colors.actual, bar: true },
                { label: 'Tomorrow forecast', color: colors.forecast, bar: true },
              ]}
            />
          }
        >
          {busy ? (
            <ChartSkeleton height={320} />
          ) : byProduct.length === 0 ? (
            <Empty title="Nothing to prepare">No products have a forecast for tomorrow under these filters.</Empty>
          ) : (
            <CategoryBarChart
              data={byProduct}
              dataKey="ProductName_Fixed_Option"
              categoryLabel="Product"
              orientation="bars"
              height={Math.max(240, byProduct.length * 30)}
              actualLabel="Recent avg actual"
              forecastLabel="Tomorrow forecast"
              fill
            />
          )}
        </Panel>
      </div>

      <Panel
        title="Production plan"
        count={busy ? undefined : `${rows.length.toLocaleString()} rows`}
        sub={
          planDay
            ? `Per PLU, per location · ${fmtLongDate(planDay)}`
            : 'Per PLU, per location, sorted by volume'
        }
        flush
        tools={
          <button
            type="button"
            className="btn"
            disabled={!(view?.rows ?? rows).length}
            onClick={() =>
              downloadCsv(
                'bbt-production-plan.csv',
                view?.rows ?? rows,
                view?.columns ?? COLUMNS.map(({ key, label }) => ({ key, label }))
              )
            }
          >
            <IconDownload size={12} />
            CSV
          </button>
        }
      >
        {busy ? (
          <div style={{ padding: 16 }}>
            <ChartSkeleton height={420} />
          </div>
        ) : (
          <DataTable
            columns={COLUMNS}
            rows={rows}
            initialSort={{ key: 'Tomorrow_Forecast_Qty', dir: 'desc' }}
            searchPlaceholder="Search product, PLU or location…"
            tableId="production-plan"
            onViewChange={setView}
            totals
          />
        )}
      </Panel>

      {/* Below the plan itself. A branch opens this page to get its list;
          the patterns behind the list are what you read afterwards. */}
      <div className="grid2">
        <Panel
          title={`How ${tomorrowLean ? 'each weekday' : 'weekdays'} usually run`}
          sub={
            contextLoading
              ? 'Reading the last 30 days…'
              : context?.enough
                ? 'Forecast against actual by day of week · above the line means the forecast asked for more than sold'
                : undefined
          }
        >
          {contextLoading ? (
            <ChartSkeleton height={200} />
          ) : !context?.enough ? (
            <Empty title="Not enough completed days yet" />
          ) : (
            <WeekdayLeanChart weekday={context.weekday} highlight={tomorrowLean?.label} />
          )}
        </Panel>

        <Panel
          title="How each branch has been running"
          sub={
            contextLoading
              ? 'Reading the last 30 days…'
              : context?.enough
                ? context.allLeanSameWay
                  ? 'Every branch leans the same way, so this is brand-wide rather than local'
                  : 'Branches differ — the ones apart from the rest are worth a look'
                : undefined
          }
        >
          {contextLoading ? (
            <ChartSkeleton height={220} />
          ) : !context?.enough || !context.locations?.length ? (
            <Empty title="No branch history yet" />
          ) : (
            <BranchLeanChart locations={context.locations} highlight={focusLocations} />
          )}
        </Panel>
      </div>

      <Panel
        title="Prep pressure by branch"
        sub="Products on tomorrow's plan, split by which way demand has moved · busiest change first"
        tools={
          <Legend
            items={[
              { label: 'Extra prep', color: colors.amber, bar: true },
              { label: 'Normal', color: colors.neutral, bar: true },
              { label: 'Reduced prep', color: colors.actual, bar: true },
            ]}
          />
        }
      >
        {busy ? (
          <ChartSkeleton height={260} />
        ) : rows.length === 0 ? (
          <Empty title="Nothing to prepare" />
        ) : (
          <PrepPressureChart
            rows={rows}
            onSelect={(d) => d?.location && onDrill?.('production', { locations: [d.location] })}
          />
        )}
      </Panel>

    </>
  )
}
