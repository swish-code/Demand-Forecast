/**
 * Which menu items use an article, and how much of it each one takes.
 *
 * Opened by clicking a row in the article table. It answers the question the
 * table itself cannot: the table says you need 296,470 shawarma breads, and
 * this says which products that requirement is coming from and at what rate.
 *
 * The quantities come from 'RECIPE TABLE' — the same rows the component
 * forecast is exploded from — so what is shown here is the arithmetic behind
 * Forecast qty rather than a second opinion about the recipe.
 */
import { useEffect } from 'react'
import { api, fmtInt, fmtQty } from '../api.js'
import { useData } from '../useData.js'
import { IconClose } from './Icons.jsx'
import { ChartSkeleton, Empty, ErrorBanner, Pill } from './ui.jsx'

/**
 * A per-unit quantity, which is often very small indeed.
 *
 * 0.00018 kg of parsley per burger rounds to nothing at two decimals, and a
 * column of "0.00" says less than no column at all. Significant figures rather
 * than decimal places keeps the magnitude readable whatever the unit.
 */
const perUnit = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return '–'
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 3 })
  return n.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '')
}

export function ArticleUsage({ article, filters, onClose }) {
  const request = {
    ...filters,
    articleNo: article?.['Item No.'] ?? '',
    item: article?.Item ?? '',
  }
  const { data, error, loading, reload } = useData(api.articleUsage, request, {
    enabled: Boolean(article),
  })

  // Escape closes it, like every other dialog in the app.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!article) return null

  const rows = data?.rows ?? []
  const total = rows.reduce((a, r) => a + (Number(r.Qty_Per_Unit) || 0), 0)

  return (
    <div
      className="modal"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal__card" role="dialog" aria-modal="true" aria-label="Menu items using this article">
        <div className="modal__head">
          <div>
            <h2 className="modal__title">{article.Item}</h2>
            <span className="modal__sub">
              {article['Item No.'] ? `Article ${article['Item No.']} · ` : ''}
              Menu items that use it, and how much each one takes
            </span>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body">
          {error ? (
            <ErrorBanner error={error} onRetry={reload} />
          ) : loading ? (
            <ChartSkeleton height={220} />
          ) : !rows.length ? (
            <Empty title="No menu item uses this article">
              Nothing in the recipe tree names it. Articles like this reach the shops without a
              recipe behind them — the warehouse columns are where they are measured.
            </Empty>
          ) : (
            <>
              <p className="usage__lead">
                {fmtInt(rows.length)} menu {rows.length === 1 ? 'item uses' : 'items use'} this
                article
                {total > 0 && (
                  <>
                    {' '}
                    · {perUnit(total)} {article.BU || ''} across all of them, per one unit of each
                  </>
                )}
              </p>

              <div className="usage__scroll">
                <table className="dt dt--plain">
                  <thead>
                    <tr>
                      <th>Menu item</th>
                      <th>Brand</th>
                      <th className="num">Qty per unit</th>
                      <th>Unit</th>
                      <th>Through</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.CHAINID}|${r.PLU}|${r.Product}`}>
                        <td className="strong">
                          {r.Product}
                          {r.PLU ? <span className="usage__plu">{r.PLU}</span> : null}
                        </td>
                        <td>
                          <Pill tone="slate">{r.CHAINID}</Pill>
                        </td>
                        <td className="num">{perUnit(r.Qty_Per_Unit)}</td>
                        <td>{r.BU || article.BU || '–'}</td>
                        <td className="usage__path">
                          {/*
                            * Most articles arrive through a sub-recipe rather
                            * than directly — the parsley is in the ranch sauce
                            * and the ranch sauce is in the burger. Showing the
                            * path is what makes a tiny quantity make sense.
                            */}
                          {r.Paths?.length ? r.Paths.join(' · ') : 'Directly'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="usage__note">
                Quantities are per <strong>one unit</strong> of the menu item, taken from the recipe
                tree. Multiply by that product&rsquo;s forecast to get its share of the requirement
                shown in the table — {fmtQty(article.Component_Forecast_Qty)} {article.BU || ''}.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
