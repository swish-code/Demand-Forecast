/**
 * Brand sales for a year the models do not reach.
 *
 * The forecast models end on 31 Dec 2026, so there is no 2027 figure to read
 * anywhere — not in 'FORECAST (2)', not in Forecast_Product_Table. This is
 * where somebody types it, and the product and article quantities for that year
 * are worked out from it on read. See `server/insights/salesPlan.js`.
 *
 * Deliberately plain. It is nine numbers and a Save; every column beside the
 * input is there to answer "what will this do?" before it is saved rather than
 * after — the base year it scales from, the ratio it implies, and the growth
 * that ratio represents.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, fmtQty, downloadCsv } from '../api.js'
import { Panel, ErrorBanner, ChartSkeleton, Empty, Pill } from '../components/ui.jsx'

/** A typed figure, read back as a number. Blank means "remove the plan". */
const cleaned = (s) => String(s ?? '').replace(/[,\s]/g, '')

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/*
 * The rows the page puts a box against: five brands and one Others bucket.
 *
 * `groups` is what the server sends for exactly this; `brands` is the fallback
 * so the page still renders against an older response.
 */
const rowsOf = (d) => d?.groups ?? d?.brands ?? []

const draftOf = (d) =>
  Object.fromEntries(rowsOf(d).map((b) => [b.code, b.value === null || b.value === undefined ? '' : String(b.value)]))

const pct = (r) => {
  if (r === null || r === undefined) return '–'
  const n = (Number(r) - 1) * 100
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
}

