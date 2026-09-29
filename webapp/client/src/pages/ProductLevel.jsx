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
  { key: 'LocationID', label: 'Location', width: 110, hiddenByDefault: true, costly: true },
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
  {
    /*
     * Forecast accuracy per product:
     *
     *   IF actual = 0    -> blank
     *   IF forecast = 0  -> blank
     *   otherwise        -> 1 - |actual - forecast| / MAX(actual, forecast)
     *
     * Divided by the LARGER of the two, so the gap can never exceed the
     * denominator and the score is bounded 0-100% by construction. The value is
     * computed where the rows are built - see the note on `bigger` below, which
     * is where the 27 Sep 2026 change from dividing by actual is explained.
     *
     * This comment said the opposite until 29 Sep 2026: it still described the
     * old divide-by-actual behaviour, and claimed the column was unbounded below
     * and matched the DAX. Neither had been true for two days. Corrected while
     * wiring the Calculations inspector, which is where the formula is now also
     * stated to the reader - `product-acc` in server/calculations.js.
     *
     * Both zero cases are blank rather than 0% or 100%: a product that sold
     * nothing has no accuracy to report, and neither has one nobody forecast.
     */
    key: 'Accuracy_Pct',
    label: 'Accuracy %',
    width: W.pct,
    num: true,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title={
            Number(row?.Actual_Qty)
              ? 'Nothing was forecast for this product in the selected range.'
              : 'Nothing sold for this product in the selected range, so there is no accuracy to measure.'
          }
        >
          –
        </span>
      ) : (
        <span>{fmtPct(v)}</span>
      ),
    /*
     * The footer applies the same measure to the column's totals, which is what
     * the DAX would evaluate at a grand total row - and it reconciles with the
     * Actual qty and Forecast qty totals directly above it.
     */
    /*
     * Volume weighted, so the footer and the card are one figure.
     *
     * Each product's own score, weighted by what it actually sold: a product
     * moving 10,000 units counts two thousand times a product moving 5. It was
     * the measure applied to the totals, which is a different question and gave
     * a different number in the same view.
     *
     * Weighted by ACTUAL, never by the forecast - weighting by the forecast
     * would let the thing being judged decide how much it counts. That is the
     * rule WH ACC% follows with `Consumed_Qty`.
     */
    total: (rows) => {
      let w = 0
      let sum = 0
      for (const r of rows) {
        const v = r.Accuracy_Pct
        if (v === null || v === undefined) continue
        const a = Number(r.Actual_Qty) || 0
        if (!(a > 0)) continue
        w += a
        sum += a * v
      }
      return w > 0 ? sum / w : null
    },
    renderTotal: (v) => (v === null ? '–' : fmtPct(v)),
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
  /*
   * Accuracy is computed onto the row, not only in the cell's renderer.
   *
   * It was render-only, so the table showed it and the CSV exported an empty
   * column: `downloadCsv` reads `row[key]`, and there was no such key. Anything
   * that has to leave the screen - the export, a sort, a search - needs the
   * value on the row rather than inside the render.
   *
   * Same measure as the report: blank when either side is zero, otherwise
   * 1 - |actual - forecast| / actual.
   */
  const rows = useMemo(() => {
    const src = data?.rows ?? []
    return src.map((r) => {
      const a = Number(r.Actual_Qty) || 0
      const f = Number(r.Forecast_Qty) || 0
      /*
       * Divided by the LARGER of the two, from 27 Sep 2026.
       *
       * It divided by actual, which read the same gap two different ways
       * depending on its direction and sent products with a tiny actual to
       * absurd negatives - 1 sold against a forecast of 8 scored -600%.
       * Dividing by MAX means the gap can never exceed the denominator, so the
       * score is bounded 0-1 by construction: nothing needs flooring and
       * nothing runs off the scale.
       *
       * The same formula WH ACC% uses, and for the same reason - see the note
       * on `score` in ComponentLevel.jsx, where this was settled first.
       */
      const bigger = Math.max(a, f)
      return { ...r, Accuracy_Pct: a && f ? 1 - Math.abs(a - f) / bigger : null }
    })
  }, [data])
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
    // `Accuracy_Pct` is measured against the actuals, so it drops with them.
    ...(future
      ? ['Actual_Qty', 'Variance_Qty', 'Variance_Pct', 'Demand_Shift_Pct', 'Accuracy_Pct']
      : []),
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
  /*
   * The Accuracy card, volume weighted across products.
   *
   * It was `kpis.Forecast_Accuracy` - the server's measure applied to the
   * totals, `1 - |SUM(A) - SUM(F)| / SUM(A)`. That answers "how well did we
   * forecast the business", and it is not the same as the average of the
   * column beneath it, so the card and the footer disagreed.
   *
   * Now both are the same figure: each product's own score, weighted by what
   * it actually sold. A product moving 10,000 units carries two thousand times
   * the weight of one moving 5, so the tiny-volume rows that score harshly can
   * no longer move the headline.
   *
   * Computed from `rows` rather than from `kpis`, so the card and the table
   * cannot drift: it is literally the column's total.
   */
  const accuracy = useMemo(() => {
    let w = 0
    let sum = 0
    for (const r of rows) {
      const v = r.Accuracy_Pct
      if (v === null || v === undefined) continue
      const a = Number(r.Actual_Qty) || 0
      if (!(a > 0)) continue
      w += a
      sum += a * v
    }
    return w > 0 ? sum / w : null
  }, [rows])

  return (
    <>
      <FmNotice />

      <MetricFlow
        inputs={
          <>
            {!future && (
              <MetricCard
                label="Actual qty"
                calc="actual-qty"
                accent="green"
                progress={forecast ? actual / forecast : 0}
                loading={busy}
                value={fmtInt(actual)}
                foot="Units sold in range"
              />
            )}
            <MetricCard
              label="Forecast qty"
              calc="forecast-qty"
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
          calc="variance-pct,variance-qty,product-acc,product-acc-weighted"
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
              state: accuracy === null ? 'flat' : accuracyState(accuracy),
              value: accuracy === null ? '–' : fmtPct(accuracy),
              foot:
                accuracy === null
                  ? 'Nothing sold to measure against'
                  : `Weighted by units sold · target ${fmtPct(ACCURACY_TARGET, 0)}`,
            },
          ]}
        />
      </MetricFlow>

      <Panel
        calc="actual-qty,forecast-qty,variance-qty,variance-pct,demand-shift,product-acc,product-acc-weighted"
        busy={busy}
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
        {/*
          * The skeleton only before there is anything to show.
          *
          * Swapping the whole table out on every refresh unmounted it, and with
          * it went the search box, the sort and the page you were on — type an
          * article name, change the date, and the table came back showing
          * everything. The search is a question about the data, not about one
          * particular load of it.
          */}
        {busy && !rows.length ? (
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
