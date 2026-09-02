import { useEffect, useMemo, useState } from 'react'
import { api, fmtInt, fmtPct, fmtDate, downloadCsv } from '../api.js'
import { isFutureWindow } from '../window.js'
import { useData } from '../useData.js'
import { W } from '../columns.js'
import { FmNotice, Panel, ErrorBanner, ChartSkeleton, Empty, Pill, MetricCard } from '../components/ui.jsx'
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
  // Off by default — asked for on 1 Sep 2026. The table opens on the five
  // columns somebody reads: what it is, what kind, in what unit, what moved and
  // what is needed. Recipe group and the article number are a click away in
  // Build view for anyone who wants them.
  { key: 'Recipe Group', label: 'Recipe group', width: W.group, hiddenByDefault: true },
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
  { key: 'Item No.', label: 'Article No.', width: 104, hiddenByDefault: true },
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
    // Outbound, not "consumed" — asked for on 1 Sep 2026, and it is the more
    // exact word. This is what left the warehouse for this brand's shops. What
    // the shops then actually used is a different quantity nothing measures.
    label: 'Outbound',
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
    // Two different blanks, and they mean opposite things, so the tooltip says
    // which. One is "counted on another line of this article"; the other is
    // "the warehouse has no record of this article at all", which is a gap in
    // what can be measured rather than anything about the forecast.
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title={
            row?.Consumed_Unknown
              ? 'The warehouse has never issued this article to this brand, so there is nothing to compare against. It may reach the shops another way, or the article code may not match.'
              : "Counted on this article's largest line. Outbound belongs to an article, so it is shown once rather than repeated on every recipe that uses it — and it is not available at all when the table is split by branch."
          }
        >
          –
        </span>
      ) : (
        fmtInt(v)
      ),
  },
  { key: 'Component_Forecast_Qty', label: 'Forecast qty', width: W.qty, num: true, total: 'sum', render: fmtInt, renderTotal: fmtInt },
  /*
   * What has gone out so far, against a window that has not finished.
   *
   * Outbound beside it covers the whole selection; this stops at today. Pick
   * September on the tenth and this reads the first to the tenth, so the
   * month's requirement can be read against the part already drawn.
   *
   * Asked of the warehouse directly rather than of the hourly copy — a figure
   * called live has to be — but held for five minutes, because nine brands
   * asking afresh on every request is the burst that gets the whole page
   * refused for a minute.
   *
   * Blank on a window that has already ended: there is no "so far" about a
   * finished month, and a second column repeating the first under a different
   * name only invites the question of why they differ.
   */
  {
    key: 'Live_Outbound_MTD',
    label: 'Live outbound MTD',
    width: 132,
    num: true,
    total: 'sum',
    renderTotal: fmtInt,
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted" title="Nothing yet — this window has not started. The figure runs from the start of the selected window up to today.">
          –
        </span>
      ) : (
        fmtInt(v)
      ),
  },
  /*
   * The same article, forecast without touching a recipe.
   *
   * The constant is a rate: how much of this article the warehouse shipped per
   * unit the brand sold, measured over each of the last six whole months and
   * averaged. Multiplied by the sales forecast for the window on screen, it is
   * a requirement derived from what actually happened rather than from what the
   * recipe tree says should happen.
   *
   * It sits beside Forecast qty on purpose. Where the two agree, the recipe is
   * corroborated by six months of warehouse behaviour. Where they disagree, one
   * of them is wrong — and given the recipe explosion double counts across
   * levels and misses 39% of volume entirely, it is worth knowing which rows
   * those are.
   */
  {
    key: 'WH_Constant_Forecast_Qty',
    // Named for what it is rather than how it is built. "Forecast constant WH"
    // described the method; beside a column simply called "Forecast qty" what a
    // reader needs is the difference between them, which is where each figure
    // came from — the recipes, or the warehouse's own history.
    label: 'Warehouse forecast',
    width: 140,
    num: true,
    total: 'sum',
    renderTotal: fmtInt,
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted" title="No warehouse history for this article in the last six months, so there is no ratio to forecast from.">
          –
        </span>
      ) : (
        fmtInt(v)
      ),
  },
  /*
   * How close this article's whole requirement came to what actually moved.
   *
   * A property of the article, not of the row, so it reads the same on every
   * recipe group that uses it — the warehouse issues flour, not flour-for-the-
   * burger, and scoring one recipe's share against the article's whole
   * consumption would mark every shared ingredient down for being shared.
   *
   * Blank has one meaning here: the warehouse has never shipped this article to
   * this brand, so there is nothing to score against. An article it does ship
   * and did not ship this window scores a real 0% — that one is a miss.
   *
   * The footer averages the article scores rather than deriving one from the
   * column totals. Each score is already a ratio of two figures in the same
   * unit, so it is unit-free before anything is added; totalling first would
   * let the millions of "Each" decide the number for kilograms too.
   */
  {
    key: 'Accuracy',
    label: 'Accuracy',
    width: W.pct,
    num: true,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title={
            row?.Consumed_Unknown
              ? 'The warehouse has never issued this article to this brand, so there is nothing to score against.'
              : 'Not enough to compare — nothing went out for this article in the window.'
          }
        >
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    total: (list) => {
      // Once per article: the score repeats on every row of it.
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
      const saved = JSON.parse(localStorage.getItem('df-cols-component-detail-v2') || 'null')
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
      /*
       * Divided by the larger of the two, not by the forecast.
       *
       * With the forecast on the bottom the same discrepancy scored two very
       * different ways depending on its direction: an article forecast at 31,268
       * that the warehouse issued 169,500 of came out at −442%, clamped to zero,
       * while the same 5.4x gap the other way scored 18%. 204 of 1,135
       * components were being clamped to zero that way, so the card was largely
       * reporting how often it had run off the end of its own scale.
       *
       * Against the larger figure the answer is symmetric and already between
       * zero and one, so nothing has to be clamped: equal quantities score 100%,
       * one side twice the other scores 50%, and nothing issued scores 0%.
       */
      const measurable = held && held.measured && (held.consumed > 0 || forecast > 0)
      const accuracy = measurable
        ? 1 - Math.abs(held.consumed - forecast) / Math.max(held.consumed, forecast)
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
     * The requirement for the articles the consumption total actually covers.
     *
     * Not the same as `forecast`, and the difference is the point. `forecast` is
     * every row on the page; `consumed` can only be the articles the warehouse
     * has records for. Comparing the two directly counts every unmatched
     * component as a total miss — the same mistake as scoring them zero, made
     * one level up. So the headline compares like with like.
     */
    let matchedForecast = 0
    // Components with a requirement the warehouse has no record of shipping.
    // Counted rather than scored: nothing about them says the forecast is wrong,
    // and scoring them zero is what made this card unreadable.
    const unmatched = new Set()

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
      if (!a) continue
      if (r.Accuracy === null) {
        if (r.Consumed_Unknown) unmatched.add(a)
        continue
      }
      if (seen.has(a)) continue
      seen.add(a)
      accuracySum += r.Accuracy
      scored += 1
      // Once per article: the roll-up repeats on every row of it.
      matchedForecast += Number(r.Article_Forecast_Qty) || 0
    }

    /*
     * Two honest answers to "how accurate is this", and they are not the same
     * question.
     *
     * The headline compares the totals, which is what the two cards beside it
     * show and what anybody reading them expects to be able to check by hand.
     * The foot gives the average component, which is far lower — because the
     * totals can agree while every component inside them is wrong, one over-
     * forecast cancelling the next. Both are true; the gap between them is
     * itself the finding, and hiding either one would misrepresent the page.
     *
     * Divided by what actually moved, and floored at zero, so it reads as a
     * percentage of reality rather than of the forecast's own opinion.
     */
    const overall =
      scored && consumed > 0
        ? Math.max(0, 1 - Math.abs(matchedForecast - consumed) / consumed)
        : null

    return {
      forecast,
      consumed,
      measured: scored,
      unmatched: unmatched.size,
      overall,
      perComponent: scored ? accuracySum / scored : null,
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
        ? COLUMNS.filter(
            (c) => c.key !== 'Consumed_Qty' && c.key !== 'Accuracy' && c.key !== 'Live_Outbound_MTD'
          )
        : COLUMNS,
    [future]
  )

  /*
   * What the CSV holds.
   *
   * The table tells us the columns it is showing and the rows left after its
   * search box; the download is that, not the full set behind it. Someone who
   * ticks six columns out of twelve and downloads twelve has not exported the
   * view they built. Falls back to everything until the table has reported —
   * which is before the button can be clicked.
   */
  const [view, setView] = useState(null)

  const groups = useMemo(() => new Set(rows.map((r) => r['Recipe Group'])).size, [rows])

  const units = useMemo(() => [...new Set(rows.map((r) => r.BU).filter(Boolean))], [rows])

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  return (
    <>
      {/*
        * Said on the page rather than in a handover note, because this is the
        * page people order from and the gap is not visible in the figures.
        *
        * FM has no forecast model, so nothing here covers it — and it draws on
        * the same warehouse stock: 166 raw articles shared with these brands,
        * some of them almost entirely FM's (eggs read 26,172 here against
        * 497,672 actually issued). A quantity that is 5% of the truth looks
        * exactly like one that is right.
        */}
      <FmNotice detail />

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
          label="Outbound"
          accent="green"
          progress={summary.forecast ? Math.min(1, summary.consumed / summary.forecast) : 0}
          loading={busy}
          value={summary.measured ? fmtInt(summary.consumed) : '–'}
          foot={
            summary.measured
              ? `Left the warehouse, ${fmtInt(summary.measured)} components measured`
              : 'No transfers matched this view'
          }
        />
        <MetricCard
          label="Accuracy"
          accent={summary.overall === null ? 'slate' : summary.overall >= 0.9 ? 'green' : 'amber'}
          progress={summary.overall ?? 0}
          loading={busy}
          value={summary.overall === null ? '–' : fmtPct(summary.overall, 1)}
          foot={
            summary.overall === null
              ? 'Needs outbound to compare against'
              : `Totals compared · ${fmtPct(summary.perComponent, 0)} for the average component` +
                (summary.unmatched ? ` · ${fmtInt(summary.unmatched)} unmatched` : '')
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
              downloadCsv(
                'bbt-component-level.csv',
                view?.rows ?? priced,
                view?.columns ?? columns.map(({ key, label }) => ({ key, label }))
              )
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
            tableId="component-detail-v2"
            onColumnsChange={setHiddenCols}
            onViewChange={setView}
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
      <div className="unitrow" style={{ '--cards': busy ? 3 : Math.min(3, Math.max(1, facets.length)) }}>
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
          </>
        )}
      </div>
      {!busy && facets.length > 3 && (
        <p className="unitcol__more">
          {facets.length - 3} further unit{facets.length - 3 === 1 ? '' : 's'} (
          {facets.slice(3).map((f) => f.unit).join(', ')}) — in the table above.
        </p>
      )}
    </>
  )
}
