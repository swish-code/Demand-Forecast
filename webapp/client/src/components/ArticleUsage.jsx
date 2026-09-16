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
    hint: 'The dish or product whose recipe uses this article.',
    strong: true,
    required: true,
    autoWidth: { min: 180, max: null, percentile: 0.95 },
    wrap: true,
    flex: true,
  },
  {
    key: 'PLU',
    label: 'PLU',
    hint: "The menu item's till code, used to match it to sales.",
    width: 96,
    hiddenByDefault: true,
  },
  {
    key: 'CHAINID',
    label: 'Brand',
    hint: 'The brand that sells this menu item.',
    width: 110,
    render: (v) => (v ? <Pill tone="slate">{v}</Pill> : '–'),
  },
  {
    key: 'Qty_Per_Unit',
    label: 'Qty/unit',
    hint: 'How much of this article one single menu item uses, in the unit shown beside it.',
    autoWidth: true,
    num: true,
    total: 'sum',
    render: perUnit,
    renderTotal: perUnit,
  },
  {
    key: 'BU',
    label: 'Unit',
    hint: 'The unit the quantities on this row are counted in.',
    autoWidth: true,
  },
  /*
   * What the menu item is forecast to sell, and what that asks of this article.
   *
   * The panel used to stop at the rate and tell the reader to multiply it by
   * the product's forecast themselves. These two columns are that sentence
   * carried out: the units forecast, then the rate times the units.
   *
   * Blank rather than zero when there is no forecast to read - a branch-scoped
   * reader gets none, because product forecasts are held with no branch column
   * and the brand's whole would be more than they are granted.
   */
  {
    key: 'Item_Forecast_Qty',
    label: 'Menu fcst',
    hint: 'How many of this menu item we expect to sell over the selected dates.',
    autoWidth: true,
    num: true,
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No forecast available for this menu item in the selected window. Product forecasts cannot be split by branch, so this is blank while a branch filter or a branch-limited account is in play."
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
  },
  {
    key: 'Article_Required_Qty',
    label: 'Article req',
    hint: 'How much of this article that forecast asks for: Qty/unit × Menu fcst. Adding this column up gives the article’s Forecast qty in the table behind this panel.',
    strong: true,
    autoWidth: true,
    num: true,
    total: 'sum',
    renderTotal: fmtQty,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span className="muted" title="Needs the menu item's forecast to work out.">
          –
        </span>
      ) : (
        <span
          title={`${perUnit(row?.Qty_Per_Unit)} ${row?.BU || ''} per unit multiplied by ${fmtQty(
            row?.Item_Forecast_Qty
          )} units forecast`}
        >
          {fmtQty(v)}
        </span>
      ),
  },
  /*
   * The measured side of the same two columns.
   *
   * Asked for on 16 Sep 2026. The panel showed only what the forecast asks of
   * the article, which cannot answer the question a reader arrives with - did
   * the requirement come from the forecast being wrong, or from the dish
   * genuinely selling that much? These two put the actual beside the forecast
   * so the comparison is on one row.
   *
   * No new source: `productLevel` already returns Actual_Qty next to
   * Forecast_Qty, and the server was reading only one of them.
   */
  {
    key: 'Item_Actual_Qty',
    label: 'Menu actual',
    hint: 'How many of this menu item actually sold over the selected dates.',
    autoWidth: true,
    num: true,
    total: 'sum',
    renderTotal: fmtQty,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No sales figure available for this menu item in the selected window. Product sales cannot be split by branch, so this is blank while a branch filter or a branch-limited account is in play."
        >
          –
        </span>
      ) : (
        <span
          title={
            row?.Item_Forecast_Qty === null || row?.Item_Forecast_Qty === undefined
              ? 'Units actually sold in the selected window.'
              : `${fmtQty(v)} sold against ${fmtQty(row.Item_Forecast_Qty)} forecast.`
          }
        >
          {fmtQty(v)}
        </span>
      ),
  },
  {
    key: 'Article_Actual_Qty',
    label: 'Article actual',
    hint: 'How much of this article the sales that actually happened used up: Qty/unit × Menu actual. Adding this column up gives the article’s Actual qty in the table behind this panel.',
    strong: true,
    autoWidth: true,
    num: true,
    total: 'sum',
    renderTotal: fmtQty,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span className="muted" title="Needs the menu item's actual sales to work out.">
          –
        </span>
      ) : (
        <span
          title={`${perUnit(row?.Qty_Per_Unit)} ${row?.BU || ''} per unit multiplied by ${fmtQty(
            row?.Item_Actual_Qty
          )} units sold`}
        >
          {fmtQty(v)}
        </span>
      ),
  },
  {
    key: 'Path',
    label: 'Through',
    hint: 'The recipe route from the menu item down to this article. "Directly" means the menu item uses it with no intermediate recipe.',
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
  /*
   * The count comes from the server, not from `rows.length`.
   *
   * An account that may see only the count is now sent only the count - the
   * rows are withheld rather than merely hidden - so counting the array would
   * report nought menu items for exactly the readers the count is for.
   */
  const used = Number.isFinite(Number(data?.count)) ? Number(data.count) : rows.length
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
      <div className="modal__card modal__card--wide" role="dialog" aria-modal="true" aria-label="Menu items using this article">
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
          ) : !used ? (
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
              <span className="usage__countnum">{fmtInt(used)}</span>
              <span className="usage__countlabel">
                menu {used === 1 ? 'item uses' : 'items use'} this article
              </span>
            </div>
          ) : (
            <>
              <p className="usage__lead">
                {fmtInt(used)} menu {used === 1 ? 'item uses' : 'items use'} this
                article
                {total > 0 && (
                  <>
                    {' '}
                    · {perUnit(total)} {article.BU || ''} in total, per one unit of each
                  </>
                )}
                {' · '}quantities are per <strong>one unit</strong> of the menu item;{' '}
                <strong>Article req</strong> is that rate times each item&rsquo;s forecast and{' '}
                <strong>Article actual</strong> the same rate times what it actually sold, over the
                selected window. Hover any column heading for what it means.
              </p>

              <DataTable
                columns={COLUMNS}
                rows={tableRows}
                tableId="article-usage"
                // The dialog decides the height now — see `.modal__card--wide`
                // — so this only stops it growing past the space it was given.
                fill
                groupable={[
                  { key: 'CHAINID', label: 'Brand' },
                  { key: 'BU', label: 'Unit' },
                  { key: 'Path', label: 'Recipe path' },
                ]}
                searchPlaceholder="Search a menu item…"
                onViewChange={setView}
                totals
                initialSort={{ key: 'Article_Required_Qty', dir: 'desc' }}
              />

              <p className="usage__note">
                {view ? (
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
                    Download CSV
                  </button>
                ) : null}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
