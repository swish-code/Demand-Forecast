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
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmtQty, downloadCsv } from '../api.js'
import { Panel, ErrorBanner, ChartSkeleton, Empty, Pill } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Picker } from '../components/Picker.jsx'

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
    // Say in the filename what the sheet actually covers, so two downloads
    // taken under different filters cannot be mistaken for each other.
    const suffix = `${fBrand ? `-${fBrand}` : ''}${fMonth ? `-${MONTH_NAMES[Number(fMonth) - 1]}` : ''}`
    /*
     * The sheet gets the same rows the table is showing, slicer included.
     * Applied here rather than server-side because the slicer narrows the
     * population already fetched - it is not a different explosion the way a
     * month is.
     */
    const chosen = new Set(picked)
    const keep = (list) =>
      chosen.size === 0
        ? list
        : list.filter((r) =>
            chosen.has(kind === 'products' ? String(r.product ?? '') : String(r.article ?? ''))
          )
    try {
      if (kind === 'products') {
        const { rows } = await api.admin.salesPlanProducts(data.year, {
          brand: fBrand || undefined,
          month: fMonth || undefined,
        })
        downloadCsv(`product-forecast-${data.year}${suffix}.csv`, keep(rows), [
          { key: 'brand', label: 'Brand' },
          { key: 'plu', label: 'PLU' },
          { key: 'product', label: 'Product' },
          { key: 'forecastQty', label: `${data.year} forecast qty` },
        ])
        setNote(`${keep(rows).length.toLocaleString()} product rows downloaded.`)
      } else {
        const { rows } = await api.admin.salesPlanArticles(data.year, {
          brand: fBrand || undefined,
          month: fMonth || undefined,
        })
        downloadCsv(`article-forecast-${data.year}${suffix}.csv`, keep(rows), [
          { key: 'brand', label: 'Brand' },
          { key: 'article', label: 'Article No.' },
          { key: 'item', label: 'Article' },
          { key: 'unit', label: 'Unit' },
          { key: 'forecastQty', label: `${data.year} forecast qty` },
        ])
        setNote(`${keep(rows).length.toLocaleString()} article rows downloaded.`)
      }
    } catch (err) {
      setError(err)
    } finally {
      setDownloading('')
    }
  }

  const totals = useMemo(() => {
    if (!data) return null
    const list = data.groups ?? data.brands
    const planned = list.reduce((n, b) => n + (Number(b.value) || 0), 0)
    const entered = list.filter((b) => b.value !== null).length
    return { planned, entered, count: list.length }
  }, [data])

  // Only brands whose figure actually drives something: a target with no shape
  // has no months to show, and a row of blanks would read as twelve zeros.
  const planned = useMemo(
    () => (data?.groups ?? data?.brands ?? []).filter((b) => b.months && b.shares && b.value !== null),
    [data]
  )

  /*
   * The explosion on screen, not only in a file.
   *
   * Level, brand and month go to the server rather than being applied here: a
   * month is a different explosion, not a subset of the year's rows, because
   * the article constant multiplies that month's planned sales and Method C
   * picks that month's own mix. Filtering twelve months of rows down to one
   * would give a different - and wrong - answer.
   */
  const [level, setLevel] = useState('products')
  const [fBrand, setFBrand] = useState('')
  const [fMonth, setFMonth] = useState('')
  /*
   * Rows carry the level they were fetched for, and the table only renders
   * rows whose level matches the one on screen.
   *
   * Switching to Articles used to leave the PRODUCT rows in state while the
   * article request was in flight. The columns had already changed, so every
   * article column read a field products do not have and the table filled with
   * dashes against real quantities - it looked like missing data and was
   * actually the wrong rows. Tagging the payload makes the mismatch
   * unrepresentable rather than merely unlikely.
   */
  const [rowsData, setRowsData] = useState(null)
  const [rowsBusy, setRowsBusy] = useState(false)
  const [rowsError, setRowsError] = useState(null)
  const reqSeq = useRef(0)

  const loadRows = async () => {
    if (!data || !totals?.entered) return
    // Only the newest request may write. Brand, month and level can change
    // faster than the server answers, and without this an earlier, slower
    // response lands last and wins.
    const seq = (reqSeq.current += 1)
    const forLevel = level
    setRowsBusy(true)
    setRowsError(null)
    try {
      const opts = { brand: fBrand || undefined, month: fMonth || undefined }
      const { rows: got } =
        forLevel === 'products'
          ? await api.admin.salesPlanProducts(data.year, opts)
          : await api.admin.salesPlanArticles(data.year, opts)
      if (seq !== reqSeq.current) return
      setRowsData({ level: forLevel, rows: got })
    } catch (err) {
      if (seq !== reqSeq.current) return
      setRowsError(err)
      setRowsData(null)
    } finally {
      if (seq === reqSeq.current) setRowsBusy(false)
    }
  }

  useEffect(() => {
    // Drop the previous level's rows before the new ones are asked for, so the
    // gap shows a spinner rather than the old population under new columns.
    setRowsData(null)
    loadRows()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, fBrand, fMonth, data?.year, totals?.entered])

  /*
   * The brands the dropdown may offer.
   *
   * Taken from `brands`, not `groups`: the groups view carries an "Others" row
   * whose code is a bucket key, and narrowing the explosion to it would match
   * no brand and return an empty table. Others is already divided across its
   * real brands by the time a figure is saved, so every brand carrying a plan
   * appears here on its own.
   */
  const forecastBrands = useMemo(
    () => (data?.brands ?? []).filter((b) => b.usable && b.value !== null && b.value !== undefined),
    [data]
  )

  /*
   * Product and article slicers, matched on EITHER field.
   *
   * A product is known by its name to one reader and by its PLU to another, so
   * both are searchable and both are shown on the row. The options come from
   * the rows already loaded rather than a second request: the table is the
   * population being narrowed, so anything not in it is not a choice.
   */
  const [picked, setPicked] = useState([])

  // A change of level, brand or month is a different population, so a
  // selection made against the old one would silently hide everything.
  useEffect(() => {
    setPicked([])
  }, [level, fBrand, fMonth])

  /*
   * The rows the table may render: the payload, but only while it belongs to
   * the level currently on screen. Anything else is a stale answer in flight.
   */
  const liveRows = rowsData && rowsData.level === level ? rowsData.rows : null

  const pickOptions = useMemo(() => {
    if (!liveRows?.length) return []
    const seen = new Map()
    for (const r of liveRows) {
      const value = level === 'products' ? String(r.product ?? '') : String(r.article ?? '')
      if (!value || seen.has(value)) continue
      seen.set(value, {
        value,
        label: level === 'products' ? String(r.product ?? '') : String(r.item ?? value),
        code: level === 'products' ? String(r.plu ?? '') : String(r.article ?? ''),
      })
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [liveRows, level])

  const shownRows = useMemo(() => {
    if (!liveRows) return null
    if (!picked.length) return liveRows
    const keep = new Set(picked)
    return liveRows.filter((r) =>
      keep.has(level === 'products' ? String(r.product ?? '') : String(r.article ?? ''))
    )
  }, [liveRows, picked, level])

  const anyFilter = Boolean(fBrand || fMonth || picked.length)

  const forecastColumns = useMemo(
    () =>
      level === 'products'
        ? [
            { key: 'brand', label: 'Brand', width: 76, required: true },
            { key: 'plu', label: 'PLU', width: 116 },
            { key: 'product', label: 'Product', autoWidth: { min: 180, max: null, percentile: 0.95 }, wrap: true, strong: true, required: true },
            {
              key: 'forecastQty',
              label: `${data?.year ?? ''} forecast qty`,
              autoWidth: true,
              num: true,
              total: 'sum',
              renderTotal: fmtQty,
              render: (v) => fmtQty(v),
            },
          ]
        : [
            { key: 'brand', label: 'Brand', width: 76, required: true },
            { key: 'article', label: 'Article No.', width: 116, required: true },
            { key: 'item', label: 'Article', autoWidth: { min: 180, max: null, percentile: 0.95 }, wrap: true, strong: true },
            { key: 'unit', label: 'Unit', width: 96 },
            {
              key: 'forecastQty',
              label: `${data?.year ?? ''} forecast qty`,
              autoWidth: true,
              num: true,
              total: 'sum',
              renderTotal: fmtQty,
              render: (v) => fmtQty(v),
            },
          ],
    [level, data?.year]
  )

  if (error && !data) return <ErrorBanner error={error} onRetry={load} />
  if (busy && !data) return <ChartSkeleton height={280} />
  if (!data) return <Empty title="Nothing to plan yet">No brands are configured.</Empty>

  const rows = rowsOf(data)

  /** Has this row's box been changed since it was last saved? */
  const dirty = (b) => (draft[b.code] ?? '') !== (b.value === null || b.value === undefined ? '' : String(b.value))

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

        {/* The three figures the removed columns used to carry, said once. */}
        <dl className="planstat">
          <div className="planstat__item planstat__item--lead">
            <dt>{data.year} target</dt>
            <dd>{totals.entered ? fmtQty(totals.planned) : '–'}</dd>
          </div>
          <div className="planstat__item">
            <dt>Planned</dt>
            <dd>
              {totals.entered} <span className="planstat__of">of {totals.count}</span>
            </dd>
          </div>
          <div className="planstat__item">
            <dt>Driving a forecast</dt>
            <dd>
              {planned.length} <span className="planstat__of">with a shape</span>
            </dd>
          </div>
        </dl>

        <div className="nrp__scroll">
          <table className="dt nrp__table">
            <thead>
              <tr>
                <th scope="col">Brand</th>
                <th scope="col" className="num">{data.year} sales plan</th>
                <th
                  scope="col"
                  title={`Where the month-to-month shape comes from. "Seasonal" is the brand's twelve monthly seasonal factors for ${data.year} — the source the plan uses. "${data.year} forecast" is the model's own monthly forecast, used only for a brand with no usable factors. Neither is ${data.baseYear} sales.`}
                >
                  Shape
                </th>
                <th scope="col">Last saved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.code} className={dirty(b) ? 'planrow--dirty' : undefined}>
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
                  <td>
                    {b.shapeSource === 'group' ? (
                      <Pill tone="slate">Per brand</Pill>
                    ) : b.shapeSource === 'seasonal' ? (
                      <Pill tone="green">Seasonal</Pill>
                    ) : b.shapeSource === 'forecast' ? (
                      <Pill tone="amber" title={`No usable seasonal factors for ${b.code}, so the model's own ${data.year} monthly forecast is being used instead.`}>
                        {data.year} forecast
                      </Pill>
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
                    {/*
                      * Enabled only when the box differs from what is stored.
                      * A Save that would write back the same number reads as an
                      * action with an effect, and there is none.
                      */}
                    <button
                      type="button"
                      className={`btn${dirty(b) ? ' btn--on' : ''}`}
                      disabled={!b.canPlan || saving === b.code || !dirty(b)}
                      title={dirty(b) ? undefined : 'Nothing has changed'}
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
                  <strong>{totals.entered ? fmtQty(totals.planned) : '–'}</strong>
                </td>
                <td className="num" colSpan={3}>
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
        title={`The ${data.year} forecast`}
        sub="The plan exploded to product and article level. The table and the download are the same call, so a figure on screen is the figure in the sheet."
      >
        {totals.entered ? (
          <>
            <div className="planfx__bar">
              <div className="planfx__seg" role="group" aria-label="Forecast level">
                <button
                  type="button"
                  className={`planfx__tab${level === 'products' ? ' planfx__tab--on' : ''}`}
                  aria-pressed={level === 'products'}
                  onClick={() => setLevel('products')}
                >
                  Products
                </button>
                <button
                  type="button"
                  className={`planfx__tab${level === 'articles' ? ' planfx__tab--on' : ''}`}
                  aria-pressed={level === 'articles'}
                  onClick={() => setLevel('articles')}
                >
                  Articles
                </button>
              </div>

              <label className="planfx__field" htmlFor="planfx-brand">
                <span>Brand</span>
                <select
                  id="planfx-brand"
                  className="field__input"
                  value={fBrand}
                  onChange={(e) => setFBrand(e.target.value)}
                >
                  <option value="">All brands</option>
                  {forecastBrands.map((b) => (
                    <option key={b.code} value={b.code}>
                      {b.code}
                    </option>
                  ))}
                </select>
              </label>

              <label className="planfx__field" htmlFor="planfx-month">
                <span>Month</span>
                <select
                  id="planfx-month"
                  className="field__input"
                  value={fMonth}
                  onChange={(e) => setFMonth(e.target.value)}
                >
                  <option value="">Whole year</option>
                  {MONTH_NAMES.map((m, i) => (
                    <option key={m} value={String(i + 1)}>
                      {m} {data.year}
                    </option>
                  ))}
                </select>
              </label>

              {level === 'products' ? (
                <Picker
                  id="planfx-product"
                  label="Product"
                  options={pickOptions}
                  selected={picked}
                  onChange={setPicked}
                  allLabel="All products"
                  placeholder="Search product or PLU…"
                />
              ) : (
                <Picker
                  id="planfx-article"
                  label="Article"
                  options={pickOptions}
                  selected={picked}
                  onChange={setPicked}
                  allLabel="All articles"
                  placeholder="Search article or number…"
                />
              )}

              <div className="planfx__spacer" />

              {anyFilter ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setFBrand('')
                    setFMonth('')
                    setPicked([])
                  }}
                >
                  Reset filters
                </button>
              ) : null}

              <button
                type="button"
                className="btn btn--on"
                disabled={Boolean(downloading) || rowsBusy}
                title="Downloads exactly what the table is showing"
                onClick={() => download(level)}
              >
                {downloading ? 'Building…' : 'Download CSV'}
              </button>
            </div>

            {rowsError ? <ErrorBanner error={rowsError} onRetry={loadRows} /> : null}

            {/* What the table is showing, so a filtered view is never read as
                the whole population. */}
            {shownRows && shownRows.length ? (
              <p className="planfx__caption">
                <b>{shownRows.length.toLocaleString()}</b>
                {level === 'products' ? ' products' : ' articles'}
                {liveRows && shownRows.length !== liveRows.length ? (
                  <em>of {liveRows.length.toLocaleString()}</em>
                ) : null}
                <em>·</em>
                {fBrand || 'All brands'}
                <em>·</em>
                {fMonth ? `${MONTH_NAMES[Number(fMonth) - 1]} ${data.year}` : `Whole of ${data.year}`}
              </p>
            ) : null}

            {rowsBusy && !liveRows ? (
              <ChartSkeleton height={320} />
            ) : shownRows && shownRows.length ? (
              <DataTable
                columns={forecastColumns}
                rows={shownRows}
                tableId={`salesplan-${level}`}
                initialSort={{ key: 'forecastQty', dir: 'desc' }}
                totals
                searchPlaceholder={level === 'products' ? 'Search product or PLU…' : 'Search article or number…'}
                groupable={[{ key: 'brand', label: 'Brand' }]}
                maxHeight={520}
              />
            ) : (
              <Empty title="Nothing to show">
                No {level === 'products' ? 'products' : 'articles'} match this selection.
                {anyFilter ? ' Clear a filter to widen it.' : ''}
              </Empty>
            )}
          </>
        ) : (
          <Empty title="Nothing to show yet">
            Save a sales figure for at least one brand and both lists become available. Only brands
            with a figure appear in them — a brand with no plan has no {data.year} forecast, and an
            empty row would read as a forecast of nothing.
          </Empty>
        )}
      </Panel>

      <Panel
        title="What a saved figure does"
        sub={`How one number becomes a ${data.year} plan, and what it deliberately leaves alone`}
      >
        {/*
          * Two kinds of statement, so two groups.
          *
          * These were one flat list, which read badly for a reason worth
          * recording: four of the items are a SEQUENCE — the typed figure
          * becomes months, months become products, products become articles —
          * and two are the opposite, promises about what does not move. Mixed
          * together, and interleaved, the chain was impossible to follow.
          *
          * The numbers are not decoration: step 2 genuinely consumes step 1.
          */}
        <ol className="chain">
          <li className="chain__step">
            <span className="chain__n">1</span>
            <div>
              <b className="chain__t">Brand sales</b>
              <p className="chain__d">
                The typed value is the whole of {data.year}. It is spread across the twelve months
                by the brand&rsquo;s own twelve {data.year} seasonal factors, each month taking its
                factor&rsquo;s share of the twelve. The months always add back to the figure you
                typed.
              </p>
            </div>
          </li>
          <li className="chain__step">
            <span className="chain__n">2</span>
            <div>
              <b className="chain__t">Product level</b>
              <p className="chain__d">
                How big each month is comes from the shape above. Which products make it up is read
                from {data.baseYear}, because there is no {data.year} product data anywhere. Every
                product keeps its share of that mix.
              </p>
            </div>
          </li>
          <li className="chain__step">
            <span className="chain__n">3</span>
            <div>
              <b className="chain__t">Article level</b>
              <p className="chain__d">
                The recipe explosion is linear in product quantity, so scaling by the same ratio
                gives exactly what re-exploding the scaled products through the recipe tree would
                give. The tree itself is untouched.
              </p>
            </div>
          </li>
          <li className="chain__step">
            <span className="chain__n">4</span>
            <div>
              <b className="chain__t">Warehouse forecast</b>
              <p className="chain__d">
                Nothing was changed for it. It already multiplies its decayed ratio by the
                window&rsquo;s sales, so it picks the plan up on the existing method.
              </p>
            </div>
          </li>
        </ol>

        <h4 className="chain__head">What it leaves alone</h4>
        <ul className="chain__keeps">
          <li>
            <b>Seasonality is never rebuilt from {data.baseYear}.</b> Changing the target changes
            every month by the same proportion and leaves each month&rsquo;s share of the year
            untouched. A target twice as large gives twelve months twice as large, in the same shape.
          </li>
          <li>
            <b>Nothing else moves.</b> With no figure saved, not one calculation behaves differently
            — the {data.baseYear} figures, the accuracy measures and the cards are all untouched.
          </li>
          <li>
            <b>Branch level stays empty.</b> Splitting {data.year} by branch has nothing behind it,
            so it is left blank rather than invented. A date range crossing out of {data.year} is
            refused rather than half-answered, because one half would be planned and the other
            measured.
          </li>
        </ul>
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
                      {/* The bucket has a key, not a brand code — show its name. */}
                      <strong>{b.isGroup ? b.label : b.code}</strong>
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
