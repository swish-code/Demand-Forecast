import { useMemo, useState } from 'react'
import { api, fmtInt, fmtPct, fmtSignedPct, fmtDate, downloadCsv } from '../api.js'
import { useData } from '../useData.js'
import { W } from '../columns.js'
import {
  Panel,
  ErrorBanner,
  ChartSkeleton,
  Delta,
  SignedQty,
  Pill,
  MetricCard,
  MetricFlow,
  PerfCard,
  FmNotice,
} from '../components/ui.jsx'
import { BrandTag } from '../components/BrandTag.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { IconDownload } from '../components/Icons.jsx'
import { ACCURACY_TARGET, varianceState, accuracyState } from './ForecastSummary.jsx'
import { isFutureWindow } from '../window.js'

const COLUMNS = [
  // Off unless asked for: each one splits every row by that field.
  { key: 'Date', label: 'Date', width: 116, hiddenByDefault: true, costly: true, render: fmtDate },
  { key: 'LocationID', label: 'Branch', width: 96, hiddenByDefault: true, costly: true },
  // The PLU column is out at the moment — asked for on 25 Aug 2026. The
  // rows are still grouped by it, so two products sharing a name stay on
  // separate lines; only the code itself is hidden. Restore by putting the
  // Clean_ItemID column back here and the article slicers back in App.jsx.
  { key: 'CHAINID', label: 'Brand', width: W.brand, render: (v) => <BrandTag code={v} /> },
  { key: 'ProductName_Fixed_Option', label: 'Product', strong: true },
  { key: 'Actual_Qty', label: 'Actual qty', width: W.qty, num: true, strong: true, total: 'sum', render: fmtInt, renderTotal: fmtInt },
  { key: 'Forecast_Qty', label: 'Forecast qty', width: W.qty, num: true, total: 'sum', render: fmtInt, renderTotal: fmtInt },
  {
    key: 'Variance_Qty',
    label: 'Var. qty',
    width: W.qty,
    num: true,
    total: 'sum',
    render: (v) => <SignedQty value={v} format={fmtInt} />,
    renderTotal: fmtInt,
  },
  {
    // Placed immediately left of the variance it explains: a product 28% down on
    // last month with a matching variance is a demand event, not a bad forecast.
    key: 'Demand_Shift_Pct',
    label: 'Demand vs prev',
    width: 128,
    num: true,
    // Null means nothing sold in the previous window. That is not the same as
    // "new" — most of these are low-volume articles that simply had no sales —
    // so the cell says nothing rather than inventing a percentage.
    render: (v) =>
      v === null || v === undefined ? (
        <span className="dim" title="No sales in the previous period, so there is nothing to compare against">
          —
        </span>
      ) : (
        <Delta value={v} limit={0.25} />
      ),
  },
  {
    key: 'Variance_Pct',
    label: 'Var. %',
    width: W.pct,
    num: true,
    render: (v) => <Delta value={v} pill />,
    total: (rows) => {
      const f = rows.reduce((a, r) => a + (Number(r.Forecast_Qty) || 0), 0)
      const a = rows.reduce((acc, r) => acc + (Number(r.Actual_Qty) || 0), 0)
      return f ? (a - f) / f : 0
    },
    renderTotal: (v) => fmtSignedPct(v),
  },
]

