import { useEffect, useMemo, useState } from 'react'
import { api, fmtInt, fmtPct, fmtDate, downloadCsv } from '../api.js'
import { isFutureWindow } from '../window.js'
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
  // The ERP article number: the key the warehouse knows this component by, and
  // the reason a consumption figure can be put beside a recipe figure at all.
  { key: 'Item No.', label: 'Article', width: 104, hiddenByDefault: true },
  /*
   * Consumed, not "actual".
   *
   * The old actual came from the same place as the forecast — recipe quantities
   * multiplied by sales that happened — so it was a second theoretical figure
   * wearing the word actual. It could not show waste, over-portioning or
   * spillage, because none of those are in a recipe.
   *
   * This one is measured: what the warehouse and the kitchens actually issued to
   * this brand's shops, in the article's own base unit.
   *
   * It is not totalled, and that is deliberate. Consumption belongs to an
   * article, while these rows are split by recipe group, so the figure sits on
   * one row per article and the others are blank. A column total would either
   * count it once per recipe or need an allocation nobody has agreed.
   */
  {
    key: 'Consumed_Qty',
    label: 'Consumed',
    width: W.qty,
    num: true,
    strong: true,
    /*
     * It does total, and correctly: the figure sits on exactly one row per
     * article and every other row is blank, so adding the column counts each
     * article once. The blanks are the reason — they are not zeros, they mean
     * "counted on another line".
     *
     * Filtering is the case to know about: an article whose carrying row falls
     * outside a search or a recipe-group filter takes its consumption with it
     * while its other rows stay. The total is then of what is on screen, which
     * is what a total under a filtered table means everywhere else.
     */
    total: 'sum',
    renderTotal: fmtInt,
    // A dash is not zero, and the difference matters here. Rather than leave
    // somebody guessing which it is, the blank says why it is blank.
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Counted on this article's largest line. Consumption belongs to an article, so it is shown once rather than repeated on every recipe that uses it — and it is not available at all when the table is split by branch."
        >
          –
        </span>
      ) : (
        fmtInt(v)
      ),
  },
  { key: 'Component_Forecast_Qty', label: 'Forecast qty', width: W.qty, num: true, total: 'sum', render: fmtInt, renderTotal: fmtInt },
  /*
   * The article's whole requirement, not this recipe group's share of it.
   *
   * Consumption is an article-level fact — the warehouse issues flour, not
   * flour-for-the-burger-recipe — so comparing it against one recipe group's
   * line is comparing two different things. This column adds the article back
   * up across every group in view, which is the figure that is actually
   * comparable with Consumed, and the figure somebody orders against.
   *
   * It repeats on every row of the same article, so it is deliberately not
   * summed: a footer would count each article once per recipe it appears in.
   */
  {
    key: 'Article_Forecast_Qty',
    label: 'Total for article',
    width: W.qty,
    num: true,
    render: fmtInt,
  },
  /*
   * Accuracy of the article's requirement against what actually moved.
   *
   * A property of the article rather than of the row, so it reads the same on
   * every line of that article. Blank where nothing moved: a component with a
   * requirement and no transfer is unmeasured, not badly forecast, and scoring
   * it zero would say the opposite.
   *
   * The footer averages the per-article figures rather than deriving one from
   * the totals — each article's accuracy is already unit-free, and totalling
   * first would let the large "Each" lines decide the number for kilograms too.
   */
  {
    key: 'Accuracy',
    label: 'Accuracy',
    width: W.pct,
    num: true,
    render: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
    total: (list) => {
      const seen = new Map()
      for (const r of list) {
        const a = String(r['Item No.'] ?? '').trim()
        if (!a || r.Accuracy === null || r.Accuracy === undefined) continue
        if (!seen.has(a)) seen.set(a, r.Accuracy)
      }
      if (!seen.size) return null
      return [...seen.values()].reduce((x, y) => x + y, 0) / seen.size
    },
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },
  // Kept, and no longer called an actual: it is what the recipes imply the
  // sales used, which is the thing consumption is worth comparing against.
  { key: 'Component_Actual_Qty', label: 'Implied by sales', width: W.qty, num: true, hiddenByDefault: true, total: 'sum', render: fmtInt, renderTotal: fmtInt },
]

