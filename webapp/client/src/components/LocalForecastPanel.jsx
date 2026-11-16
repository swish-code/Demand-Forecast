import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, fmtInt, fmtQty, downloadCsv } from '../api.js'
import { Panel, InfoBanner, ErrorBanner, Empty, Pill } from './ui.jsx'
import { DataTable } from './DataTable.jsx'
import { IconDownload, IconRefresh } from './Icons.jsx'

/**
 * The locally built product forecast.
 *
 * WHAT THIS IS FOR
 *
 * Power BI's `Forecast_Product_Table` is a calculated table - active item x
 * location combinations crossed with every forecast date - and the brands are
 * at their memory ceiling, so it cannot be extended into 2027. This rebuilds
 * the same figure here from the same three inputs, which is cheap because the
 * incidence rate varies by weekday rather than by date.
 *
 * WHY THE SOURCE IS STATED ON SCREEN RATHER THAN ASSUMED
 *
 * These numbers are generated here, not read from Power BI. They reproduce the
 * model's own method exactly - verified row for row - but somebody reading a
 * quantity off this page is going to order stock against it, and they are
 * entitled to know which system produced it. Hence the banner, the Source
 * column in the download, and the horizon stated as a date rather than implied
 * by an empty table.
 */

const today = () => new Date().toISOString().slice(0, 10)
const plusDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const DOW = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function LocalForecastPanel() {
  const [status, setStatus] = useState(null)
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [building, setBuilding] = useState(false)
  const [notice, setNotice] = useState(null)

  /* The two filters, both multi-select. Empty means "all". */
  const [brands, setBrands] = useState([])
  const [branches, setBranches] = useState([])
  const [from, setFrom] = useState(() => plusDays(today(), 1))
  const [to, setTo] = useState(() => plusDays(today(), 7))

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.admin.localForecastStatus())
    } catch (err) {
      setError(err)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  /*
   * The branches offered are those of the brands actually chosen. Listing every
   * brand's branches at once invites a filter pair that can only ever be empty
   * - BBT crossed with a Yelo branch - and the table then looks broken rather
   * than over-filtered.
   */
  const branchOptions = useMemo(() => {
    const all = status?.branches ?? {}
    const pick = brands.length ? brands : Object.keys(all)
    const out = new Set()
    for (const b of pick) for (const loc of all[b] ?? []) out.add(loc)
    return [...out].sort()
  }, [status, brands])

  /* A branch that the chosen brands do not have must not stay selected. */
  useEffect(() => {
    setBranches((held) => held.filter((b) => branchOptions.includes(b)))
  }, [branchOptions])

  const load = useCallback(async () => {
    if (!from || !to) return
    setBusy(true)
    setError(null)
    try {
      setRows(await api.admin.localForecastRows({ from, to, brands, branches, limit: 20000 }))
    } catch (err) {
      setError(err)
      setRows(null)
    } finally {
      setBusy(false)
    }
  }, [from, to, brands, branches])

  /*
   * The table follows the filters, with no button to press.
   *
   * The forecast is extracted on a schedule and already in the database, so
   * this read is a local join rather than a Power BI call — it is fast enough
   * to run on every change, and making somebody press "Show" to see what they
   * just selected is a step with nothing behind it.
   *
   * Debounced, because the date inputs fire on every keystroke: typing a year
   * into the From box would otherwise issue four reads, three of them for
   * dates nobody asked for.
   */
  useEffect(() => {
    if (!from || !to) return undefined
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load, from, to])

  const build = useCallback(
    async (brand) => {
      setBuilding(true)
      setError(null)
      setNotice(null)
      try {
        const res = await api.admin.localForecastBuild(brand ? { brand } : {})
        const ok = res.built?.length ?? 0
        const bad = res.failed ?? []
        setNotice(
          `Built ${ok} brand${ok === 1 ? '' : 's'}` +
            (bad.length ? ` · ${bad.length} failed: ${bad.map((f) => f.brand).join(', ')}` : '')
        )
        await loadStatus()
        await load()
      } catch (err) {
        setError(err)
      } finally {
        setBuilding(false)
      }
    },
    [loadStatus, load]
  )

  const toggle = (list, setList) => (value) =>
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value])

  /*
   * The horizon, as a date rather than a feeling.
   *
   * `Forecast_Spine` is built as TODAY() + 210 in every model, so the rates run
   * out at a specific day and this is it. A reader who asks for February 2028
   * and gets nothing deserves to know why, on screen, without reading the code.
   */
  const horizon = useMemo(() => {
    const ends = (status?.built ?? []).map((b) => b.rate_to).filter(Boolean)
    return ends.length ? ends.sort()[0] : null
  }, [status])

  const columns = useMemo(
    () => [
      { key: 'date', label: 'Date', autoWidth: true },
      {
        key: 'dow',
        label: 'Day',
        autoWidth: true,
        hint: 'The rate is held per weekday, which is why this column is worth seeing beside it.',
        render: (_v, row) => {
          const d = new Date(`${row.date}T00:00:00Z`)
          const js = d.getUTCDay()
          return DOW[js === 0 ? 7 : js]
        },
      },
      { key: 'brand', label: 'Brand', autoWidth: true },
      { key: 'location', label: 'Branch', autoWidth: true },
      { key: 'plu', label: 'Product PLU', autoWidth: true },
      { key: 'product', label: 'Product' },
      {
        key: 'rate',
        label: 'Incidence rate',
        num: true,
        autoWidth: true,
        hint: 'Units of this item per order. Held per item, branch and weekday.',
        render: (v) => (v === null || v === undefined ? '–' : `${(Number(v) * 100).toFixed(2)}%`),
      },
      {
        key: 'total_sales',
        label: 'Total sales',
        num: true,
        autoWidth: true,
        render: (v) => fmtQty(v),
      },
      { key: 'aov', label: 'AOV', num: true, autoWidth: true, render: (v) => fmtQty(v) },
      {
        key: 'orders',
        label: 'Forecast orders',
        num: true,
        autoWidth: true,
        hint: 'Total sales divided by AOV, exactly as DIVIDE([Total_Sales], [AOV], 0) does.',
        render: (v) => fmtInt(v),
      },
      {
        key: 'qty',
        label: 'Forecast qty',
        num: true,
        strong: true,
        autoWidth: true,
        hint: 'ROUND(rate x orders, 0) - the same expression as Forecast_Qty_7(last 28+2).',
        render: (v) => fmtInt(v),
      },
    ],
    []
  )

  const built = status?.built ?? []
  const allBrands = status?.brands ?? []

  return (
    <Panel
      title="Local product forecast"
      sub="Power BI's method, rebuilt here for the dates the models cannot hold"
      count={rows?.rows?.length ? `${fmtInt(rows.rows.length)} rows` : undefined}
      flush
      tools={
        <>
          <button type="button" className="btn" onClick={() => build(null)} disabled={building}>
            <IconRefresh /> {building ? 'Building…' : 'Build all brands'}
          </button>
          {/* The table follows the filters on its own; this is only here for
              somebody who wants to re-read after a rebuild elsewhere. */}
          <button type="button" className="btn" onClick={load} disabled={busy || !from || !to}>
            {busy ? 'Loading…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!rows?.rows?.length}
            onClick={() =>
              downloadCsv(
                `Local product forecast ${from} to ${to}.csv`,
                rows.rows.map((r) => ({ ...r, source: 'Generated locally (not Power BI)' })),
                [
                  /* `text` on the PLU: Excel turns a 14-digit code into
                     "8.30011E+13", and loses digits past the fifteenth. */
                  ...columns
                    .filter((c) => c.key !== 'dow')
                    .map(({ key, label }) => ({ key, label, text: key === 'plu' })),
                  { key: 'source', label: 'Source' },
                ]
              )
            }
          >
            <IconDownload /> Download
          </button>
        </>
      }
    >
      {/* `error`, not children: ErrorBanner reads a prop, and passing children
          rendered the literal string "undefined" over the real message. */}
      {error && <ErrorBanner error={error} />}

      <InfoBanner>
        <strong>These figures are generated here, not read from Power BI.</strong> They reproduce
        the model's own calculation —{' '}
        <code>ROUND([Incidence Rate Final] × [Forecast_Orders], 0)</code> — from the forecast spine,
        the AOV history and the sales plan. Verified against Power BI on BBT for 10 March 2027:
        3,348 of 3,348 rows matched exactly.{' '}
        {horizon ? (
          <>
            Rates currently reach <strong>{horizon}</strong>; nothing is produced past that date
            rather than holding the last rate flat.
          </>
        ) : (
          <>No brand has been built yet — use “Build all brands”.</>
        )}
      </InfoBanner>

      {notice && <InfoBanner>{notice}</InfoBanner>}

      {/* ---------------------------------------------------------- filters */}
      <div style={{ padding: 'var(--s4)', display: 'grid', gap: 'var(--s4)' }}>
        <div>
          <div className="field__label">Brand</div>
          <div className="choices">
            <button
              type="button"
              className={`choice${brands.length === 0 ? ' choice--on' : ''}`}
              onClick={() => setBrands([])}
            >
              All brands
            </button>
            {allBrands.map((b) => (
              <button
                key={b}
                type="button"
                className={`choice${brands.includes(b) ? ' choice--on' : ''}`}
                onClick={() => toggle(brands, setBrands)(b)}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="field__label">Branch</div>
          {branchOptions.length === 0 ? (
            <span className="field__help">
              No branches yet — build a brand first, then its branches appear here.
            </span>
          ) : (
            <div className="choices">
              <button
                type="button"
                className={`choice${branches.length === 0 ? ' choice--on' : ''}`}
                onClick={() => setBranches([])}
              >
                All branches
              </button>
              {branchOptions.map((b) => (
                <button
                  key={b}
                  type="button"
                  className={`choice${branches.includes(b) ? ' choice--on' : ''}`}
                  onClick={() => toggle(branches, setBranches)(b)}
                >
                  {b}
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 'var(--s4)', flexWrap: 'wrap' }}>
          <label className="field">
            <span className="field__label">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      </div>

      {/* ----------------------------------------------------- what is built */}
      {built.length > 0 && (
        <div style={{ padding: '0 var(--s4) var(--s4)', display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
          {built.map((b) => (
            <Pill key={b.brand} tone={b.rate_rows > 0 ? 'green' : 'amber'}>
              {b.brand}: {fmtInt(b.combos)} items · to {b.rate_to ?? '—'}
            </Pill>
          ))}
        </div>
      )}

      {/* ------------------------------------------------------------ table */}
      {rows?.rows?.length ? (
        <DataTable
          columns={columns}
          rows={rows.rows}
          tableId="local-forecast"
          searchable
          paginate
          freezable
        />
      ) : (
        <Empty>
          {busy
            ? 'Loading…'
            : built.length === 0
              ? 'Nothing has been extracted yet. It builds on a schedule — or press “Build all brands” to do it now.'
              : 'No forecast for these filters and dates. If the dates are past the horizon above, there is no rate to forecast from.'}
        </Empty>
      )}
    </Panel>
  )
}
