import { useMemo, useState } from 'react'
import { api, fmtQty, fmtInt, fmtPct, downloadCsv } from '../api.js'
import { Panel, ErrorBanner, Empty, InfoBanner, KpiCard, Pill } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { MultiSelect } from '../components/MultiSelect.jsx'
import {
  IconDownload,
  IconWarehouse,
  IconCalendar,
  IconProduct,
  IconBox,
} from '../components/Icons.jsx'

/*
 * The window, worked out as the reader types.
 *
 * Deliberately duplicated from the server's `windowFor` rather than fetched:
 * it is two lines of date arithmetic, and a round trip to find out which dates
 * you are about to size would make the form feel broken. The server remains
 * the authority - what it returns is what the forecast is built from - and
 * `newStore.test.js` holds the cases both sides have to agree on.
 */
const PERIOD_DAYS = 30

const addDays = (s, n) =>
  new Date(Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10)

const periodsFrom = (openingDate) => {
  if (!openingDate) return []
  const out = []
  for (let i = 0; i < 3; i += 1) {
    out.push({
      period: i + 1,
      from: addDays(openingDate, i * PERIOD_DAYS),
      to: addDays(openingDate, (i + 1) * PERIOD_DAYS - 1),
      days: PERIOD_DAYS,
    })
  }
  return out
}

/*
 * "Month 1", and the days it actually is.
 *
 * The reader calls these months, so the page does too. They are thirty-day
 * months counted from the opening day, not calendar ones, so the day range
 * travels with the label wherever there is room for it and sits in the hint
 * where there is not. The code keeps saying `period`, because that is what a
 * fixed thirty-day window is - the wording is a label, not a redefinition.
 */
const monthLabel = (n) => `Month ${n}`
const dayRange = (n) => `Days ${(n - 1) * PERIOD_DAYS + 1}–${n * PERIOD_DAYS}`

/*
 * One colour per month, used everywhere that month appears.
 *
 * The same month is the same colour in the window preview, in the sales
 * inputs, in the daily table's pill and in the By month panel - so the eye can
 * follow "Month 2" across the page without reading a word. Colour follows the
 * ENTITY, never its rank or its value.
 *
 * Green and red are deliberately not in the set: this theme reserves them for
 * good and bad news, and a month is neither. Blue, amber and slate carry
 * identity without making a claim.
 */
const monthTone = (n) => ['blue', 'amber', 'slate'][(Number(n) - 1) % 3] ?? 'plain'

/** "1 Jul", for naming a period by the dates it covers. */
const shortDate = (iso) =>
  !iso
    ? ''
    : new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      })

/** 15 January 2027, for a date input's worth of context. */
const longDate = (iso) =>
  !iso
    ? ''
    : new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })

/**
 * The first ninety days of a branch that does not exist yet.
 *
 * WHAT IT DOES, IN ONE LINE
 *
 * The new branch is the brand's own forecast curve, scaled to the sales the
 * user expects it to do.
 *
 * WHY THE FORM IS A FORM AND NOT SLICERS
 *
 * Every other page answers a question about data that exists; this one is
 * defined by four things nobody has recorded yet - the branch's name, when it
 * opens and what it expects to sell. Those are inputs, not filters, so they
 * sit in a form and nothing is fetched until Generate is pressed. Nothing is
 * stored either: change an input, press it again, and the old forecast cannot
 * survive anywhere.
 *
 * WHAT IT WILL NOT DO
 *
 * It will not borrow another year when the window has no forecast in it. The
 * server reports the window as unavailable and the page says so, because a
 * ninety-day plan quietly drawn from the wrong year is worse than no plan.
 *
 * It will not redistribute an excluded product's demand across the rest. The
 * quantity goes, and the shortfall against the typed target is stated. See the
 * note on the summary card.
 */

const money = (v) => `${fmtInt(v)} KD`

/*
 * The row's own PLU, with a note when its product has others.
 *
 * The badge used to read `+22`, meaning "twenty-two more PLUs you cannot see"
 * - true when the forecast was per product and the cell showed only the
 * busiest code. The forecast is now per PLU, so every one of those codes has
 * its own row and nothing is hidden. The badge therefore says something
 * different: `of 23` means this product is spread across twenty-three rows,
 * which is what a reader needs to know before totalling a product by eye.
 */
/*
 * `plus` is the envelope's product -> PLU list. The count used to ride on
 * every row as `Product_PLU_Count`; it is the same number on all thirty of a
 * PLU's rows, so it is looked up here instead of being sent 25,774 times.
 */