export function SalesPlan() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(true)
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState('')
  const [note, setNote] = useState('')

  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      const d = await api.admin.salesPlan()
      setData(d)
      setDraft(draftOf(d))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const save = async (code) => {
    if (!data) return
    setSaving(code)
    setNote('')
    setError(null)
    try {
      const d = await api.admin.saveSalesPlan(code, data.year, cleaned(draft[code]))
      setData({ ...data, ...d })
      setDraft(draftOf(d))
      setNote(
        cleaned(draft[code]) === ''
          ? `${code === '__others__' ? 'Others' : code} removed — back on the existing forecast logic.`
          : `${code === '__others__' ? 'Others saved and divided across its brands.' : `${code} saved.`} ${data.year} product and article forecasts now follow it.`
      )
    } catch (err) {
      setError(err)
    } finally {
      setSaving('')
    }
  }

  /*
   * The two lists, fetched on click rather than with the page.
   *
   * Exploding a year to article level is thousands of rows across every planned
   * brand, and nobody wants to pay for it on a page they opened to type one
   * number. The button says what it is doing while it does it.
   */
  const [downloading, setDownloading] = useState('')

  const download = async (kind) => {
    setDownloading(kind)
    setNote('')
    setError(null)
    try {
      if (kind === 'products') {
        const { rows } = await api.admin.salesPlanProducts(data.year)
        downloadCsv(`product-forecast-${data.year}.csv`, rows, [
          { key: 'brand', label: 'Brand' },
          { key: 'plu', label: 'PLU' },
          { key: 'product', label: 'Product' },
          { key: 'forecastQty', label: `${data.year} forecast qty` },
        ])
        setNote(`${rows.length.toLocaleString()} product rows downloaded.`)
      } else {
        const { rows } = await api.admin.salesPlanArticles(data.year)
        downloadCsv(`article-forecast-${data.year}.csv`, rows, [
          { key: 'brand', label: 'Brand' },
          { key: 'article', label: 'Article No.' },
          { key: 'item', label: 'Article' },
          { key: 'unit', label: 'Unit' },
          { key: 'nodeType', label: 'Type' },
          { key: 'recipeGroups', label: 'Recipe groups' },
          { key: 'forecastQty', label: `${data.year} forecast qty` },
        ])
        setNote(`${rows.length.toLocaleString()} article rows downloaded.`)
      }
    } catch (err) {
      setError(err)
    } finally {
      setDownloading('')
    }
  }

  const totals = useMemo(() => {
    if (!data) return null
    // Summed over the brands that HAVE an actual, so the total says the same
    // thing as the column above it rather than quietly treating a brand that
    // has not been read as one that sold nothing.
    const list = data.groups ?? data.brands
    const read = list.filter((b) => b.baseActual !== null && b.baseActual !== undefined)
    const base = read.reduce((n, b) => n + (Number(b.baseActual) || 0), 0)
    const planned = list.reduce((n, b) => n + (Number(b.value) || 0), 0)
    const entered = list.filter((b) => b.value !== null).length
    // A total of part-year sums is a part-year total, so it is withheld rather
    // than printed as the year's actual.
    const partial = read.some((b) => !b.baseActualComplete)
    return { base, planned, entered, read: read.length, partial, count: list.length }
  }, [data])

  // The last day any brand has an actual for — the column header says "to" this.
  const actualTo = useMemo(() => {
    const days = (data?.groups ?? data?.brands ?? []).map((b) => b.baseActualTo).filter(Boolean).sort()
    return days.length ? days[days.length - 1] : null
  }, [data])

  // Only brands whose figure actually drives something: a target with no shape
  // has no months to show, and a row of blanks would read as twelve zeros.
  const planned = useMemo(
    () => (data?.groups ?? data?.brands ?? []).filter((b) => b.months && b.shares && b.value !== null),
    [data]
  )

  if (error && !data) return <ErrorBanner error={error} onRetry={load} />
  if (busy && !data) return <ChartSkeleton height={280} />
  if (!data) return <Empty title="Nothing to plan yet">No brands are configured.</Empty>

  const rows = rowsOf(data)

  return (
    <>
      <Panel
        title={`Brand sales plan — ${data.year}`}
        sub={`Type a sales value for a brand and the ${data.year} product and article forecasts follow from it. The figure sets the SIZE of the year only — when those sales happen comes from the brand's own seasonal shape, which is never rebuilt from ${data.baseYear} sales. Leave a box empty and that brand keeps the existing logic.`}
      >
        {error ? <ErrorBanner error={error} onRetry={load} /> : null}
        {note ? (
          <p className="usage__lead" role="status">
            {note}
          </p>
        ) : null}

        <div className="nrp__scroll">
          <table className="dt nrp__table">
            <thead>
              <tr>
                <th scope="col">Brand</th>
                <th
                  scope="col"
                  className="num"
                  title={`What each brand has actually sold in ${data.baseYear} so far — the model's own Actual Sales, counting only days that have traded. Shown for reference; it is NOT what shapes ${data.year}.`}
                >
                  {data.baseYear} actual
                  {actualTo ? <span className="muted"> (to {actualTo})</span> : null}
                </th>
                <th scope="col" className="num">{data.year} sales plan</th>
                <th
                  scope="col"
                  className="num"
                  title={`The ${data.year} target against ${data.baseYear}'s FULL-YEAR figure — actual so far plus the model's forecast for the rest. Measured against the part-year actual beside it the number would be meaningless, because a whole year would be compared with nine months. A comparison, not an input: nothing is multiplied by it.`}
                >
                  Growth <span className="muted">vs full year</span>
                </th>
                <th
                  scope="col"
                  title={`Where the month-to-month shape comes from. "Forecast" is the ${data.year} monthly forecast in the model itself; "Seasonal" is the brand's twelve monthly seasonal factors. Neither is ${data.baseYear} sales.`}
                >
                  Shape
                </th>
                <th scope="col">Last saved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.code}>
                  <td>
                    {b.isGroup ? (
                      <>
                        <strong>{b.label}</strong>
                        <br />
                        <span
                          className="muted"
                          title={`A target typed here is divided across these brands by their share of ${data.baseYear}, and each keeps its own seasonality.`}
                        >
                          {b.members.map((m) => m.code).join(' · ')}
                        </span>
                      </>
                    ) : (
                      <>
                        <strong>{b.code}</strong>
                        {b.label && b.label !== b.code ? (
                          <span className="muted"> · {b.label}</span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="num">
                    {b.baseActual === null || b.baseActual === undefined ? (
                      <span
                        className="muted"
                        title="Actual sales have not been read yet. Run Admin → Refresh sales values."
                      >
                        not read yet
                      </span>
                    ) : b.baseActualComplete ? (
                      fmtQty(b.baseActual)
                    ) : (
                      /*
                       * Deliberately NOT the bare number.
                       *
                       * Only some days carry an actual, so the sum is a few days
                       * rather than the year — and printed plainly it reads as the
                       * year and is wrong by a factor of fifty. The figure is still
                       * shown, but labelled with what it actually covers.
                       */
                      <span
                        title={`Only ${b.baseActualDays} of the ${b.baseExpectedDays} days up to ${b.baseActualTo} have been read, so this is those days only — not the year. The hourly refresh rewrites just the last few days; run Admin → Refresh sales values to fill in the rest.`}
                      >
                        <span className="muted">{fmtQty(b.baseActual)}</span>{' '}
                        <Pill tone="amber">
                          {b.baseActualDays}/{b.baseExpectedDays} days
                        </Pill>
                      </span>
                    )}
                  </td>
                  <td className="num">
                    <input
                      id={`plan-${b.code}`}
                      className="field__input"
                      inputMode="decimal"
                      placeholder={b.canPlan ? 'none' : `no ${data.baseYear} sales`}
                      title={
                        b.canPlan
                          ? undefined
                          : `${b.code} has no ${data.baseYear} sales, so there is no product mix to read, and a figure typed here could not be turned into products or articles.`
                      }
                      disabled={!b.canPlan || saving === b.code}
                      value={draft[b.code] ?? ''}
                      onChange={(e) => setDraft({ ...draft, [b.code]: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && save(b.code)}
                      aria-label={`${data.year} sales plan for ${b.code}`}
                    />
                  </td>
                  <td className="num">
                    {b.ratio === null ? (
                      <span className="muted">–</span>
                    ) : (
                      <Pill tone={b.ratio >= 1 ? 'green' : 'amber'}>{pct(b.ratio)}</Pill>
                    )}
                  </td>
                  <td>
                    {b.shapeSource === 'group' ? (
                      <Pill tone="slate">Per brand</Pill>
                    ) : b.shapeSource === 'forecast' ? (
                      <Pill tone="green">{data.year} forecast</Pill>
                    ) : b.shapeSource === 'seasonal' ? (
                      <Pill tone="blue">Seasonal</Pill>
                    ) : b.canPlan ? (
                      <span
                        className="muted"
                        title={`No shape has been read for ${b.code} yet. One is fetched the moment a figure is saved, so there is nothing to do first.`}
                      >
                        on save
                      </span>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td>
                    {b.updatedAt ? (
                      <span className="muted">
                        {String(b.updatedAt).slice(0, 10)}
                        {b.updatedBy ? ` · ${b.updatedBy}` : ''}
                      </span>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      disabled={!b.canPlan || saving === b.code}
                      onClick={() => save(b.code)}
                    >
                      {saving === b.code ? 'Saving…' : 'Save'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td className="num">
                  {!totals.read ? (
                    <strong>–</strong>
                  ) : totals.partial ? (
                    <span
                      className="muted"
                      title="Some brands have only a few days of actuals read, so a total would not be the year's. Run Admin → Refresh sales values."
                    >
                      part-year
                    </span>
                  ) : (
                    <strong>{fmtQty(totals.base)}</strong>
                  )}
                </td>
                <td className="num">
                  <strong>{totals.entered ? fmtQty(totals.planned) : '–'}</strong>
                </td>
                <td className="num" colSpan={4}>
                  <span className="muted">
                    {totals.entered} of {totals.count} planned
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>

      <Panel
        title={`Download the ${data.year} forecast`}
        sub="The plan exploded to product and article level. Both are read through the same paths the pages use, so a downloaded figure is the figure on screen."
      >
        {totals.entered ? (
          <p className="usage__note">
            <button
              type="button"
              className="btn"
              disabled={Boolean(downloading)}
              onClick={() => download('products')}
            >
              {downloading === 'products' ? 'Building…' : `Product list + ${data.year} forecast qty`}
            </button>{' '}
            <button
              type="button"
              className="btn"
              disabled={Boolean(downloading)}
              onClick={() => download('articles')}
            >
              {downloading === 'articles' ? 'Building…' : `Article list + ${data.year} forecast qty`}
            </button>
          </p>
        ) : (
          <Empty title="Nothing to download yet">
            Save a sales figure for at least one brand and both lists become available. Only brands
            with a figure appear in them — a brand with no plan has no {data.year} forecast, and an
            empty row would read as a forecast of nothing.
          </Empty>
        )}
      </Panel>

      <Panel title="What a saved figure does" sub="The chain, and the three things it deliberately leaves alone">
        <ul className="guide__list">
          <li>
            <b>Brand sales.</b> The typed value is the whole of {data.year} for that brand. It is
            spread across the twelve months by the brand&rsquo;s own seasonal shape — the{' '}
            {data.year} monthly forecast where the model has one, otherwise the brand&rsquo;s twelve
            monthly seasonal factors. The months always add back to the figure you typed.
          </li>
          <li>
            <b>Seasonality is never rebuilt from {data.baseYear}.</b> Changing the target changes
            every month by the same proportion and leaves each month&rsquo;s share of the year
            untouched. A target twice as large gives twelve months twice as large, in the same
            shape.
          </li>
          <li>
            <b>Product level.</b> How big each month is comes from the shape above; which products
            make it up is read from {data.baseYear}, because there is no {data.year} product data
            anywhere. Every product keeps its share of that mix, and the total lands on the plan.
          </li>
          <li>
            <b>Article level.</b> The recipe explosion is linear in product quantity, so scaling by
            the same ratio gives exactly what re-exploding the scaled products through the recipe
            tree would give. The tree itself is untouched.
          </li>
          <li>
            <b>Warehouse forecast.</b> Nothing was changed for it. It already multiplies its decayed
            ratio by the window&rsquo;s sales, so it picks the plan up on the existing method.
          </li>
          <li>
            <b>Nothing else moves.</b> With no figure saved, not one calculation behaves differently
            — the {data.baseYear} figures, the accuracy measures and the cards are all untouched.
          </li>
        </ul>
        <p className="usage__note">
          Branch-level detail is the one thing a plan cannot produce: splitting {data.year} by branch
          has nothing behind it, so it stays empty rather than inventing a split. A date range that
          crosses out of {data.year} is refused rather than half-answered, because one half would be
          planned and the other measured.
        </p>
      </Panel>

      {planned.length ? (
        <Panel
          title={`The ${data.year} months`}
          sub="What each target becomes once its seasonal shape has spread it. The percentages are the shape itself — they do not move when the target does."
        >
          <div className="nrp__scroll">
            <table className="dt nrp__table">
              <thead>
                <tr>
                  <th scope="col">Brand</th>
                  {MONTH_NAMES.map((m) => (
                    <th scope="col" className="num" key={m}>
                      {m}
                    </th>
                  ))}
                  <th scope="col" className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {planned.map((b) => (
                  <tr key={b.code}>
                    <td>
                      <strong>{b.code}</strong>
                    </td>
                    {b.months.map((v, i) => (
                      <td className="num" key={i} title={`${(b.shares[i] * 100).toFixed(2)}% of the year`}>
                        {fmtQty(v)}
                        <br />
                        <span className="muted">{(b.shares[i] * 100).toFixed(1)}%</span>
                      </td>
                    ))}
                    <td className="num">
                      <strong>{fmtQty(b.months.reduce((n, v) => n + v, 0))}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </>
  )
}
