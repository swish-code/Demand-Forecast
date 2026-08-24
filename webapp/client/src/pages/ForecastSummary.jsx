import { useMemo } from 'react'
import { api, fmtInt, fmtPct, fmtSignedPct, downloadCsv } from '../api.js'
import { useData } from '../useData.js'
import { W } from '../columns.js'
import { DataTable } from '../components/DataTable.jsx'
import {
  Panel,
  ErrorBanner,
  ChartSkeleton,
  Empty,
  Delta,
  Legend,
  Meter,
  MetricCard,
  MetricFlow,
  SignedQty,
} from '../components/ui.jsx'
import { IconDownload } from '../components/Icons.jsx'
import { TrendChart } from '../components/charts/TrendChart.jsx'
import { CategoryBarChart } from '../components/charts/CategoryBarChart.jsx'
import { WeekdayBiasChart, RollingAccuracyChart } from '../components/charts/insights.jsx'
import { useChartTheme } from '../components/charts/useChartTheme.js'

/**
 * Thresholds. Colour appears only when one is actually crossed — anything in
 * its normal range is rendered as plain text, so a coloured figure always means
 * something.
 */
/** Matches --pair-h in tokens.css: the chart beside this table uses the same. */
export const PAIR_HEIGHT = 520

export const ACCURACY_TARGET = 0.95 // at or above: on track (green)
export const ACCURACY_FLOOR = 0.85 // below: outlier (red)
export const VARIANCE_LIMIT = 0.15 // beyond ±this: outlier (red)
export const VARIANCE_OK = 0.05 // inside ±this: on track (green)

/**
 * Three tiers, so a headline figure is never just grey:
 *   good  green  — on track
 *   warn  amber  — under target but not breached
 *   bad   red    — a real outlier
 */
export function varianceState(v) {
  const m = Math.abs(Number(v) || 0)
  if (m > VARIANCE_LIMIT) return 'bad'
  return m <= VARIANCE_OK ? 'good' : 'warn'
}

export function accuracyState(a) {
  const v = Number(a) || 0
  if (v >= ACCURACY_TARGET) return 'good'
  if (v < ACCURACY_FLOOR) return 'bad'
  return 'warn'
}

/** Gap contributors as a table: the same ranking, a quarter of the ink. */
const GAP_COLUMNS = [
  { key: 'name', label: 'Product', strong: true },
  {
    key: 'abs',
    label: 'Gap (units)',
    width: 104,
    num: true,
    render: (_v, row) => <SignedQty value={row.gap} format={fmtInt} />,
  },
  { key: 'pct', label: 'Variance', width: 94, num: true, render: (v) => <Delta value={v} pill /> },
  { key: 'cum', label: 'Share', width: 76, num: true, render: (v) => fmtPct(v, 0) },
]

const ExportButton = ({ rows, name, columns }) => (
  <button type="button" className="btn" disabled={!rows?.length} onClick={() => downloadCsv(name, rows, columns)}>
    <IconDownload size={12} />
    CSV
  </button>
)

function varianceOf(rows) {
  const f = rows.reduce((a, r) => a + (Number(r.Forecast_Qty) || 0), 0)
  const a = rows.reduce((acc, r) => acc + (Number(r.Actual_Qty) || 0), 0)
  return f ? (a - f) / f : 0
}

/**
 * Accuracy for one branch, defined the way the models define it today:
 * 1 - |actual - forecast| / actual.
 *
 * This divided by the forecast until the measures were corrected in Power BI,
 * which left the column reading a little high on every row. The server's
 * forecastAccuracy() is the same formula — they have to agree, because both
 * numbers appear on this page.
 */
const accuracyOf = (row) =>
  // Both sides have to exist. A branch that sold with no forecast at all is not
  // 0% accurate, it is unforecast — and showing it as 0% reads as a terrible
  // forecast rather than an absent one. Those rows say nothing instead.
  row.Actual_Qty && row.Forecast_Qty
    ? 1 - Math.abs((row.Actual_Qty - row.Forecast_Qty) / row.Actual_Qty)
    : null