/** Mirrors the report's COMPONENT LEVEL page. */
export function ComponentLevel({ filters, options, ready, refreshNonce, onLoaded }) {
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

  /**
   * Roll each article back up, and score it.
   *
   * Consumption arrives on one row per article and the requirement is split
   * across every recipe group that uses it, so neither can be read against the
   * other line by line. Adding the requirement back up per article puts both on
   * the same footing, and that is what accuracy is computed from.
   */
  const priced = useMemo(() => {
    const perArticle = new Map()
    for (const r of rows) {
      const a = String(r['Item No.'] ?? '').trim()
      if (!a) continue
      const held = perArticle.get(a) ?? { forecast: 0, consumed: 0, measured: false }
      held.forecast += Number(r.Component_Forecast_Qty) || 0
      if (r.Consumed_Qty !== null && r.Consumed_Qty !== undefined) {
        held.consumed += Number(r.Consumed_Qty) || 0
        held.measured = true
      }
      perArticle.set(a, held)
    }

    return rows.map((r) => {
      const a = String(r['Item No.'] ?? '').trim()
      const held = a ? perArticle.get(a) : null
      const forecast = held ? held.forecast : Number(r.Component_Forecast_Qty) || 0
      const accuracy =
        held && held.measured && forecast
          ? Math.max(0, 1 - Math.abs(held.consumed - forecast) / forecast)
          : null
      return { ...r, Article_Forecast_Qty: forecast, Accuracy: accuracy }
    })
  }, [rows])

  const top = useMemo(
    () => [...rows].sort((a, b) => b.Component_Forecast_Qty - a.Component_Forecast_Qty)[0],
    [rows]
  )

  /**
   * The totals, and how close the requirement came to what actually moved.
   *
   * Two things need saying about the quantities. They add across units of
   * measure — kilograms and pieces in one number — because the page is a list
   * of everything a brand needs, and the cards on the right are where each unit
   * is totalled on its own. The card says so rather than pretending otherwise.
   *
   * Accuracy does not have that problem, and is deliberately computed a
   * different way: per component, then averaged. Each component's accuracy is a
   * ratio of two figures in the same unit, so it is unit-free before anything
   * is added, and a kilogram of flour weighs the same as a box of gloves in the
   * average. Totalling first and dividing after would let the largest "Each"
   * lines decide the number for every unit.
   *
   * Only components with both a requirement and a movement count. One with no
   * transfer is not 0% accurate, it is unmeasured — and scoring it zero would
   * read as a terrible forecast rather than an absent one.
   */
  const summary = useMemo(() => {
    let forecast = 0
    let consumed = 0
    let scored = 0
    let accuracySum = 0

    /*
     * Scored per article, from the rolled-up figures, so the card and the
     * column agree. Doing it per row compared an article's whole consumption
     * against one recipe group's share of the requirement, which understated
     * accuracy for every component used by more than one recipe.
     */
    const seen = new Set()
    for (const r of priced) {
      forecast += Number(r.Component_Forecast_Qty) || 0
      const c = r.Consumed_Qty
      if (c !== null && c !== undefined) consumed += Number(c) || 0

      const a = String(r['Item No.'] ?? '').trim()
      if (!a || seen.has(a) || r.Accuracy === null) continue
      seen.add(a)
      accuracySum += r.Accuracy
      scored += 1
    }

    return {
      forecast,
      consumed,
      measured: scored,
      accuracy: scored ? accuracySum / scored : null,
    }
  }, [priced])

  /**
   * Top components for every unit of measure.
   *
   * Kilograms, litres and "each" cannot share an axis, and one chart per unit
   * would be a wall of charts once a selection spans eight of them. So each unit
   * gets a short ranked list with the bar drawn relative to its own leader —
   * comparable within a unit, never across, which is the only honest reading.
   */
  const facets = useMemo(() => {
    /*
     * One line per component, not one per recipe it appears in.
     *
     * The table splits a component by recipe group, which is right there — you
     * order against the recipe. Ranked, it read as a fault: "Saj Bread Mishmash"
     * four times over, "Chicken Breast Uncalibrated" three times, each one a
     * different recipe group but the names cut off at the same width, so the
     * card looked like it was repeating itself. Worse, none of the four was the
     * real figure for that bread — the requirement is their sum.
     *
     * Adding across recipe groups is the same reasoning the API already applies
     * across brands: a component in two recipes is one thing to order. Adding
     * across units would not be, so that stays split — a kilogram and an "each"
     * share no axis.
     */
    const byUnit = new Map()
    for (const r of rows) {
      const unit = r.BU || '—'
      if (!byUnit.has(unit)) byUnit.set(unit, new Map())
      const items = byUnit.get(unit)
      const key = r.Item
      const prev = items.get(key) ?? { Item: key, Component_Forecast_Qty: 0, Component_Actual_Qty: 0 }
      prev.Component_Forecast_Qty += Number(r.Component_Forecast_Qty) || 0
      prev.Component_Actual_Qty += Number(r.Component_Actual_Qty) || 0
      items.set(key, prev)
    }

    return [...byUnit.entries()]
      .map(([unit, items]) => {
        const ranked = [...items.values()].sort(
          (a, b) => b.Component_Forecast_Qty - a.Component_Forecast_Qty
        )
        return {
          unit,
          // The card scrolls, so the list is not cut to whatever happened to
          // fit. Twenty is where a ranking stops being a ranking.
          rows: ranked.slice(0, 20),
          leader: Number(ranked[0]?.Component_Forecast_Qty) || 0,
          count: ranked.length,
          total: ranked.reduce((a, r) => a + r.Component_Forecast_Qty, 0),
        }
      })
      .sort((a, b) => b.count - a.count)
  }, [rows])

  /*
   * Tomorrow has no actual and never will until it arrives.
   *
   * The same rule the Products table follows: a component requirement for a day
   * nobody has cooked is a plan, not a shortfall, and a column of zeroes beside
   * the forecast reads as one.
   */
  const future = isFutureWindow(filters, options?.dateRange)
  const columns = useMemo(
    () =>
      future
        ? COLUMNS.filter((c) => c.key !== 'Component_Actual_Qty' && c.key !== 'Consumed_Qty')
        : COLUMNS,
    [future]
  )

  const groups = useMemo(() => new Set(rows.map((r) => r['Recipe Group'])).size, [rows])

  const units = useMemo(() => [...new Set(rows.map((r) => r.BU).filter(Boolean))], [rows])

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  return (
    <>
      <div className="metrics">
        <MetricCard
          label="Forecast requirement"
          accent="blue"
          progress={1}
          loading={busy}
          value={fmtInt(summary.forecast)}
          foot={
            units.length > 1
              ? `Across ${units.length} units — ${units.join(', ')}`
              : units[0] || 'Total requirement'
          }
        />
        <MetricCard
          label="Consumed"
          accent="green"
          progress={summary.forecast ? Math.min(1, summary.consumed / summary.forecast) : 0}
          loading={busy}
          value={summary.measured ? fmtInt(summary.consumed) : '–'}
          foot={
            summary.measured
              ? `Actually issued, ${fmtInt(summary.measured)} components measured`
              : 'No transfers matched this view'
          }
        />
        <MetricCard
          label="Accuracy"
          accent={summary.accuracy === null ? 'slate' : summary.accuracy >= 0.9 ? 'green' : 'amber'}
          progress={summary.accuracy ?? 0}
          loading={busy}
          value={summary.accuracy === null ? '–' : fmtPct(summary.accuracy, 1)}
          foot={
            summary.accuracy === null
              ? 'Needs consumption to compare against'
              : 'Requirement against what moved, per component'
          }
        />
        <MetricCard
          label="Components"
          accent="slate"
          progress={0.72}
          loading={busy}
          value={fmtInt(rows.length)}
          foot={`${fmtInt(groups)} recipe groups`}
        />
        <MetricCard
          label="Largest requirement"
          accent="green"
          progress={1}
          loading={busy}
          textValue
          value={top?.Item ?? '–'}
          foot={top ? `${fmtInt(top.Component_Forecast_Qty)} ${top.BU}` : undefined}
        />
      </div>

      {/* The table first, at full width, and the per-unit rankings beneath it.
          Side by side, the table lost a third of its columns to a column of
          cards that is read after it, not with it. */}
      <Panel
        title="Component detail"
        count={busy ? undefined : `${rows.length.toLocaleString()} rows`}
        sub="What the forecast implies you need, beside what actually left the warehouse"
        flush
        fill
        tools={
          <button
            type="button"
            className="btn"
            disabled={!rows.length}
            onClick={() =>
              downloadCsv('bbt-component-level.csv', priced, columns.map(({ key, label }) => ({ key, label })))
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
            columns={columns}
            rows={priced}
            totals
            initialSort={{ key: 'Component_Forecast_Qty', dir: 'desc' }}
            searchPlaceholder="Search component or group…"
            tableId="component-detail"
            onColumnsChange={setHiddenCols}
            fill
          />
        )}
      </Panel>
      {/*
        * One card per unit, three of them, none of them scrolling.
        *
        * These were a single panel holding every unit in a scrolling list, which
        * put the second unit below the fold and the rest out of sight entirely —
        * a ranking nobody scrolls is a ranking nobody reads. Three cards share
        * the column height evenly, so all three are visible at once and the last
        * one ends level with the table beside it.
        *
        * Kilograms and "each" share no axis, so each card draws its bars against
        * its own leader and never across units. Any unit past the third is still
        * in the table on the left, and the note under the stack says so rather
        * than letting it disappear.
        */}
      <div className="unitrow">
        {busy ? (
          <>
            <ChartSkeleton height={150} />
            <ChartSkeleton height={150} />
            <ChartSkeleton height={150} />
          </>
        ) : facets.length === 0 ? (
          <Panel title="Top components by unit">
            <Empty />
          </Panel>
        ) : (
          <>
            {facets.slice(0, 3).map((facet) => (
              <Panel
                key={facet.unit}
                title={`Top by ${facet.unit.toLowerCase()}`}
                sub={`${fmtInt(facet.total)} across ${fmtInt(facet.count)} component${
                  facet.count === 1 ? '' : 's'
                } · bars compare within this unit`}
              >
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
                            width: `${
                              facet.leader
                                ? Math.max(2, (r.Component_Forecast_Qty / facet.leader) * 100)
                                : 0
                            }%`,
                          }}
                        />
                      </span>
                      <span className="units__value">{fmtInt(r.Component_Forecast_Qty)}</span>
                    </li>
                  ))}
                </ol>
              </Panel>
            ))}
            {facets.length > 3 && (
              <p className="unitcol__more">
                {facets.length - 3} further unit{facets.length - 3 === 1 ? '' : 's'} (
                {facets.slice(3).map((f) => f.unit).join(', ')}) — in the table above.
              </p>
            )}
          </>
        )}
      </div>
    </>
  )
}