const pluCellWith = (plus) => (v, row) => {
  if (!v) return <span className="muted">–</span>
  const n = plus?.[row?.Product]?.length ?? 1
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s2)' }}>
      {v}
      {n > 1 && (
        <Pill tone="slate">
          <span title={`This product is forecast across ${n} PLUs, one row each`}>of {n}</span>
        </Pill>
      )}
    </span>
  )
}

/*
 * For the download only: the complete PLU list beside the one shown on screen.
 *
 * A spreadsheet is where somebody reconciles against an ordering system, and
 * "3002016 +22" is useless there. Built on click rather than carried on every
 * row, because the daily export is sixteen thousand rows and only one product
 * in four has a second PLU at all.
 */
const withAllPlus = (list, result) => {
  const plus = result?.plus
  const branches = Number(result?.branches) || 0
  const salesOf = new Map((result?.periods ?? []).map((p) => [p.period, p.sales]))
  const fixed = result?.row ?? {}
  return list.map((r) => ({
    // The three constants hoisted off the wire go back on for the file: a
    // spreadsheet row has to stand on its own once it leaves the page.
    ...fixed,
    ...r,
    // Derived for display are materialised here too, or the column would
    // export blank.
    Brand_Avg_Daily_Qty:
      branches > 0 && r.Brand_Daily_Qty != null ? r.Brand_Daily_Qty / branches : '',
    Monthly_Sales_KD: salesOf.get(r.Period) ?? '',
    Product_PLU_All: (plus?.[r.Product] ?? []).map((x) => x.plu).join('; '),
  }))
}

const PLU_HINT =
  'The Clean_ItemID this row forecasts. The forecast is per PLU, so a product selling under several codes has one row for each and the quantity beside it is that code’s alone. “of 23” means the product is spread across twenty-three such rows.'

/* A figure that is not available is never drawn as a zero. */
const naCell = (v, render) =>
  v === null || v === undefined ? <span className="muted">N/A</span> : render(v)

/* Complete / Partial / No data, with the coverage that decided it. */
const COVERAGE_TONE = { complete: 'green', partial: 'amber', none: 'red' }
const COVERAGE_LABEL = { complete: 'Complete', partial: 'Partial', none: 'No data' }

/*
 * The daily columns, built against one result.
 *
 * It was a module constant. Two of its columns are no longer sent on the row -
 * `Brand avg daily qty` is the day's brand quantity over the branch count, and
 * `Monthly sales` is the figure typed for that month - so both are derived
 * here from the envelope. Same columns, same values, 129 fewer bytes a row.
 */
const dailyColumnsFor = (result) => {
  const branches = Number(result?.branches) || 0
  const salesOf = new Map((result?.periods ?? []).map((p) => [p.period, p.sales]))
  const plus = result?.plus

  return [
  { key: 'Forecast_Date', label: 'Date', required: true, autoWidth: true },
  {
    key: 'Opening_Day',
    label: 'Day',
    num: true,
    autoWidth: true,
    hint: 'Days since opening, counting the opening day as 1.',
    render: fmtInt,
  },
  {
    key: 'Period',
    label: 'Month',
    autoWidth: true,
    hint: 'Which thirty-day month this date falls in: days 1–30, 31–60 or 61–90 from opening.',
    render: (v) => <Pill tone={monthTone(v)}>{monthLabel(v)}</Pill>,
  },
  { key: 'Product', label: 'Product', autoWidth: true },
  {
    key: 'Product_PLU',
    label: 'Product PLU',
    autoWidth: true,
    hint: PLU_HINT,
    render: pluCellWith(plus),
  },
  /*
   * The four working columns, off by default.
   *
   * They are how a quantity was arrived at, not what anybody plans from, and
   * two of them repeat the same value down every row of a period - the sales
   * figure you typed and the rate derived from it. On screen that is thirty
   * identical cells per period per product, which crowds out the two columns
   * that matter. They stay in the column picker and in the CSV, because the
   * forecast still has to be auditable; they just do not open on.
   */
  {
    key: 'Brand_Daily_Qty',
    label: 'Brand avg daily qty',
    num: true,
    autoWidth: true,
    hiddenByDefault: true,
    hint: 'The brand’s forecast for this PLU on this date, divided by the branches it is forecasting. Shown as the reference the weighting comes from; the averaging cancels out of the weight itself.',
    // Derived: the row carries the brand's own quantity, the envelope the
    // branch count. Sending the quotient as well would be a second copy of
    // the same fact, free to drift.
    render: (v) => (branches > 0 && v != null ? fmtQty(v / branches) : <span className="muted">–</span>),
  },
  {
    key: 'Daily_Weight_Pct',
    label: 'Daily weight',
    num: true,
    autoWidth: true,
    hiddenByDefault: true,
    hint: 'This day’s share of the product’s quantity across the thirty days of its month. The weights sum to 100% per product per month, which is what makes the daily figures add back to the monthly one.',
    render: (v) => fmtPct(v, 2),
  },
  {
    /*
     * A synthetic key: the value is not on the row at all, it is looked up
     * from the row's month. It must not reuse `Period`, which already keys the
     * month pill - DataTable keys its hidden set, its colgroup and its React
     * children by column key, so two columns sharing one would collide.
     */
    key: 'Monthly_Sales_KD',
    label: 'Monthly sales',
    num: true,
    autoWidth: true,
    hiddenByDefault: true,
    hint: 'The figure you typed for this thirty-day month. The same on every row of the month — it is in the By month panel above.',
    render: (v, row) => money(salesOf.get(row?.Period) ?? 0),
  },
  {
    key: 'Incident_Rate',
    label: 'Rate /KD',
    num: true,
    autoWidth: true,
    hiddenByDefault: true,
    hint: 'The brand’s own quantity of this product per KD of its own sales, over this month’s own thirty dates. This is what converts your sales figure into units.',
    render: (v) => (v ? v.toFixed(4) : '–'),
  },
  {
    key: 'Period_Product_Qty',
    label: 'Monthly product qty',
    num: true,
    autoWidth: true,
    hint: 'Your monthly sales × the rate. The daily figures in this month add up to this.',
    render: fmtQty,
  },
  {
    key: 'Daily_Product_Qty',
    label: 'Daily qty',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint: 'What to plan for on this date. Whole units: the month’s quantity is shared out by the weights and the remainder given to the busiest days, so the days add up to the month exactly.',
    render: fmtInt,
  },
  ]
}

