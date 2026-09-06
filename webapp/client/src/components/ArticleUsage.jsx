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
import { useEffect, useState } from 'react'
import { api, fmtInt, fmtQty, downloadCsv } from '../api.js'
import { useData } from '../useData.js'
import { DataTable } from './DataTable.jsx'
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

/**
 * The breakdown, for the people who maintain the numbers.
 *
 * Every column is here, with the same Build view the article table has, so an
 * administrator can drop Brand or Through and export what is left.
 */
const COLUMNS = [
  {
    key: 'Product',
    label: 'Menu item',
    strong: true,
    required: true,
    autoWidth: { min: 180, max: null, percentile: 0.95 },
    wrap: true,
    flex: true,
  },
  { key: 'PLU', label: 'PLU', width: 96, hiddenByDefault: true },
  {
    key: 'CHAINID',
    label: 'Brand',
    width: 110,
    render: (v) => (v ? <Pill tone="slate">{v}</Pill> : '–'),
  },
  {
    key: 'Qty_Per_Unit',
    label: 'Qty per unit',
    autoWidth: true,
    num: true,
    total: 'sum',
    render: perUnit,
    renderTotal: perUnit,
  },
  { key: 'BU', label: 'Unit', autoWidth: true },
  {
    key: 'Path',
    label: 'Through',
    width: 260,
    render: (v) => <span className="usage__path">{v || 'Directly'}</span>,
  },
]

export function ArticleUsage({ article, filters, isAdmin = false, onClose }) {
  const request = {
    ...filters,
    articleNo: article?.['Item No.'] ?? '',
    item: article?.Item ?? '',
  }
  const { data, error, loading, reload } = useData(api.articleUsage, request, {
    enabled: Boolean(article),
  })
  const [view, setView] = useState(null)

  // Escape closes it, like every other dialog in the app.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!article) return null

  const rows = data?.rows ?? []
  const total = rows.reduce((a, r) => a + (Number(r.Qty_Per_Unit) || 0), 0)
  // One string per row: the table sorts, searches and exports values, and an
  // array of paths is none of those things.
  const tableRows = rows.map((r) => ({ ...r, Path: r.Paths?.join(' · ') || 'Directly' }))

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
          ) : !isAdmin ? (
            /*
              * A count, and nothing else.
              *
              * The people ordering stock need to know an article is used and
              * roughly how widely; the recipe tree behind it is somebody else's
              * job and every column of it is a question they did not ask. The
              * detail is still one role away rather than hidden — it is on the
              * same data, through the same endpoint.
              */
            <div className="usage__count">
              <span className="usage__countnum">{fmtInt(rows.length)}</span>
              <span className="usage__countlabel">
                menu {rows.length === 1 ? 'item uses' : 'items use'} this article
              </span>
            </div>
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

              <DataTable
                columns={COLUMNS}
                rows={tableRows}
                tableId="article-usage"
                maxHeight={420}
                searchPlaceholder="Search a menu item…"
                onViewChange={setView}
                totals
                initialSort={{ key: 'Qty_Per_Unit', dir: 'desc' }}
              />

              <p className="usage__note">
                Quantities are per <strong>one unit</strong> of the menu item, taken from the recipe
                tree. Multiply by that product&rsquo;s forecast to get its share of the requirement
                shown in the table — {fmtQty(article.Component_Forecast_Qty)} {article.BU || ''}.
                {view ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() =>
                        downloadCsv(
                          `${article['Item No.'] || article.Item}-menu-items.csv`,
                          view.rows,
                          view.columns
                        )
                      }
                    >
                      CSV
                    </button>
                  </>
                ) : null}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
