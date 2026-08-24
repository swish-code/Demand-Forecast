import { useEffect, useMemo, useState } from 'react'
import { api, fmtNum, fmtInt, fmtDate, downloadCsv } from '../api.js'
import { useData } from '../useData.js'
import { W } from '../columns.js'
import { Panel, ErrorBanner, ChartSkeleton, Empty, Pill, MetricCard } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { IconDownload } from '../components/Icons.jsx'

/**
 * Production type, coloured by how far through production the item is:
 * bought in, prepped, then assembled into a product article.
 *
 * Three categories is few enough for colour to carry, unlike the nine brands.
 * The label is still spelled out in every pill, so the colour is reinforcement
 * rather than the only way to tell them apart.
 */
const TYPE_TONE = { RAW: 'type-raw', PREP: 'type-prep', PA: 'type-pa' }

const COLUMNS = [
  // Which day the requirement falls on. Hidden by default: with a thirty-day
  // window every component repeats once per day, and most readers open this
  // page for a total rather than a diary. The Columns button turns it on.
  { key: 'Date', label: 'Date', width: 116, hiddenByDefault: true, costly: true, render: fmtDate },
  { key: 'LocationID', label: 'Branch', width: 96, hiddenByDefault: true, costly: true },
  { key: 'Recipe Group', label: 'Recipe group', width: W.group },
  // Always shown: the component name is what the row is.
  { key: 'Item', label: 'Component', strong: true, required: true },
  {
    key: 'Node Type',
    label: 'Type',
    width: 96,
    render: (v) => (v ? <Pill tone={TYPE_TONE[v] ?? 'slate'}>{v}</Pill> : '–'),
  },
  { key: 'BU', label: 'Unit', width: 92 },
  { key: 'Component_Forecast_Qty', label: 'Forecast qty', width: W.qty, num: true, strong: true, render: fmtNum },
]

/** Mirrors the report's COMPONENT LEVEL page. */
export function ComponentLevel({ filters, ready, refreshNonce, onLoaded }) {
  /*
   * Which extra dimensions the reader has switched on.
   *
   * Read from the same store the table writes to, and sent with the request:
   * splitting by branch or by day is a different query, not a different way of
   * displaying the same rows.
   */
  const [hiddenCols, setHiddenCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('df-cols-component-detail') || 'null')
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

  const { data, error, loading, reload } = useData(api.componentLevel, request, {
    enabled: ready,
    nonce: refreshNonce,
    onLoaded,
  })

  // Already at the requested grain: asking for Branch or Date changes the
  // query, so there is nothing left to fold together here.
  const rows = data?.rows ?? []

  const busy = loading || !ready

  const top = useMemo(
    () => [...rows].sort((a, b) => b.Component_Forecast_Qty - a.Component_Forecast_Qty)[0],
    [rows]
  )

  /**
   * Top components for every unit of measure.
   *
   * Kilograms, litres and "each" cannot share an axis, and one chart per unit
   * would be a wall of charts once a selection spans eight of them. So each unit
   * gets a short ranked list with the bar drawn relative to its own leader —
   * comparable within a unit, never across, which is the only honest reading.
   */
  const facets = useMemo(() => {
    const byUnit = new Map()
    for (const r of rows) {
      const unit = r.BU || '—'
      if (!byUnit.has(unit)) byUnit.set(unit, [])
      byUnit.get(unit).push(r)
    }
    return [...byUnit.entries()]
      .map(([unit, list]) => {
        const ranked = [...list].sort((a, b) => b.Component_Forecast_Qty - a.Component_Forecast_Qty)
        return {
          unit,
          rows: ranked.slice(0, 6),
          leader: Number(ranked[0]?.Component_Forecast_Qty) || 0,
          count: list.length,
          total: list.reduce((a, r) => a + (Number(r.Component_Forecast_Qty) || 0), 0),
        }
      })
      .sort((a, b) => b.count - a.count)
  }, [rows])

  const groups = useMemo(() => new Set(rows.map((r) => r['Recipe Group'])).size, [rows])

  const units = useMemo(() => [...new Set(rows.map((r) => r.BU).filter(Boolean))], [rows])

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  return (
    <>
      <div className="metrics">
        <MetricCard
          label="Components"
          accent="green"
          progress={0.72}
          loading={busy}
          value={fmtInt(rows.length)}
          foot="Distinct component rows"
        />
        <MetricCard
          label="Recipe groups"
          accent="blue"
          progress={0.62}
          loading={busy}
          value={fmtInt(groups)}
          foot="Groups represented"
        />
        <MetricCard
          label="Units of measure"
          accent="slate"
          progress={0.45}
          loading={busy}
          value={fmtInt(units.length)}
          foot={units.join(' · ') || '—'}
        />
        <MetricCard
          label="Largest requirement"
          accent="green"
          progress={1}
          loading={busy}
          textValue
          value={top?.Item ?? '–'}
          foot={top ? `${fmtNum(top.Component_Forecast_Qty)} ${top.BU}` : undefined}
        />
      </div>

      <div className="split--wide split split--pair">
      <Panel
        title="Component detail"
        count={busy ? undefined : `${rows.length.toLocaleString()} rows`}
        sub="Ingredient and packaging requirement implied by the product forecast"
        flush
        fill
        tools={
          <button
            type="button"
            className="btn"
            disabled={!rows.length}
            onClick={() =>
              downloadCsv('bbt-component-level.csv', rows, COLUMNS.map(({ key, label }) => ({ key, label })))
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
            initialSort={{ key: 'Component_Forecast_Qty', dir: 'desc' }}
            searchPlaceholder="Search component or group…"
            tableId="component-detail"
            onColumnsChange={setHiddenCols}
            fill
          />
        )}
      </Panel>
      <Panel
        title="Top components by unit"
        sub={
          busy || !facets.length
            ? undefined
            : `Largest requirement in each of the ${facets.length} unit${facets.length === 1 ? '' : 's'} · bars compare within a unit`
        }
      >
        {busy ? (
          <ChartSkeleton height={300} />
        ) : facets.length === 0 ? (
          <Empty />
        ) : (
          <div className="units">
            {facets.map((facet) => (
              <section className="units__unit" key={facet.unit}>
                <header className="units__head">
                  <h4 className="units__name">{facet.unit}</h4>
                  <span className="units__meta">
                    {fmtNum(facet.total)} across {fmtInt(facet.count)} component
                    {facet.count === 1 ? '' : 's'}
                  </span>
                </header>
                <ol className="units__list">
                  {facet.rows.map((r) => (
                    <li className="units__row" key={r.Item}>
                      <span className="units__item" title={r.Item}>
                        {r.Item}
                      </span>
                      <span className="units__track" aria-hidden="true">
                        <span
                          className="units__fill"
                          style={{
                            width: `${facet.leader ? Math.max(2, (r.Component_Forecast_Qty / facet.leader) * 100) : 0}%`,
                          }}
                        />
                      </span>
                      <span className="units__value">{fmtNum(r.Component_Forecast_Qty)}</span>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </Panel>

      </div>
    </>
  )
}
