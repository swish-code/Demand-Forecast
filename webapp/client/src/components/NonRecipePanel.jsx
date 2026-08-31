import { useEffect, useState } from 'react'
import { api, fmtNum, fmtInt } from '../api.js'
import { Panel, Empty, InfoBanner } from './ui.jsx'
import { BrandTag } from './BrandTag.jsx'

/**
 * A forecast for the things no recipe covers.
 *
 * Gloves, cleaning materials, uniforms, till rolls and a long tail of packaging
 * are in nobody's recipe, so nothing derives their requirement from the sales
 * forecast and the planning sheet reads "Not Exist" against them.
 *
 * They still move with trade. The relationship is measured rather than derived:
 * one constant per item per brand, being how many units of sale went with one
 * unit of the item last month, and next month's sales divided by it.
 *
 * Kept on the Admin page rather than the reports, because it is a method to
 * agree on before it is a number to order against — the constant is the thing
 * to argue with, so it is shown beside every line.
 */
export function NonRecipePanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(null)

  const load = (refresh = false) => {
    setBusy(true)
    setError(null)
    api.admin
      .nonRecipeForecast(refresh)
      .then((d) => {
        setData(d)
        setOpen((o) => o ?? d.brands.find((b) => b.items?.length)?.brand ?? null)
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    load(false)
    // Loaded once; the answer only changes when a month closes.
  }, [])

  const brands = data?.brands ?? []
  const shown = brands.find((b) => b.brand === open)
  const covered = brands.reduce((n, b) => n + (b.items?.length ?? 0), 0)

  return (
    <Panel
      title="Items with no recipe"
      count={data ? `${fmtInt(covered)} forecast` : undefined}
      sub={
        data
          ? `From ${data.windows.last.from} to ${data.windows.last.to}, applied to ${data.windows.next.from.slice(0, 7)}`
          : undefined
      }
      tools={
        <button type="button" className="btn" disabled={busy} onClick={() => load(true)}>
          {busy ? 'Working…' : 'Recalculate'}
        </button>
      }
    >
      {error ? (
        <p className="digest__error">{error}</p>
      ) : !data ? (
        <p className="cube__note">Reading two months of sales and a month of transfers…</p>
      ) : (
        <>
          <InfoBanner>
            <strong>constant = last month&rsquo;s sales ÷ last month&rsquo;s outbound.</strong> Next
            month&rsquo;s forecast sales divided by that constant gives the requirement — which is
            the same as taking what actually went out and scaling it by how much busier the month is
            expected to be. Nothing is invented: it is real usage, moved in proportion to trade.
          </InfoBanner>

          <div className="nrp__brands">
            {brands.map((b) => (
              <button
                type="button"
                key={b.brand}
                className={`choice${open === b.brand ? ' choice--on' : ''}`}
                onClick={() => setOpen(b.brand)}
                disabled={!b.items?.length}
                title={b.reason ?? `${b.items?.length ?? 0} items`}
              >
                {b.brand}
                <span className="nrp__count">{b.items?.length ?? 0}</span>
              </button>
            ))}
          </div>

          {!shown ? (
            <Empty title="Nothing to forecast" />
          ) : (
            <>
              <p className="nrp__basis">
                <BrandTag code={shown.brand} /> sold {fmtInt(shown.lastSales)} last month and is
                forecast {fmtInt(shown.nextSales)} next — a factor of{' '}
                <strong>{(shown.nextSales / shown.lastSales).toFixed(2)}×</strong>, which is what
                every line below is scaled by.
              </p>

              {/* The same table styling the rest of the admin page uses, so this
                  reads as part of the page rather than as a bolt-on. */}
              <div className="nrp__scroll">
                <table className="dt nrp__table">
                  <thead>
                    <tr>
                      <th scope="col">Article</th>
                      <th scope="col">Item</th>
                      <th scope="col">Unit</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Went out last month</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Constant</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Forecast next month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.items.slice(0, 200).map((i) => (
                      <tr key={i.article}>
                        <td className="id">{i.article}</td>
                        {/* The name the warehouse knows it by: a nine-digit code
                            identifies a thing without describing it. */}
                        <td className="nrp__name" title={i.name}>{i.name || '–'}</td>
                        <td className="dim">{i.unit || '–'}</td>
                        <td className="num">{fmtNum(i.outbound)}</td>
                        <td className="num dim" title="Units of sale per unit of this item">
                          {i.constant === null ? '–' : fmtNum(i.constant)}
                        </td>
                        <td className="num strong">
                          {i.forecast === null ? '–' : fmtNum(i.forecast)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {shown.items.length > 200 && (
                <p className="cube__note">
                  Showing the 200 largest of {fmtInt(shown.items.length)}.
                </p>
              )}
            </>
          )}
        </>
      )}
    </Panel>
  )
}