/**
 * Tiny inline sparkline of daily variance, so the headline figure can be read
 * as typical or unusual without leaving the card.
 */
function Sparkline({ points, color, width = 96, height = 24 }) {
  if (!points || points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const step = width / (points.length - 1)
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - ((p - min) / span) * height).toFixed(1)}`)
    .join(' ')
  const zeroY = height - ((0 - min) / span) * height

  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {zeroY >= 0 && zeroY <= height && (
        <line x1="0" y1={zeroY} x2={width} y2={zeroY} stroke="currentColor" strokeWidth="1" opacity="0.25" />
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** Mirrors the report's FORECAST SUMMARY page. */
export function ForecastSummary({ filters, options, ready, refreshNonce, onLoaded, onDrill }) {
  const colors = useChartTheme()
  const contextFilters = useMemo(
    () => ({ ...filters, dateFrom: undefined, dateTo: undefined }),
    [filters]
  )
  const { data, error, loading, reload } = useData(api.summary, filters, {
    enabled: ready,
    nonce: refreshNonce,
    onLoaded,
  })

  // Its own request, and deliberately not filtered by date: "is this normal for
  // us?" is a question about the recent past, not about whichever range happens
  // to be selected. Everything else in `filters` still applies, so a branch
  // asking about its own numbers is answered about its own numbers.
  // Deferred until the page's own data has arrived. With nine brands selected
  // this request fans out to eighteen more queries, and firing it alongside the
  // summary put ~80 queries on the capacity at once — enough to be throttled.
  // The band it feeds is secondary, so it can wait a beat.
  const { data: context } = useData(api.context, contextFilters, {
    enabled: ready && Boolean(data),
    nonce: refreshNonce,
  })

  const kpis = data?.kpis ?? {}
  const prev = data?.prev
  const trend = data?.trend ?? []
  const products = data?.topProducts ?? []
  const byLocation = data?.byLocation ?? []
  const busy = loading || !ready

  const actual = kpis.Actual_Qty ?? 0
  const forecast = kpis.Forecast_Qty ?? 0
  const variance = kpis.Variance_Pct ?? 0
  const accuracy = kpis.Forecast_Accuracy ?? 0

  const varState = varianceState(variance)
  const accState = accuracyState(accuracy)

  /** Daily variance, for the sparkline beside the headline figure. */
  const varianceSeries = useMemo(
    () =>
      trend
        .filter((d) => d.Actual_Qty !== null && d.Actual_Qty !== undefined && d.Forecast_Qty)
        .map((d) => (d.Actual_Qty - d.Forecast_Qty) / d.Forecast_Qty),
    [trend]
  )

  /**
   * Bias per weekday, Monday first. Aggregating the window by day-of-week is
   * what exposes a standing pattern ("Fridays always over-forecast") that the
   * daily line averages away.
   */
  const weekdayBias = useMemo(() => {
    const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const buckets = new Map()
    for (const d of trend) {
      if (d.Actual_Qty === null || d.Actual_Qty === undefined || !d.Forecast_Qty) continue
      const dow = new Date(`${d.Date}T00:00:00Z`).getUTCDay()
      const b = buckets.get(dow) ?? { actual: 0, forecast: 0, days: 0 }
      b.actual += d.Actual_Qty
      b.forecast += d.Forecast_Qty
      b.days += 1
      buckets.set(dow, b)
    }
    return [1, 2, 3, 4, 5, 6, 0]
      .filter((i) => buckets.has(i))
      .map((i) => {
        const b = buckets.get(i)
        const bias = (b.actual - b.forecast) / b.forecast
        return { day: NAMES[i], bias, accuracy: 1 - Math.abs(bias), days: b.days }
      })
  }, [trend])

  /** The weekday furthest from target, named in the panel subtitle. */
  const worstWeekday = useMemo(
    () => [...weekdayBias].sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias))[0],
    [weekdayBias]
  )

  /**
   * Products ordered by how much of the total miss they own, with a running
   * share so the subtitle can say how few explain most of it.
   */
  const gapPareto = useMemo(() => {
    const withGap = products
      .filter((p) => p.Forecast_Qty)
      .map((p) => {
        const gap = p.Actual_Qty - p.Forecast_Qty
        return {
          name: p.ProductName_Fixed_Option,
          gap,
          abs: Math.abs(gap),
          pct: gap / p.Forecast_Qty,
        }
      })
      .filter((p) => p.abs > 0)
      .sort((a, b) => b.abs - a.abs)

    const total = withGap.reduce((s, p) => s + p.abs, 0)
    let running = 0
    return withGap.slice(0, 8).map((p) => {
      running += p.abs
      return { ...p, cum: total ? running / total : 0 }
    })
  }, [products])

  /** Seven-day rolling accuracy; a single day is too noisy to read a trend from. */
  const rollingAccuracy = useMemo(() => {
    const days = trend.filter((d) => d.Actual_Qty !== null && d.Actual_Qty !== undefined && d.Forecast_Qty)
    const out = []
    for (let i = 0; i < days.length; i++) {
      const window = days.slice(Math.max(0, i - 6), i + 1)
      if (window.length < 3) continue
      const a = window.reduce((s, d) => s + d.Actual_Qty, 0)
      const fc = window.reduce((s, d) => s + d.Forecast_Qty, 0)
      if (!fc) continue
      out.push({ Date: days[i].Date, accuracy: 1 - Math.abs((a - fc) / fc) })
    }
    return out
  }, [trend])

  /** Change in rolling accuracy across the window, in percentage points. */
  const accuracyDrift = useMemo(() => {
    if (rollingAccuracy.length < 2) return null
    return (rollingAccuracy.at(-1).accuracy - rollingAccuracy[0].accuracy) * 100
  }, [rollingAccuracy])

  /** Every product, ranked, with the gap precomputed for the on-bar label. */
  const productRows = useMemo(
    () =>
      products.map((p) => ({
        ...p,
        Variance_Pct: p.Forecast_Qty ? (p.Actual_Qty - p.Forecast_Qty) / p.Forecast_Qty : null,
      })),
    [products]
  )

  /** Worst accuracy first: the branches that need attention are the point. */
  const locationRows = useMemo(
    () => byLocation.map((r) => ({ ...r, Accuracy: accuracyOf(r) })),
    [byLocation]
  )

  /*
   * Narrower than the shared widths on purpose.
   *
   * This table sits in a side column, so it gets roughly half the room the
   * full-width tables do. A branch code is three characters and these figures
   * are six digits; the shared qty width is sized for a table that has the
   * whole page. Using it here pushed the table past its panel and put a
   * sideways scrollbar under five columns that easily fit.
   */
  const LOCATION_COLUMNS = [
    { key: 'LocationID', label: 'Location', width: 76, strong: true },
    { key: 'Actual_Qty', label: 'Actual', width: 104, num: true, total: 'sum', render: fmtInt, renderTotal: fmtInt },
    { key: 'Forecast_Qty', label: 'Forecast', width: 104, num: true, total: 'sum', render: fmtInt, renderTotal: fmtInt },
    {
      key: 'Variance_Pct',
      label: 'Var.',
      width: 84,
      num: true,
      render: (_v, row) => (
        <Delta value={row.Forecast_Qty ? (row.Actual_Qty - row.Forecast_Qty) / row.Forecast_Qty : null} pill />
      ),
      total: (rows) => varianceOf(rows),
      renderTotal: (v) => fmtSignedPct(v),
    },
    {
      key: 'Accuracy',
      label: 'Accuracy',
      render: (v) => <Meter value={v} good={ACCURACY_TARGET} warn={ACCURACY_FLOOR} />,
      total: (rows) => {
        const a = rows.reduce((n, r) => n + (Number(r.Actual_Qty) || 0), 0)
        const f = rows.reduce((n, r) => n + (Number(r.Forecast_Qty) || 0), 0)
        return a ? 1 - Math.abs(a - f) / a : null
      },
      // Drawn as a meter like every other row, so the percentage lands in the
      // same column. Rendered as bare text it sat under the bars instead.
      renderTotal: (v) => <Meter value={v} good={ACCURACY_TARGET} warn={ACCURACY_FLOOR} />,
    },
  ]

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  const belowTarget = locationRows.filter((r) => r.Accuracy !== null && r.Accuracy < ACCURACY_FLOOR).length

  return (
    <>
      {/* Actual and forecast are inputs; variance and accuracy are derived from
          them, so they sit in one performance card downstream of the arrow. */}
      <MetricFlow
        inputs={
          <>
          <MetricCard
            label="Actual qty"
            accent="green"
            progress={forecast ? actual / forecast : 0}
            loading={busy}
            value={fmtInt(actual)}
            foot="Units sold"
          />
          <MetricCard
            label="Forecast qty"
            accent="blue"
            progress={1}
            loading={busy}
            value={fmtInt(forecast)}
            foot="Units expected"
          />
          </>
        }
      >
        {busy ? (
          <div className="perf skel" style={{ height: 208, border: 'none' }} aria-hidden="true" />
        ) : (
          <div className="perf">
            <span className="perf__title">Performance</span>
            <div className="perf__grid">
              <div className="perf__item">
                <span className="metric__label">Variance</span>
                <span className={`perf__value perf__value--${varState}`}>{fmtSignedPct(variance)}</span>
                <span className="metric__foot">
                  {fmtInt(kpis.Variance_Qty)} units vs forecast
                  {prev?.Variance_Pct !== undefined && prev?.Variance_Pct !== null && (
                    <> · prev period {fmtSignedPct(prev.Variance_Pct)}</>
                  )}
                </span>
                <span className="perf__spark">
                  <Sparkline
                    points={varianceSeries}
                    color={varState === 'bad' ? colors.red : varState === 'warn' ? colors.amber : colors.actual}
                  />
                  <span className="perf__sparklabel">daily variance</span>
                </span>
              </div>

              <div className="perf__item">
                <span className="metric__label">Forecast accuracy</span>
                <span className={`perf__value perf__value--${accState}`}>{fmtPct(accuracy)}</span>
                <span className="metric__foot">
                  Target {fmtPct(ACCURACY_TARGET, 0)} ·{' '}
                  {accState === 'good' ? 'on target' : `${((accuracy - ACCURACY_TARGET) * 100).toFixed(1)}pp under`}
                </span>
                <span className="perf__meter">
                  <Meter value={accuracy} good={ACCURACY_TARGET} warn={ACCURACY_FLOOR} showValue={false} />
                </span>
              </div>
            </div>
          </div>
        )}
      </MetricFlow>

      {/* Demand tracking carries the most detail, so it gets the wider column. */}
      <div className="grid2 grid2--wide">
        <Panel
            title="Demand tracking"
            sub={
              busy
                ? 'Loading…'
                : context?.enough
                  ? 'Daily actual vs forecast · the grey band is where sales normally land'
                  : 'Daily actual vs forecast · shaded where they diverge'
            }
            tools={
              <>
                <Legend
                  items={[
                    { label: 'Actual', color: colors.actual },
                    { label: 'Forecast', color: colors.forecast, dashed: true },
                    { label: 'Under forecast', color: colors.actual, bar: true },
                    { label: 'Over forecast', color: colors.red, bar: true },
                    ...(context?.enough ? [{ label: 'Usual range', color: colors.neutral, bar: true }] : []),
                  ]}
                />
                <ExportButton rows={trend} name="bbt-forecast-trend.csv" />
              </>
            }
          >
            {busy ? (
              <ChartSkeleton height={320} />
            ) : trend.length === 0 ? (
              <Empty />
            ) : (
              <TrendChart
                data={trend}
                today={options.dateRange?.today}
                height={320}
                band={context?.enough ? context.band : null}
              />
            )}
          </Panel>

        <Panel
            title="Gap contributors"
            count={busy ? undefined : `${gapPareto.length} products`}
            sub={
              busy
                ? undefined
                : gapPareto.length
                  ? `Top ${Math.min(5, gapPareto.length)} explain ${fmtPct(gapPareto[Math.min(4, gapPareto.length - 1)].cum, 0)} of the total miss`
                  : 'Products ranked by their share of the miss'
            }
            flush
          >
            {busy ? (
              <div style={{ padding: 16 }}>
                <ChartSkeleton height={260} />
              </div>
            ) : gapPareto.length === 0 ? (
              <Empty title="No gap to attribute" />
            ) : (
              <DataTable
                columns={GAP_COLUMNS}
                rows={gapPareto}
                initialSort={{ key: 'abs', dir: 'desc' }}
                searchable={false}
                paginate={false}
                maxHeight={null}
                onRowClick={(row) => onDrill?.('product', { products: [row.name] })}
              />
            )}
          </Panel>
      </div>

      <div className="grid2">
        <Panel
            title="Rolling 7-day accuracy"
            sub={
              busy
                ? undefined
                : accuracyDrift === null
                  ? undefined
                  : `${accuracyDrift >= 0 ? 'Improving' : 'Declining'} ${Math.abs(accuracyDrift).toFixed(1)}pp across the range`
            }
          >
            {busy ? (
              <ChartSkeleton height={220} />
            ) : rollingAccuracy.length === 0 ? (
              <Empty title="Not enough completed days" />
            ) : (
              <RollingAccuracyChart data={rollingAccuracy} target={ACCURACY_TARGET} />
            )}
          </Panel>

        <Panel
            title="Accuracy by day of week"
            sub={
              busy
                ? undefined
                : worstWeekday
                  ? `${worstWeekday.day} is furthest off — ${worstWeekday.bias >= 0 ? 'under' : 'over'} forecast by ${fmtPct(Math.abs(worstWeekday.bias))}`
                  : 'Bias by weekday across the range'
            }
          >
            {busy ? (
              <ChartSkeleton height={220} />
            ) : weekdayBias.length === 0 ? (
              <Empty title="No completed days yet" />
            ) : (
              <WeekdayBiasChart data={weekdayBias} fill />
            )}
          </Panel>
      </div>

      <div className="grid2">
        <Panel
            title="Products by quantity"
            count={busy ? undefined : `${productRows.length.toLocaleString()} products`}
            sub="Scroll for the full list · click a bar to open it in Product Level"
            tools={<ExportButton rows={productRows} name="bbt-products.csv" />}
          >
            {busy ? (
            <ChartSkeleton height={420} />
            ) : productRows.length === 0 ? (
            <Empty />
            ) : (
            <div className="scrollchart scrollchart--fill">
              <CategoryBarChart
                data={productRows}
                dataKey="ProductName_Fixed_Option"
                categoryLabel="Product"
                orientation="bars"
                height={Math.max(220, productRows.length * 34)}
                showDelta
                onBarClick={(row) => onDrill?.('product', { products: [row.ProductName_Fixed_Option] })}
              />
            </div>
            )}
          </Panel>

        <Panel
            title="By location"
            count={busy ? undefined : `${locationRows.length} branches`}
            sub={
              busy
                ? undefined
                : belowTarget > 0
                  ? `${belowTarget} below ${fmtPct(ACCURACY_FLOOR, 0)} accuracy · worst first`
                  : 'Sorted worst accuracy first'
            }
            tools={<ExportButton rows={locationRows} name="bbt-qty-by-location.csv" />}
            flush
          >
            {busy ? (
              <div style={{ padding: 16 }}>
                <ChartSkeleton height={420} />
              </div>
            ) : locationRows.length === 0 ? (
              <Empty />
            ) : (
              <DataTable
                columns={LOCATION_COLUMNS}
                rows={locationRows}
                initialSort={{ key: 'Accuracy', dir: 'asc' }}
                searchable={false}
                paginate={false}
                totals
                maxHeight={PAIR_HEIGHT}
                onRowClick={(row) => onDrill?.('product', { locations: [row.LocationID] })}
              />
            )}
          </Panel>
      </div>

    </>
  )
}