export function NewStore({ brands = [] }) {
  /* Only brands with their own product model can be forecast from. */
  const usable = useMemo(() => brands.filter((b) => b.code && b.code !== 'FM'), [brands])

  const [brand, setBrand] = useState('')
  const [branchName, setBranchName] = useState('')
  const [openingDate, setOpeningDate] = useState('')
  const [sales, setSales] = useState(['', '', ''])
  const [exclude, setExclude] = useState([])
  const [menu, setMenu] = useState([])

  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  /*
   * One table, two grains. `daily` is what a branch prepares to; `period` is
   * what somebody orders and reports against. They were two panels, which made
   * a reader scroll between two views of the same numbers and invited the
   * question of whether they agreed. They are the same rows folded two ways.
   */
  const [grain, setGrain] = useState('period')

  /* What the reader is about to size, shown while they type it. */
  const periods = useMemo(() => periodsFrom(openingDate), [openingDate])
  const endsOn = periods.length ? periods[periods.length - 1].to : null
  const windowDays = periods.length * PERIOD_DAYS

  const typedTotal = sales.reduce((a, s) => a + (Number(s) || 0), 0)

  const ready = brand && branchName.trim() && openingDate && sales.some((s) => Number(s) > 0)

  /* Named, because a disabled button with no reason is a dead end. */
  const missing = [
    !brand && 'a brand',
    !branchName.trim() && 'a branch name',
    !openingDate && 'an opening date',
    !sales.some((s) => Number(s) > 0) && 'at least one month’s sales',
  ].filter(Boolean)

  /* The menu for the window, so the reader can say what the branch will not
   * sell. Fetched when the two things that decide it are both set. */
  const loadMenu = async (b, d) => {
    if (!b || !d) return
    try {
      const got = await api.newStoreProducts({ brand: b, openingDate: d })
      setMenu(got?.products ?? [])
    } catch {
      setMenu([])
    }
  }

  const generate = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(
        await api.newStoreForecast({
          brand,
          branchName: branchName.trim(),
          openingDate,
          periodSales: sales.map((s) => Number(s) || 0),
          exclude,
        })
      )
    } catch (err) {
      setError(err)
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const rows = result?.rows ?? []

  const totals = useMemo(() => {
    let qty = 0
    const byDate = new Map()
    for (const r of rows) {
      qty += Number(r.Daily_Product_Qty) || 0
      byDate.set(r.Forecast_Date, (byDate.get(r.Forecast_Date) ?? 0) + (Number(r.Daily_Product_Qty) || 0))
    }
    return { qty, days: byDate.size }
  }, [rows])

  /*
   * The same forecast folded to period grain — one row per product, one column
   * per thirty-day period.
   *
   * Summed from the DAILY whole units rather than carrying `Period_Product_Qty`
   * across, for two reasons. Every figure is then one a branch can actually
   * order, where the period quantity is fractional (210.41 units of Sprite).
   * And the two grains cannot disagree: the daily rows for a product-period add
   * to exactly this number by construction, so a reader who switches the toggle
   * sees the same forecast rather than a second opinion on it.
   */
  const periodRows = useMemo(() => {
    const byItem = new Map()
    for (const r of rows) {
      // Keyed on the PLU, not the product - that is the grain now, and folding
      // on the product here would silently re-merge what the regrain split.
      const key = `${r.Product}|${r.Product_PLU}`
      let got = byItem.get(key)
      if (!got) {
        got = {
          Product: String(r.Product),
          Product_PLU: r.Product_PLU ?? null,
          Total: 0,
        }
        byItem.set(key, got)
      }
      const q = Number(r.Daily_Product_Qty) || 0
      const k = `P${r.Period}`
      got[k] = (got[k] ?? 0) + q
      got.Total += q
    }
    return [...byItem.values()]
  }, [rows])

  /* Columns named for the days they cover, not "Period 1". */
  const periodColumns = useMemo(() => {
    const ps = result?.periods ?? []
    return [
      { key: 'Product', label: 'Product', required: true, strong: true },
      {
        key: 'Product_PLU',
        label: 'Product PLU',
        autoWidth: true,
        hint: PLU_HINT,
        render: pluCellWith(result?.plus),
      },
      ...ps.map((p) => ({
        key: `P${p.period}`,
        label: `${monthLabel(p.period)} · ${
          p.available ? `${shortDate(p.from)}–${shortDate(p.to)}` : COVERAGE_LABEL[p.status]
        }`,
        num: true,
        autoWidth: true,
        total: p.available ? 'sum' : undefined,
        renderTotal: fmtInt,
        hint: p.available
          ? `Whole units for ${monthLabel(p.period)} — ${dayRange(p.period)}, ${shortDate(
              p.from
            )} to ${shortDate(p.to)}, sized from ${money(p.sales)} of sales.`
          : `${monthLabel(p.period)} is not forecast: ${p.reason ?? 'the product forecast does not cover these dates.'}`,
        /*
         * A month with no forecast behind it shows N/A in every cell, never 0.
         * Zero is a quantity somebody would order against.
         */
        render: p.available
          ? (v) => (v ? fmtInt(v) : <span className="muted">–</span>)
          : () => <span className="muted">N/A</span>,
      })),
      {
        key: 'Total',
        label: 'Window total',
        num: true,
        autoWidth: true,
        strong: true,
        total: 'sum',
        renderTotal: fmtInt,
        hint: 'The product’s whole units across all ninety days.',
        render: fmtInt,
      },
    ]
  }, [result])

  /* What the one table is showing right now. */
  const dailyColumns = useMemo(() => dailyColumnsFor(result), [result])
  const tableRows = grain === 'daily' ? rows : periodRows
  const tableColumns = grain === 'daily' ? dailyColumns : periodColumns

  /* Does any month fall short because products were excluded? */
  const shortfall = useMemo(() => {
    const ps = result?.periods ?? []
    const typed = ps.reduce((a, p) => a + (Number(p.sales) || 0), 0)
    const implied = ps.reduce((a, p) => a + (Number(p.impliedSales) || 0), 0)
    return { typed, implied, gap: typed - implied }
  }, [result])

  /* The window as a chip, for the card labels. */
  const windowChip = result?.window
    ? `${shortDate(result.window.from)} – ${shortDate(result.window.to)}`
    : null

  return (
    <div className="nso">
      {/*
        * The line under the page title: what this page is, in one sentence,
        * with the branch it currently holds on the right.
        */}
      <p className="nso__intro">
        <b>New Store Opening</b>
        <span>
          · Ninety-day product forecast for a branch that does not exist yet — three thirty-day
          months, by product and by day.
        </span>
        {result?.available && (
          <span className="nso__intro-meta">
            {result.brand} · {result.branchName}
          </span>
        )}
      </p>

      {/*
        * The form, in two halves.
        *
        * Left is the branch - who and when. Right is what it expects to sell,
        * which is the only thing that scales the forecast. They are side by
        * side because the right half is meaningless until the left half has a
        * date: the month boxes are LABELLED with the calendar months that date
        * produces, so nobody has to work out what "Month 2" refers to.
        */}
      <div className="grid2">
        <Panel
          title="The new branch"
          sub="Nothing here has been recorded anywhere — the branch does not exist yet, so these are inputs rather than filters."
        >
          <div className="stack" style={{ padding: 'var(--s4)', gap: 'var(--s4)' }}>
            <label className="field">
              <span className="field__label">Brand</span>
              <select
                className="field__input"
                id="newstore-brand"
                value={brand}
                onChange={(e) => {
                  setBrand(e.target.value)
                  setExclude([])
                  loadMenu(e.target.value, openingDate)
                }}
              >
                <option value="">Choose a brand…</option>
                {usable.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.label ?? b.code}
                  </option>
                ))}
              </select>
              <span className="field__help">
                The forecast is this brand’s own curve, scaled to the sales below.
              </span>
            </label>

            <label className="field">
              <span className="field__label">Branch name</span>
              <input
                className="field__input"
                id="newstore-name"
                value={branchName}
                placeholder="BBT – New Location"
                onChange={(e) => setBranchName(e.target.value)}
              />
            </label>

            <label className="field">
              <span className="field__label">Opening date</span>
              <input
                className="field__input"
                id="newstore-date"
                type="date"
                value={openingDate}
                onChange={(e) => {
                  setOpeningDate(e.target.value)
                  setExclude([])
                  loadMenu(brand, e.target.value)
                }}
              />
            </label>

            {/* The window, as soon as there is one. It answers "what am I
                about to size" before anything is fetched.

                `.issued` is a horizontal row by default; this one stacks,
                because it carries a value, a row of pills and a caveat. */}
            {openingDate && (
              <div
                className="issued"
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--s2)' }}
              >
                <span className="issued__label">Forecast window</span>
                <span className="issued__value">
                  {longDate(openingDate)} – {longDate(endsOn)}
                </span>
                <div className="choices choices--wrap">
                  {periods.map((p) => (
                    <Pill key={p.period} tone={monthTone(p.period)}>
                      {monthLabel(p.period)} · {shortDate(p.from)}–{shortDate(p.to)}
                    </Pill>
                  ))}
                  <Pill tone="slate">{fmtInt(windowDays)} days</Pill>
                </div>
                <span className="field__help">
                  Three months of thirty days each, counted from the opening day rather than from
                  the calendar — so the three figures you type are comparable to each other
                  whatever day of the month the branch opens.
                </span>
              </div>
            )}

            <label className="field">
              <span className="field__label">Products this branch will not sell</span>
              <MultiSelect
                label="Exclude"
                options={menu}
                value={exclude}
                onChange={setExclude}
                placeholder={menu.length ? 'None excluded' : 'Pick a brand and date first'}
              />
              <span className="field__help">
                {menu.length
                  ? `${fmtInt(menu.length)} products on this brand’s menu for the window. Excluding one drops its quantity — it is not shared out across the rest.`
                  : 'Choose a brand and an opening date to load the menu.'}
              </span>
            </label>
          </div>
        </Panel>

        <Panel
          title="Expected sales"
          sub="One figure per thirty-day month, in KD. This is the only thing that sizes the forecast — every product quantity is this, converted at the brand’s own rate per KD."
        >
          <div className="stack" style={{ padding: 'var(--s4)', gap: 'var(--s4)' }}>
            {[0, 1, 2].map((i) => (
              <label className="field" key={i}>
                {/* The month's own colour, so the box you are typing in and
                    the column it ends up in are visibly the same month. */}
                <span
                  className="field__label"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s2)' }}
                >
                  <Pill tone={monthTone(i + 1)}>{monthLabel(i + 1)}</Pill>
                  {dayRange(i + 1)}
                  {periods[i] ? ` · ${shortDate(periods[i].from)}–${shortDate(periods[i].to)}` : ''}
                </span>
                <input
                  className="field__input"
                  id={`newstore-sales-${i}`}
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={sales[i]}
                  placeholder="0 KD"
                  onChange={(e) =>
                    setSales((s) => s.map((v, k) => (k === i ? e.target.value : v)))
                  }
                />
              </label>
            ))}

            {typedTotal > 0 && (
              <div className="issued">
                <span className="issued__label">Over the window</span>
                <span className="issued__value">{money(typedTotal)}</span>
              </div>
            )}

            <div>
              <button
                type="button"
                className="btn"
                disabled={!ready || busy}
                onClick={generate}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {busy ? 'Generating…' : 'Generate forecast'}
              </button>
              {missing.length > 0 && (
                <span className="field__help" style={{ display: 'block', marginTop: 'var(--s2)' }}>
                  Still needs {missing.join(', ')}.
                </span>
              )}
            </div>
          </div>
        </Panel>
      </div>

      {error && <ErrorBanner error={error} onRetry={generate} />}

      {/*
        * Before the first Generate the page would otherwise be a form and
        * nothing else, which reads as broken rather than as waiting. This says
        * what is about to happen and what the method is, so the output is not
        * the first time anybody meets it.
        */}
      {!result && !busy && !error && (
        <Panel title="What this will produce">
          <div style={{ padding: 'var(--s4)' }}>
            <p className="review__intro">
              A product-by-product forecast for the branch’s first ninety days, in three equal
              months of thirty — the same shape the brand’s existing branches are forecast to
              follow, scaled to the sales you expect the new one to do. Readable day by day or
              month by month from one table.
            </p>
            {/* `.why` rather than `.score__cell`: the latter carries a green
                status border, and these are explanations, not a verdict. */}
            <div className="grid2" style={{ marginTop: 'var(--s4)' }}>
              <div className="why">
                <div>
                  <span className="why__label">How a quantity is worked out</span>
                  <p className="why__detail">
                    The brand’s own product quantity per KD of its own sales, over that month’s
                    own thirty dates, multiplied by the sales you enter — then spread across those
                    days in the proportion the brand is forecast to sell them.
                  </p>
                </div>
              </div>
              <div className="why">
                <div>
                  <span className="why__label">What you can rely on</span>
                  <p className="why__detail">
                    Each product’s daily quantities add up to its monthly quantity exactly, in
                    whole units — so the two views of the table can never disagree. Nothing is
                    stored; change an input and generate again.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Panel>
      )}

      {result && !result.available && (
        <InfoBanner tone="warn">
          <strong>No forecast for this window yet.</strong> {result.reason}
        </InfoBanner>
      )}

      {result?.available && (
        <>
          {/*
            * Months the data cannot back, said plainly and before anything
            * else. This is the state the page is in for every opening date
            * from today until the 2027 spine lands, so it cannot be a footnote.
            */}
          {result.periods.some((p) => !p.available) && (
            <InfoBanner tone="warn">
              <strong>
                {result.periods.filter((p) => !p.available).length} of {result.periods.length} months
                could not be forecast.
              </strong>{' '}
              {result.periods
                .filter((p) => !p.available)
                .map((p) => `${monthLabel(p.period)} (${p.covered}/${p.days} days)`)
                .join(' and ')}{' '}
              {result.coverage?.lastCovered
                ? `— the product forecast data stops at ${longDate(result.coverage.lastCovered)}.`
                : '— the product forecast does not cover those dates.'}{' '}
              Those months show N/A rather than a quantity. Nothing has been substituted from
              another year, extrapolated, or scaled up from the days that do exist.
            </InfoBanner>
          )}

          {/*
            * Rounding at PLU grain, stated rather than absorbed.
            *
            * Whole units are allocated per PLU per day, so a code carrying
            * under half a unit a day can round to nothing. Shown only when it
            * actually costs something a reader would notice.
            */}
          {result.rounding?.zeroed > 0 && (
            <InfoBanner tone="info">
              <strong>Forecast is per PLU.</strong> {fmtInt(result.rounding.zeroed)} PLU
              {result.rounding.zeroed === 1 ? '' : 's'} forecast under half a unit a day and round
              to nothing, costing {fmtQty(Math.max(0, result.rounding.lost))} units of{' '}
              {fmtQty(result.rounding.exact)} — {fmtPct(
                result.rounding.exact > 0 ? result.rounding.lost / result.rounding.exact : 0,
                2
              )}
              . Group the table by Product to see a product’s codes totalled back together.
            </InfoBanner>
          )}

          {shortfall.gap > 1 && (
            <InfoBanner tone="warn">
              <strong>Excluded products leave a gap.</strong> The products you excluded account for
              part of the brand’s sales, so this forecast covers{' '}
              <strong>{money(shortfall.implied)}</strong> of the{' '}
              <strong>{money(shortfall.typed)}</strong> you entered. The remaining products were not
              scaled up to close it.
            </InfoBanner>
          )}

          {/*
            * The cards carry the page's colour.
            *
            * Each gets the icon of what it counts and an accent that stays with
            * that card, so the row reads as four distinct things rather than
            * four grey boxes. The only progress bar that fills is the one with
            * a real denominator - the share of the brand's menu this branch
            * will actually sell. A bar on a figure with nothing to be a
            * fraction OF would be decoration pretending to be information.
            */}
          <div className="kpis">
            <KpiCard
              label={
                <>
                  Branch
                  {windowChip && <span className="nso__chip">{windowChip}</span>}
                </>
              }
              accent="blue"
              icon={<IconWarehouse size={15} />}
              value={result.branchName}
              textValue
              foot={`${result.brand} · opens ${longDate(result.openingDate)}`}
            />
            <KpiCard
              label={
                <>
                  Window
                  {windowChip && <span className="nso__chip">{windowChip}</span>}
                </>
              }
              accent="slate"
              icon={<IconCalendar size={15} />}
              value={`${totals.days} days`}
              foot="three thirty-day months from the opening day"
            />
            <KpiCard
              label="Products"
              accent="amber"
              icon={<IconProduct size={15} />}
              value={fmtInt(result.products?.length ?? 0)}
              progress={
                menu.length ? (result.products?.length ?? 0) / menu.length : undefined
              }
              foot={
                exclude.length
                  ? `${fmtInt(exclude.length)} excluded from a ${fmtInt(menu.length)}-product menu`
                  : 'the whole brand menu'
              }
            />
            <KpiCard
              label="Total units"
              accent="green"
              icon={<IconBox size={15} />}
              value={fmtQty(totals.qty)}
              foot="whole units over the ninety days"
            />
          </div>

          {/*
            * The counts strip: the two plain tallies that do not deserve a card
            * of their own but do deserve to be visible before the table.
            */}
          <div className="nso__counts">
            <span className="nso__counts-tag">Counts</span>
            <div className="nso__counts-item">
              <span className="nso__counts-label">Rows generated</span>
              <span className="nso__counts-value">{fmtInt(rows.length)}</span>
              <span className="nso__counts-foot">One per product per day</span>
            </div>
            <div className="nso__counts-item">
              <span className="nso__counts-label">PLUs forecast</span>
              <span className="nso__counts-value">{fmtInt(periodRows.length)}</span>
              <span className="nso__counts-foot">
                across {fmtInt(result.products?.length ?? 0)} products
              </span>
            </div>
            <div className="nso__counts-item">
              <span className="nso__counts-label">Days covered</span>
              <span className="nso__counts-value">{fmtInt(totals.days)}</span>
              <span className="nso__counts-foot">
                {shortDate(result.window.from)} – {shortDate(result.window.to)}
              </span>
            </div>
          </div>

          <Panel
            title="By month"
            count={result.periods.length}
            sub="What each thirty-day month was sized from. The rate is the brand's own quantity per KD of its own sales over that month's own dates, so your sales figure is what scales it."
          >
            <DataTable
              tableId="newstore-periods"
              columns={[
                {
                  key: 'period',
                  label: 'Month',
                  render: (v) => <Pill tone={monthTone(v)}>{monthLabel(v)}</Pill>,
                },
                {
                  key: 'from',
                  label: 'Dates',
                  autoWidth: true,
                  render: (v, row) => `${shortDate(v)} – ${shortDate(row.to)}`,
                },
                {
                  key: 'days',
                  label: 'Days since opening',
                  autoWidth: true,
                  hint: 'These are thirty-day months counted from the opening day, not calendar months.',
                  render: (v, row) => dayRange(row.period),
                },
                {
                  key: 'covered',
                  label: 'Historical coverage',
                  autoWidth: true,
                  hint: 'How many of the month’s thirty dates the product forecast actually holds data for. A month is only calculated at 30/30 — anything less is refused rather than pro-rated, because a part-covered month divides a few days of product quantity by thirty days of sales and produces a confident wrong answer.',
                  render: (v, row) => (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s2)' }}>
                      <Pill tone={COVERAGE_TONE[row.status] ?? 'slate'}>
                        {COVERAGE_LABEL[row.status] ?? row.status}
                      </Pill>
                      <span className="muted">
                        {v}/{row.days}
                      </span>
                    </span>
                  ),
                },
                { key: 'sales', label: 'Your sales', num: true, autoWidth: true, render: money },
                {
                  key: 'brandSales',
                  label: 'Brand sales',
                  num: true,
                  autoWidth: true,
                  hint: 'The brand’s own forecast sales over this month’s thirty dates — the denominator of the rate. Blank where the month is not calculated: a sales figure beside a missing quantity would read as measured demand of nothing.',
                  render: (v) => naCell(v, money),
                },
                {
                  key: 'productQty',
                  label: 'Product units',
                  num: true,
                  autoWidth: true,
                  strong: true,
                  hint: 'N/A where the month has incomplete historical coverage. Never zero — zero is a quantity somebody would order against.',
                  render: (v) => naCell(v, fmtQty),
                },
              ]}
              rows={result.periods}
            />
          </Panel>

          {/*
            * ONE table, two grains.
            *
            * The toggle is in the panel's tools rather than above it, beside
            * the download, because switching grain and exporting are the two
            * things done to this table and they belong together. Whichever
            * grain is showing is the one that downloads.
            */}
          <Panel
            title={`${result.branchName} — product forecast`}
            count={tableRows.length}
            sub={
              grain === 'daily'
                ? 'One row per product per day. The daily quantities add up to the monthly figure for each product exactly — switch to Monthly to see those totals.'
                : 'One row per product, one column per thirty-day month. These are the daily figures added up, so the two views cannot disagree.'
            }
            tools={
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={!tableRows.length}
                  onClick={() =>
                    downloadCsv(
                      `${result.brand} ${result.branchName} ${grain} forecast.csv`,
                      withAllPlus(tableRows, result),
                      [
                        ...tableColumns.map(({ key, label }) => ({ key, label })),
                        { key: 'Product_PLU_All', label: 'All PLUs' },
                      ],
                      [
                        ['Branch', result.branchName],
                        ['Brand', result.brand],
                        ['Opening date', result.openingDate],
                        ['Window', `${result.window.from} to ${result.window.to} (90 days)`],
                        ['Months', 'Three of thirty days each, counted from the opening day: days 1-30, 31-60, 61-90. NOT calendar months.'],
                        [
                          'Grain',
                          grain === 'daily'
                            ? 'One row per PLU per day.'
                            : 'One row per PLU; one column per thirty-day month.',
                        ],
                        [
                          'Historical coverage',
                          result.periods
                            .map(
                              (p) =>
                                `${monthLabel(p.period)} ${p.covered}/${p.days} ${COVERAGE_LABEL[p.status]}`
                            )
                            .join('; ') +
                            '. Only months with 30/30 coverage are calculated; the rest are N/A, never zero.',
                        ],
                        ['Method', 'The brand’s own forecast curve for these dates, scaled to the sales entered for the new branch. Rate = brand product qty / brand sales KD over the month’s own dates.'],
                        ['Rounding', 'Largest remainder: the month’s quantity is shared out by the daily weights and the spare whole units given to the busiest days, so the days add up to the month exactly.'],
                        ['Excluded products', exclude.length ? exclude.join('; ') : 'none'],
                        ...(shortfall.gap > 1
                          ? [['Shortfall', `Excluded products mean this covers ${money(shortfall.implied)} of the ${money(shortfall.typed)} entered. Remaining products were NOT scaled up.`]]
                          : []),
                      ]
                    )
                  }
                >
                  <IconDownload size={12} />
                  CSV
                </button>
              </>
            }
          >
            {/*
              * The grain switch, in the panel BODY rather than its tools.
              *
              * It sat in the tools beside the CSV button, where it read as two
              * more small grey chips in a corner - easy to miss entirely, which
              * is fatal for the one control that decides what the table is. Here
              * it is full width, labelled, and the first thing under the title,
              * so the table always announces which of its two forms you are
              * looking at.
              */}
            <div
              className="stack"
              style={{ padding: 'var(--s4)', paddingBottom: 'var(--s3)', gap: 'var(--s2)' }}
            >
              <span className="field__label">Show the forecast by</span>
              <div className="nso__tabs" role="group" aria-label="Forecast grain">
                {[
                  ['period', 'Monthly', 'One row per product, three 30-day months'],
                  ['daily', 'Daily', 'One row per product per day'],
                ].map(([id, label, what]) => (
                  <button
                    key={id}
                    type="button"
                    className={`nso__tab${grain === id ? ' nso__tab--on' : ''}`}
                    aria-pressed={grain === id}
                    title={what}
                    onClick={() => setGrain(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {tableRows.length === 0 ? (
              <Empty title="Nothing to forecast">
                The brand has no forecast quantity in this window.
              </Empty>
            ) : grain === 'daily' ? (
              <DataTable
                /*
                 * Bumped from `newstore-daily`.
                 *
                 * `hiddenByDefault` is read only when the browser holds no
                 * saved column choice for the id, and anyone who has opened
                 * this page already has one - so under the old id the four
                 * working columns would have stayed on and the change would
                 * have looked like it did nothing. A new id starts from the
                 * defaults; the cost is that a reader who had hand-picked
                 * columns here loses that pick once.
                 */
                tableId="newstore-daily-2"
                columns={tableColumns}
                rows={tableRows}
                groupable={[
                  { key: 'Forecast_Date', label: 'Date' },
                  { key: 'Product', label: 'Product' },
                  { key: 'Product_PLU', label: 'PLU' },
                  { key: 'Period', label: 'Month' },
                ]}
                initialGroupBy="Forecast_Date"
                freezable
                totals
                searchPlaceholder="Search product or date…"
              />
            ) : (
              <DataTable
                tableId="newstore-period"
                columns={tableColumns}
                rows={tableRows}
                initialSort={{ key: 'Total', dir: 'desc' }}
                freezable
                totals
                searchPlaceholder="Search product…"
              />
            )}
          </Panel>
        </>
      )}
    </div>
  )
}

export default NewStore