/** Mirrors the report's PRODUCT LEVEL page. */
export function ProductLevel({ filters, options, ready, refreshNonce, onLoaded, onDrill }) {
  /*
   * What the CSV holds.
   *
   * The table tells us the columns it is showing and the rows left after its
   * search box; the download is that, not the full set behind it. Someone who
   * ticks six columns out of twelve and downloads twelve has not exported the
   * view they built. Falls back to everything until the table has reported —
   * which is before the button can be clicked.
   */
  const [view, setView] = useState(null)

  const [hiddenCols, setHiddenCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('df-cols-products-detail') || 'null')
      return Array.isArray(saved) ? saved : ['Date', 'LocationID']
    } catch {
      return ['Date', 'LocationID']
    }
  })

  const grain = useMemo(
    () => [!hiddenCols.includes('Date') && 'date', !hiddenCols.includes('LocationID') && 'location'].filter(Boolean),
    [hiddenCols]
  )
  const request = useMemo(() => ({ ...filters, grain }), [filters, grain])

  const { data, error, loading, reload } = useData(api.productLevel, request, {
    enabled: ready,
    nonce: refreshNonce,
    onLoaded,
  })

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  const kpis = data?.kpis ?? {}
  const rows = data?.rows ?? []
  const comparedWith = data?.comparedWith
  const busy = loading || !ready

  /*
   * A window that has not happened yet has no actuals, so everything derived
   * from them is dropped rather than shown as zero: a forecast of 142 against
   * an actual of 0 is not a 100% miss, it is a plan nobody has cooked yet.
   */
  const future = isFutureWindow(filters, options?.dateRange)
  /*
   * Split by day, a row is one Tuesday and the window before it is a month, so
   * there is nothing for "demand vs prev" to compare against. The server sends
   * no figure; the column goes with it rather than standing empty.
   */
  const drop = [
    ...(future ? ['Actual_Qty', 'Variance_Qty', 'Variance_Pct', 'Demand_Shift_Pct'] : []),
    ...(grain.includes('date') ? ['Demand_Shift_Pct'] : []),
  ]
  // Memoised on what it is derived from, not rebuilt each render: the table
  // sorts and filters against this array, and a fresh identity every render
  // threw that work away on every keystroke.
  const dropKey = drop.join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dropKey is `drop`
  const columns = useMemo(() => (drop.length ? COLUMNS.filter((c) => !drop.includes(c.key)) : COLUMNS), [dropKey])

  const actual = kpis.Actual_Qty ?? 0
  const forecast = kpis.Forecast_Qty ?? 0
  const variance = kpis.Variance_Pct ?? 0
  const accuracy = kpis.Forecast_Accuracy ?? 0

  return (
    <>
      <FmNotice />

      <MetricFlow
        inputs={
          <>
            {!future && (
              <MetricCard
                label="Actual qty"
                accent="green"
                progress={forecast ? actual / forecast : 0}
                loading={busy}
                value={fmtInt(actual)}
                foot="Units sold in range"
              />
            )}
            <MetricCard
              label="Forecast qty"
              accent="blue"
              progress={1}
              loading={busy}
              value={fmtInt(forecast)}
              foot={`${fmtInt(rows.length)} PLU × product rows`}
            />
          </>
        }
      >
        <PerfCard
          loading={busy}
          items={future ? [
            {
              label: 'Days ahead',
              state: 'flat',
              value: 'Forecast only',
              foot: 'Nothing has sold yet, so there is nothing to compare',
            },
          ] : [
            {
              label: 'Variance',
              state: varianceState(variance),
              value: fmtSignedPct(variance),
              foot: `${fmtInt(kpis.Variance_Qty)} units vs forecast`,
            },
            {
              label: 'Accuracy',
              state: accuracyState(accuracy),
              value: fmtPct(accuracy),
              foot: `Target ${fmtPct(ACCURACY_TARGET, 0)}`,
            },
          ]}
        />
      </MetricFlow>

      <Panel
        title="Products detail"
        count={busy ? undefined : `${rows.length.toLocaleString()} rows`}
        sub={
          future
            ? 'What the forecast asks for, PLU by PLU'
            : comparedWith
              ? `Actual vs forecast per PLU · demand compared with ${comparedWith.from} to ${comparedWith.to}`
              : 'Actual vs forecast for every PLU in the selection'
        }
        flush
        tools={
          <button
            type="button"
            className="btn"
            disabled={!(view?.rows ?? rows).length}
            onClick={() =>
              downloadCsv(
                'bbt-product-level.csv',
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
            columns={columns}
            rows={rows}
            totals
            initialSort={{ key: 'Actual_Qty', dir: 'desc' }}
            searchPlaceholder="Search product or PLU…"
            tableId="products-detail"
            onColumnsChange={setHiddenCols}
            onViewChange={setView}
          />
        )}
      </Panel>

    </>
  )
}
