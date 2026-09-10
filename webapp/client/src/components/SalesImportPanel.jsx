import { useCallback, useEffect, useState } from 'react'
import { api, fmtInt, fmtQty } from '../api.js'
import { Panel, InfoBanner, Empty } from './ui.jsx'
import { ImportSales } from './ImportSales.jsx'

/** The brand this exists for. Forevermore ships from the warehouse as FM. */
const BRAND = 'FM'

/**
 * Sales for a brand that has no semantic model.
 *
 * Every other brand's sales arrive from its own Power BI model through the
 * extract. Forevermore has no model — there is no product-level data to build
 * one from — but the warehouse already ships to it under the code FM, and those
 * 3.9 million units were being measured against a sales total that left FM out.
 *
 * So its sales are loaded from a spreadsheet instead, into the same table the
 * extract writes to and under its own brand code. Every per-brand query filters
 * on brand and so never sees it; the four all-brands queries have no brand
 * filter and pick it up. That is the entire integration.
 */
export function SalesImportPanel() {
  const [state, setState] = useState(null)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setState(await api.admin.importedSales(BRAND))
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const loaded = state?.loaded
  const fromModel = state?.source === 'model'
  const [refill, setRefill] = useState(null)

  /*
   * Refill the sales value the constant divides by.
   *
   * The move from item counts to value on 9 Sep 2026 added two columns that
   * start empty on an existing copy, and the constant divides by them — so
   * until this is run once, every warehouse forecast is blank. One query per
   * brand rather than the branch-by-branch walk a full backfill does.
   */
  async function refillValues() {
    setBusy(true)
    setRefill(null)
    setError(null)
    try {
      const r = await api.admin.refillSalesValues()
      const ok = (r.results ?? []).filter((x) => !x.error)
      const bad = (r.results ?? []).filter((x) => x.error)
      setRefill(
        `${ok.length} brand${ok.length === 1 ? '' : 's'} refilled, ` +
          `${fmtInt(ok.reduce((s, x) => s + (x.rows ?? 0), 0))} day/branch rows` +
          (bad.length ? ` · ${bad.length} failed: ${bad.map((x) => x.brand).join(', ')}` : '')
      )
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  /** Pull the model now, rather than waiting for the next scheduled refresh. */
  async function pullNow() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await api.admin.refreshSales(BRAND)
      const mine = r.results?.find((x) => x.brand === BRAND) ?? r.results?.[0]
      if (mine?.error) setError(mine.error)
      else {
        setNotice(
          `${fmtInt(mine?.rows ?? 0)} days read from the model` +
            (mine?.read ? ` · found ${mine.read}` : '') +
            // The forward half is the reason a forecast series is read at all,
            // so it is worth saying how much of one arrived.
            (mine?.aheadDays ? ` · ${fmtInt(mine.aheadDays)} days of forecast` : '') +
            (mine?.noForecast ? ' · no forecast series, so future dates are zero' : '')
        )
      }
      setState((s) => ({ ...(s ?? {}), loaded: r.loaded }))
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  return (
    <Panel
      title={`${BRAND} sales`}
      sub={
        fromModel
          ? 'Forevermore has no product data, so it is not a full brand — but its daily sales come from its own Power BI model and are counted in the all-brands total'
          : 'Forevermore has no forecast model, so its daily sales are loaded from a spreadsheet and counted in the all-brands total'
      }
      tools={
        <>
          <button type="button" className="btn" onClick={refillValues} disabled={busy}>
            {busy ? 'Working…' : 'Refill sales values'}
          </button>
          {fromModel ? (
          <button type="button" className="btn btn--primary" onClick={pullNow} disabled={busy}>
            {busy ? 'Reading…' : 'Refresh now'}
          </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => setOpen(true)}>
              {loaded ? 'Replace or extend' : 'Import a file'}
            </button>
          )}
        </>
      }
    >
      {notice && <InfoBanner tone="info">{notice}</InfoBanner>}
      {refill && <InfoBanner tone="info">{refill}</InfoBanner>}
      {error && <InfoBanner tone="warn">{error}</InfoBanner>}

      {loaded ? (
        <dl className="imp">
          <dt>Loaded</dt>
          <dd>
            {fmtInt(loaded.rows)} day{loaded.rows === 1 ? '' : 's'}
          </dd>
          <dt>Covering</dt>
          <dd>
            {loaded.from} to {loaded.to}
          </dd>
          <dt>Total actual</dt>
          <dd>{fmtQty(loaded.actual)}</dd>
          <dt>Total forecast</dt>
          <dd>
            {loaded.forecast ? (
              fmtQty(loaded.forecast)
            ) : (
              <span className="muted">none — the all-brands forecast total excludes {BRAND}</span>
            )}
          </dd>
        </dl>
      ) : (
        <Empty title={`No ${BRAND} sales loaded yet`}>
          Until these are loaded, {BRAND}&rsquo;s warehouse outbound is measured against a sales
          total that does not include it, which overstates every rate derived from the catch-all
          group.
        </Empty>
      )}

      {fromModel ? (
        <p className="pnote">
          Read from <strong>{state.model.label}</strong> on every scheduled refresh, so it stays
          current on its own. The whole range is re-read each time rather than only recent days —
          it is one small table, and that way a restated history corrects itself. {BRAND} does not
          appear in the brand picker, because the model has no product-level data to show there.
        </p>
      ) : (
        <p className="pnote">
          Importing the same dates replaces them rather than adding to them, and the extract never
          touches these rows — it only ever deletes rows for brands it owns. {BRAND} does not appear
          in the brand picker, because it has no model to query. To switch to a daily refresh
          instead, publish a Power BI model with a date column and a sales column and set{' '}
          <code>PBI_SALES_ONLY={BRAND}|Forevermore|&lt;datasetId&gt;</code>.
        </p>
      )}

      {open && (
        <ImportSales
          brand={BRAND}
          onClose={() => setOpen(false)}
          onDone={(message) => {
            setOpen(false)
            setNotice(message)
            refresh()
          }}
        />
      )}
    </Panel>
  )
}
