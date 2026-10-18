import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, fmtPct, fmtInt } from '../api.js'
import { fetchCached } from '../dataCache.js'
import { downloadXlsx, colName, S } from '../xlsx.js'
import { isFutureWindow } from '../window.js'
import { W } from '../columns.js'
import { averageScore, weightedScore } from '../scores.js'
import { mixAccuracy } from '../mixAccuracy.js'
import { monthsIn } from '../months.js'
import { exportFileName } from '../exportName.js'
import { whAccuracy, plainWhScore, stockRuleDecision } from '../whAccuracy.js'
import {
  Panel,
  ErrorBanner,
  Empty,
  ChartSkeleton,
  KpiCard,
  FmNotice,
  MetricCard,
} from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import {
  IconDownload,
  IconProduct,
  IconWarehouse,
  IconInsight,
} from '../components/Icons.jsx'
import {
  ORDERED_COLUMNS,
  WH_STOCK_COLUMNS,
  STORE_SOH_COLUMNS,
  STORE_SOH_ON,
} from './ComponentLevel.jsx'

/**
 * Stock Article, laid out for the people who place the orders.
 *
 * SAME DATA, SAME CALCULATIONS, DIFFERENT QUESTION
 *
 * Stock Article answers "what does this article look like" - one wide table,
 * thirty-nine columns, every measurement the app holds about a row. Procurement
 * asks something narrower and over a longer horizon: "across these months, what
 * do I need to buy". So the figures are the same figures and the layout is not:
 * three option cards choose a subject, and the months run across the table
 * instead of being collapsed into one window.
 *
 * Asked for on 8 Oct 2026.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No calculation of its own. Every column definition is imported from
 * `ComponentLevel.jsx` rather than declared again, the product-mix score comes
 * from `mixAccuracy.js` and the warehouse score from `whAccuracy.js` - the two
 * modules the detail page itself uses. A number on this page is the number on
 * that one, by construction rather than by agreement.
 *
 * The rows come from `/api/component-level`, unchanged, one request per month.
 * Per month rather than one request for the range because a month is the unit
 * on screen, and because in a PLANNED year each month carries its own seasonal
 * weight and its own mix factor - a single six-month call returns one blended
 * factor for the lot, which is not what any of the six months is worth. Asking
 * month by month is also what `/admin/sales-plan/*` already does.
 */

/**
 * The three subjects, in the order the cards appear.
 *
 * `accent` and `Icon` put them in the same visual language as the figure cards
 * on every other page - the card itself is `KpiCard`, so the typography, the
 * chip, the hover lift and the accent bar are the app's, not this page's.
 *
 * `calc` names the formulas behind each subject for the Calculations drawer,
 * exactly as the panels on Stock Article and Products do. The ids are those
 * pages' own, because these are those pages' figures.
 */
const MODES = [
  {
    key: 'mix',
    label: 'Product mix',
    blurb: 'What the recipes imply, against what was used',
    accent: 'blue',
    Icon: IconProduct,
    calc: 'card-product-mix,component-forecast',
  },
  {
    key: 'warehouse',
    label: 'Warehouse Forecast',
    blurb: 'The forecast, what shipped, and stock on hand',
    accent: 'green',
    Icon: IconWarehouse,
    calc: 'wh-forecast,supply',
  },
  {
    key: 'outbound',
    label: 'Outbound & Stock Details',
    blurb: 'What was issued, and what is left on the shelf',
    accent: 'amber',
    Icon: IconInsight,
    calc: 'wh-forecast,outbound,wh-acc',
  },
]

/** Add two figures without turning "no reading" into a zero. */
const add = (a, b) => {
  if (b === null || b === undefined) return a
  if (a === null || a === undefined) return Number(b)
  return Number(a) + Number(b)
}

/**
 * The ordinary warehouse score, before the stock rule.
 *
 *   1 - |forecast - outbound| / MAX(forecast, outbound)
 *
 * Symmetric and bounded, which is what makes it a different measure from the
 * product-mix score. Written here because every caller of `whAccuracy` supplies
 * its own - see that module's note on why `plain` is a parameter.
 */

/** One base column definition, by key, from the detail page's own catalogue. */
const BASE = new Map(ORDERED_COLUMNS.map((c) => [c.key, c]))

/*
 * The accuracy footers Stock Article weights by volume, and what it weights
 * them by.
 *
 * Taken from that page's own column definitions: WH ACC% and Actual ACC% are
 * `weightedScore(..., 'Consumed_Qty')` there, while the product-mix score is a
 * plain `averageScore`. A column not named here keeps the unweighted mean,
 * which is what all of them used to get.
 */
const WEIGHTED_TOTALS = new Map([
  ['WH_Accuracy', 'Consumed_Qty'],
  ['Actual_Accuracy', 'Consumed_Qty'],
])

/**
 * A month's copy of a base column.
 *
 * The renderers, widths, hints, formats and totals all come from the original,
 * so a month cell and the same figure on Stock Article are formatted by the
 * same function. Only the key and the group change - the key because every
 * month needs its own field on the row, the group because that is what draws
 * the month heading above it.
 */
function monthColumn(baseKey, month, { label = null } = {}) {
  const base = BASE.get(baseKey)
  if (!base) return null
  const key = `${month.key}__${baseKey}`
  return {
    ...base,
    key,
    label: label ?? base.label,
    group: month.key,
    /*
     * The accuracy columns score the average ARTICLE, which is a different
     * figure from comparing the column totals. Re-pointed at this month's own
     * field; the helper and the de-duplication are the detail page's.
     *
     * WHICH average, though, is the column's own business. Every one of these
     * footers used `averageScore` - an unweighted mean - and Stock Article
     * weights some of them by volume: its WH ACC% footer is
     * `weightedScore(list, 'WH_Accuracy', 'Consumed_Qty')`. So the footer here
     * read 77.2% under a card reading 89.0%, which are not two views of one
     * number, they are two different measurements of it. The unweighted mean
     * counts a packaging line that ships forty units as heavily as one that
     * ships six hundred thousand.
     *
     * The weight is this month's own outbound, so a month's footer is scored
     * on the month's volume rather than the whole range's.
     */
    ...(base.total && typeof base.total === 'function'
      ? {
          total: (list) => {
            const weightBy = WEIGHTED_TOTALS.get(baseKey)
            return weightBy
              ? (weightedScore(list, key, `${month.key}__${weightBy}`)?.value ?? null)
              : (averageScore(list, key)?.value ?? null)
          },
        }
      : {}),
  }
}

export function Procurement({
  filters,
  options,
  ready,
  refreshNonce,
  onLoaded,
  stockDetail,
}) {
  const [mode, setMode] = useState('mix')

  const months = useMemo(() => monthsIn(filters?.dateFrom, filters?.dateTo), [
    filters?.dateFrom,
    filters?.dateTo,
  ])

  /*
   * Which months have actually happened.
   *
   * Decided by `isFutureWindow` against the model's own calendar, not the
   * browser clock - the same function and the same boundary Stock Article uses,
   * so the two pages cannot disagree about where the measured data stops. A
   * month is "future" only when its FIRST day is past the last actual: the
   * month we are standing in is part measured and keeps its actual columns.
   */
  const dateRange = options?.dateRange
  const future = useMemo(
    () =>
      new Set(
        months.filter((mo) => isFutureWindow({ dateFrom: mo.from }, dateRange)).map((mo) => mo.key)
      ),
    [months, dateRange]
  )

  /*
   * Is every month on screen finished?
   *
   * The accuracy cards score a forecast against what actually happened, so they
   * only mean anything when the whole period has happened. A range reaching the
   * current month scores part of it against days that have not arrived, and a
   * range reaching beyond scores months with no actuals at all - which is how
   * the cards came to read 3.8% product mix and "0 scored" warehouse accuracy
   * over September to December. Those are not poor scores, they are a question
   * that cannot be answered, and a figure nobody can act on is worse on screen
   * than no figure.
   *
   * Tested on the MONTHS, not on the dates typed into the picker: this page
   * expands a selection to whole months, so picking 1-14 October fetches all of
   * October and scores the whole of it.
   *
   * A month counts as finished when its last day is behind both the model's
   * last actual and its today - the two can differ by a day either way, and a
   * month is only safe to score when it is past both.
   */
  const allPast = useMemo(() => {
    if (!months.length) return false
    const lastActual = dateRange?.lastActual ?? null
    const today = dateRange?.today ?? null
    if (!lastActual && !today) return false
    return months.every(
      (mo) => (!lastActual || mo.to <= lastActual) && (!today || mo.to < today)
    )
  }, [months, dateRange])

  /* ------------------------------------------------------------- the data -- */

  const stamp = useMemo(() => JSON.stringify(filters ?? {}), [filters])
  const monthKeys = useMemo(() => months.map((mo) => mo.key).join(','), [months])
  /*
   * Which months are in the future, as a dependency.
   *
   * The fetch below now asks for less on a future month, so "which ones are
   * future" is an input to the request and not only to the rendering. It is
   * derived from the months and the model's calendar, so it changes almost
   * never — but if the calendar moves under a mounted page and this were not a
   * dependency, the page would keep whatever it fetched under the old answer.
   */
  const futureKey = useMemo(() => [...future].sort().join(','), [future])

  const [parts, setParts] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!ready || !months.length) return undefined
    let alive = true

    /*
     * A month per request, through the shared cache.
     *
     * This page asks the same endpoint several times over — once per month in
     * the range — and it used to ask every time it was opened. Each of those
     * requests runs the full server pipeline, so a six-month range re-ran six
     * of them for figures the browser had a minute earlier.
     *
     * `fetchCached` answers from memory where it can and shares a request where
     * two callers want the same month. It sends the payload untouched, so the
     * question is the one this page has always asked. `release` on every handle
     * is what lets an abandoned request be cancelled — the handles, not an
     * AbortController here, now own that.
     */
    const payloadFor = (mo) => ({
      // The month replaces the range; every other filter is passed
      // through exactly as the page received it.
      ...filters,
      dateFrom: mo.from,
      dateTo: mo.to,
      grain: [],
      /*
       * What this page will not read, so the server does not build it.
       *
       * `site` is unconditional: there is no site column in any of the three
       * modes, and producing those two fields costs a Power BI query per brand.
       *
       * `openPo` only for a future month, because the fold below reads the
       * order book from the latest month that is NOT in the future, and skips
       * future ones outright - pending POs are the position now, so August's
       * outstanding orders say nothing about December. Only the future months,
       * deliberately: the rule the fold applies is "skip future", so omitting
       * exactly those cannot change which month it settles on, even when the
       * newest past month turns out to have no warehouse reading and it falls
       * back to an earlier one.
       */
      omit: future.has(mo.key) ? ['site', 'openPo'] : ['site'],
    })

    /*
     * TWO MONTHS IN FLIGHT AT A TIME, NOT ALL SIX.
     *
     * Each month is a full server pipeline that issues of the order of a dozen
     * Power BI queries, so six at once offered the capacity something like a
     * hundred queries in one burst. It refused a large share of them:
     * data/perf.log for 15 Oct 2026 records 314 throttles across 1,077
     * attempts - 29.2% - and Power BI answers each with Retry-After: 60. The
     * page then spent its time sleeping and re-asking rather than querying,
     * which is why 8,180 seconds were spent queued against 905 seconds
     * actually querying.
     *
     * Throttling is a VOLUME problem and the only honest fix is to ask for
     * less at once. This does not reduce the total work - every month is still
     * fetched, in full, with the same filters - it spreads it over the
     * capacity instead of stacking it. The later waves are also cheaper than
     * the first, because everything window-independent is cached by then.
     *
     * Deliberately NOT a bigger number. The gate in server/powerbi/client.js
     * halves on every throttle and needs twenty clean responses to widen by
     * one, so a burst that triggers throttling leaves every other page behind
     * a collapsed gate for a long time afterwards.
     */
    const MAX_PARALLEL_MONTHS = 2

    /*
     * Live handles, so an abandoned load really is cancelled.
     *
     * The requests start as a worker reaches them rather than all at once, so
     * there is no complete list to release up front - they are tracked as they
     * are created and released on unmount, wherever the queue had got to.
     */
    const live = new Set()
    const letGo = () => {
      for (const h of live) h.release()
      live.clear()
    }

    const got = new Array(months.length)
    let next = 0
    const worker = async () => {
      for (;;) {
        const i = next++
        if (i >= months.length || !alive) return
        const h = fetchCached(api.componentLevel, payloadFor(months[i]))
        live.add(h)
        try {
          const d = await h.promise
          got[i] = { month: months[i], rows: d?.rows ?? [] }
        } finally {
          live.delete(h)
          h.release()
        }
      }
    }

    /*
     * Only shows the spinner when there is actually something to wait for.
     *
     * Every month answered from cache resolves in a microtask, and flipping
     * `loading` on for that is a flash of skeleton over a table that is about
     * to render the same figures it already had.
     */
    let settled = false
    Promise.resolve().then(() => {
      if (alive && !settled) setLoading(true)
    })
    setError(null)

    Promise.all(
      Array.from({ length: Math.min(MAX_PARALLEL_MONTHS, months.length) }, worker)
    )
      .then(() => {
        settled = true
        if (!alive) return
        setParts(got)
        setLoading(false)
        onLoaded?.()
      })
      .catch((err) => {
        settled = true
        if (!alive || err?.name === 'AbortError') return
        setParts(null)
        setLoading(false)
        setError(err)
      })
      .finally(letGo)

    return () => {
      alive = false
      letGo()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stamp, monthKeys, futureKey, refreshNonce])

  /*
   * One row per article, with one set of fields per month.
   *
   * The endpoint answers one row per recipe line, so an article used by three
   * recipes arrives three times and its warehouse figures are stamped on one of
   * those rows. Both are folded here the way the detail page folds them: the
   * quantities are added, `add` keeps a missing reading missing, and the scores
   * are RE-DERIVED from the folded totals rather than carried from whichever
   * row happened to be first.
   */
  const rows = useMemo(() => {
    if (!parts) return []
    const out = new Map()

    for (const { month, rows: list } of parts) {
      for (const r of list) {
        const code = String(r['Item No.'] ?? '').trim()
        const name = String(r.Item ?? '').trim()
        const id = code || name
        if (!id) continue

        let held = out.get(id)
        if (!held) {
          held = {
            Item: name,
            'Item No.': code,
            'Node Type': r['Node Type'],
            Category: r.Category,
            BU: r.BU,
            __m: new Map(),
          }
          out.set(id, held)
        }
        // The identifying fields come from whichever row carries them, because
        // they describe the article rather than the line.
        held.Item = held.Item || name
        held['Node Type'] = held['Node Type'] ?? r['Node Type']
        held.Category = held.Category ?? r.Category

        let m = held.__m.get(month.key)
        if (!m) {
          m = {
            forecast: null,
            actual: null,
            outbound: null,
            whForecast: null,
            /*
             * The warehouse forecast BEFORE it was rounded up to a whole pack.
             *
             * Two figures, because they answer two questions. `whForecast` is
             * what somebody orders - lifted to a pack boundary, because that is
             * how the article is bought - and it is what the column shows.
             * `whForecastRaw` is what the engine actually predicted, and it is
             * what the accuracy is scored against.
             *
             * Scoring the rounded figure grades the packaging rather than the
             * forecast, and because rounding only ever lifts a number it drags
             * the score down in one direction: Procurement read 86.3% where
             * Stock Article read 88.1% on the same September data. Stock
             * Article has always scored the unrounded figure - its own column
             * tooltip says so - and this is Procurement catching up, not a new
             * rule.
             *
             * Falls back to the rounded value, which is what the server sends
             * when no rounding happened or when the account may not see pack
             * sizes at all. Identical to Stock Article's own fallback.
             */
            whForecastRaw: null,
            storeSoh: null,
            covered: undefined,
            whOpening: null,
            whClosing: null,
            openPo: null,
            storeDtl: null,
            asAt: null,
          }
          held.__m.set(month.key, m)
        }

        m.forecast = add(m.forecast, r.Component_Forecast_Qty)
        m.actual = add(m.actual, r.Component_Actual_Qty)
        m.outbound = add(m.outbound, r.Consumed_Qty)
        /*
         * How many recipe lines folded into this article, which decides which
         * of Stock Article's two stock-rule branches applies - see
         * `stockRuleDecision`. Counted per month, because the fold Stock
         * Article performs is within one window.
         */
        m.__n = (m.__n ?? 0) + 1
        m.whForecast = add(m.whForecast, r.WH_Constant_Forecast_Qty)
        m.whForecastRaw = add(m.whForecastRaw, r.WH_Forecast_Unrounded ?? r.WH_Constant_Forecast_Qty)
        m.whOpening = add(m.whOpening, r.WH_Opening_SOH)
        m.whClosing = add(m.whClosing, r.WH_Closing_SOH)
        m.openPo = add(m.openPo, r.Open_PO_Qty)
        m.storeSoh = add(m.storeSoh, r.Store_SOH)
        // Days, not units: adding the cover of two lines gives a number that
        // describes neither, so the article's own figure is carried.
        m.storeDtl = m.storeDtl ?? r.Store_DTL
        // The day the balances were actually read on - see `storeStock` on the
        // server. One date for the whole response, so first non-null is exact.
        m.asAt = m.asAt ?? r.Stock_As_At
        if (typeof r.Stock_Covered === 'boolean') {
          m.covered = m.covered === undefined ? r.Stock_Covered : m.covered && r.Stock_Covered
        }
      }
    }

    /*
     * Flattened onto the row, one field per month per measure.
     *
     * A future month contributes its forecast and nothing else - there is no
     * actual, no outbound and therefore no score, and the columns for those are
     * not drawn for that month at all.
     */
    return [...out.values()].map((held) => {
      const row = { ...held }
      delete row.__m

      for (const mo of months) {
        const m = held.__m.get(mo.key)
        const isFuture = future.has(mo.key)
        const p = `${mo.key}__`

        row[`${p}Component_Forecast_Qty`] = m?.forecast ?? null
        row[`${p}WH_Constant_Forecast_Qty`] = m?.whForecast ?? null

        if (isFuture) continue

        /*
         * The balances, per month - 15 Oct 2026.
         *
         * Each month is its own request, so the server has already read each
         * one on its own dates: opening on the day BEFORE the month, closing on
         * the month's last day. September's opening is therefore 31 August,
         * which is August's closing by construction - the same reading, asked
         * for twice - so the two months reconcile without anything being
         * stitched together here.
         *
         * Only for a month that has been measured. A future month has no
         * reading at all and gets no column, rather than a projected balance.
         */
        row[`${p}WH_Opening_SOH`] = m?.whOpening ?? null
        row[`${p}WH_Closing_SOH`] = m?.whClosing ?? null
        row[`${p}Store_SOH`] = m?.storeSoh ?? null
        row[`${p}Store_DTL`] = m?.storeDtl ?? null
        row[`${p}Component_Actual_Qty`] = m?.actual ?? null
        row[`${p}Sales_Accuracy`] = mixAccuracy(m?.forecast, m?.actual)
        row[`${p}Consumed_Qty`] = m?.outbound ?? null
        /*
         * Scored on the unrounded forecast; the column above still SHOWS the
         * rounded one, which is the quantity to order.
         */
        row[`${p}WH_Accuracy`] = whAccuracy(
          plainWhScore(m?.whForecastRaw, m?.outbound),
          m?.whForecastRaw,
          m?.storeSoh,
          stockRuleDecision(m?.__n ?? 0, m?.storeSoh, m?.covered)
        )
      }

      /*
       * Pending POs stay a single figure, and only that.
       *
       * The stock balances moved to their own month above. This one did not,
       * because it is not a monthly quantity: it is the order book as it stands
       * - what has been bought and has not yet arrived. August's outstanding
       * orders have since arrived or been cancelled, so repeating it per month
       * would print history that cannot be acted on beside balances that can.
       *
       * Taken from the latest month that has a reading, which is the position
       * now, and the heading says which month that is.
       */
      for (const mo of [...months].reverse()) {
        if (future.has(mo.key)) continue
        const m = held.__m.get(mo.key)
        if (!m) continue
        if (row.Open_PO_Qty === undefined && m.whClosing !== null) {
          row.Open_PO_Qty = m.openPo
          row.Stock_As_At = m.asAt
        }
        /*
         * The store balance for the WHOLE period, for the same reason and from
         * the same month.
         *
         * Without this the all-months row had no `Store_SOH` and no
         * `Stock_Covered` at all - the fold only ever wrote them per month -
         * so the stock rule could not fire on it. `whAccuracy` falls back to
         * working the rule out itself when it is told nothing, and with no SOH
         * to work from the answer is always "not covered".
         *
         * That is the bulk of why this page read 86.3% where Stock Article
         * read 88.1%: the rule that sets a covered article to 100% was never
         * applied here. It is not a different rule, it is the same rule with
         * nothing to apply it to.
         *
         * Taken from the latest measured month rather than summed, because
         * stock is a BALANCE - adding September's shelf to October's would
         * describe a warehouse that never existed. The same choice the Open PO
         * figure above makes, for the same reason.
         */
        if (row.Store_SOH === undefined && m.storeSoh !== null) {
          row.Store_SOH = m.storeSoh
          row.Stock_Covered = m.covered
          // From the same month as the balance, because it is that month's
          // fold the stock rule is being asked about.
          row.__n = m.__n
        }
      }

      /*
       * The same figures again, summed across every month on screen.
       *
       * The cards above the table score the WHOLE selected period, not one
       * month of it, so they need one set of totals per article - and the
       * scores have to be re-derived from those totals rather than averaged
       * across months, for the same reason the detail table re-derives them
       * when it folds rows: the average of two months' percentages is not the
       * percentage of their combined quantities.
       */
      let f = null
      let a = null
      let ob = null
      let whf = null
      // The unrounded total, carried alongside for the same reason it is
      // carried per month: the score is judged on what was predicted, the
      // column on what has to be ordered.
      let whfRaw = null
      for (const mo of months) {
        const m = held.__m.get(mo.key)
        if (!m) continue
        f = add(f, m.forecast)
        if (!future.has(mo.key)) {
          a = add(a, m.actual)
          ob = add(ob, m.outbound)
        }
        whf = add(whf, m.whForecast)
        whfRaw = add(whfRaw, m.whForecastRaw)
      }
      row.Component_Forecast_Qty = f
      row.Component_Actual_Qty = a
      row.Consumed_Qty = ob
      row.WH_Constant_Forecast_Qty = whf
      row.Sales_Accuracy = mixAccuracy(f, a)
      row.WH_Accuracy = whAccuracy(
        plainWhScore(whfRaw, ob),
        whfRaw,
        row.Store_SOH,
        stockRuleDecision(row.__n ?? 0, row.Store_SOH, row.Stock_Covered)
      )

      return row
    })
  }, [parts, months, future])

  /* ------------------------------------------------------------- the cards -- */

  /*
   * The same cards Stock Article carries, over the whole selected period.
   *
   * `averageScore` and `weightedScore` are that page's own helpers, so "average
   * article" and "volume weighted" mean exactly what they mean there - including
   * the de-duplication by article number and the floor at zero.
   */
  const cards = useMemo(() => {
    const scored = rows.filter((r) => r.Sales_Accuracy !== null && r.Sales_Accuracy !== undefined)
    const mix = averageScore(scored, 'Sales_Accuracy')
    const mixVol = weightedScore(scored, 'Sales_Accuracy', 'Component_Actual_Qty')

    const whRows = rows.filter((r) => r.WH_Accuracy !== null && r.WH_Accuracy !== undefined)
    const whVol = weightedScore(whRows, 'WH_Accuracy', 'Consumed_Qty')

    return {
      mix: mix?.value ?? null,
      mixCount: mix?.count ?? 0,
      mixVolume: mixVol?.value ?? null,
      wh: whVol?.value ?? null,
      /*
       * How many articles are behind that percentage.
       *
       * This read `whVol?.count`, and `weightedScore` has never returned a
       * `count` - it returns `{ value, weight }`. So the caption said "0
       * scored" under a perfectly real figure, every time. It now comes from
       * the same helper, which counts the articles it actually scored.
       */
      whCount: whVol?.count ?? 0,
    }
  }, [rows])

  /* ---------------------------------------------------------- the columns -- */

  /**
   * What the row is, pinned on the left of every card.
   *
   * MEASURED, not flexible. On Stock Article the article name is the column
   * that absorbs whatever width is left over, which keeps a table of fifteen
   * columns flush with its panel. This page shows three or four, so the same
   * setting handed the name well over a thousand pixels and most of it was
   * white. Here it is sized to the names actually in the table and capped, and
   * the leftover width is left at the right of the table where it reads as
   * space rather than as an empty column.
   */
  const identity = useMemo(
    () =>
      [
        {
          ...BASE.get('Item'),
          flex: false,
          autoWidth: { min: 200, max: 420, percentile: 0.95 },
        },
        { ...BASE.get('Item No.'), width: W.article },
      ].filter((c) => c.key),
    []
  )

  /**
   * The stock block, as at the latest measured month.
   *
   * Balances rather than monthly flows, so they appear once. Which columns a
   * reader may see is the server's answer, carried in `stockDetail` - the
   * figures are withheld from the response itself for anyone else, so this only
   * decides whether to draw what has already arrived.
   *
   * Required Qty is deliberately absent: it is computed by the server and shown
   * on no page, on request.
   */
  /*
   * The "on order" heading, worked out once.
   *
   * Both the column and the heading need it: the heading to print, and the
   * column to be wide enough to hold it. A group heading is centred over its
   * run, and `autoWidth` measures only a column's OWN label and values - it
   * knows nothing about the heading above - so a one-column group whose heading
   * is longer than its label overflows. That is what pushed "ON ORDER · OCT"
   * past the Pending PO column.
   */
  const stockMonth = useMemo(
    () => [...months].reverse().find((mo) => !future.has(mo.key)) ?? null,
    [months, future]
  )
  const stockLabel = stockMonth
    ? `On order · ${stockMonth.short.split(' ')[0]}`
    : 'On order'

  /*
   * Roughly how wide that heading renders.
   *
   * The header row is uppercase at 10.5px with letter-spacing, so about 7.6px a
   * character, plus the cell's own padding. Approximate on purpose: being a few
   * pixels generous costs nothing, where being short clips the heading.
   */
  const headingWidth = Math.ceil(stockLabel.length * 7.6) + 28

  /** May this account see this stock column at all? The server decides. */
  const permitted = useCallback(
    (k) => {
      if (!stockDetail) return false
      if (WH_STOCK_COLUMNS.has(k)) return true
      return STORE_SOH_ON && STORE_SOH_COLUMNS.has(k)
    },
    [stockDetail]
  )

  const stockColumns = useCallback(
    (keys) =>
      keys
        .filter(permitted)
        .map((k) => {
          const base = BASE.get(k)
          const opts = base?.autoWidth === true ? {} : base?.autoWidth ?? {}
          return {
            ...base,
            group: 'stock',
            // Wide enough for the heading above it, never narrower than the
            // column would have chosen for itself.
            autoWidth: { ...opts, min: Math.max(opts.min ?? 0, headingWidth) },
          }
        })
        .filter((c) => c.key),
    [permitted, headingWidth]
  )

  const columns = useMemo(() => {
    if (mode === 'warehouse') {
      /*
       * Forecast, what shipped, the score between them - and Store SOH.
       *
       * Narrowed on 15 Oct 2026: this view is about how the forecast performed,
       * so the full stock position moved to Outbound & Stock Details and only
       * Store SOH stayed. It is here because the stock rule that can lift the
       * score reads it, so the figure behind that belongs beside the score.
       *
       * A future month keeps the forecast alone: nothing shipped in a month
       * that has not happened, so there is no outbound and no score.
       */
      return [
        ...identity,
        ...months.flatMap((mo) =>
          ['WH_Constant_Forecast_Qty', 'Consumed_Qty', 'WH_Accuracy', 'Store_SOH']
            // A month that has not happened has no outbound, no score and no
            // stock reading - only the forecast.
            .filter((k) => !future.has(mo.key) || k === 'WH_Constant_Forecast_Qty')
            .filter((k) => k !== 'Store_SOH' || permitted('Store_SOH'))
            .map((k) => monthColumn(k, mo, k === 'WH_Constant_Forecast_Qty' ? { label: 'WH forecast' } : {}))
            .filter(Boolean)
        ),
      ]
    }

    if (mode === 'outbound') {
      /*
       * What left the warehouse, and everything held against it.
       *
       * The stock position moved here on 15 Oct 2026: what was issued and what
       * remains are the same question asked twice, and reading them together is
       * what the detail is for.
       *
       * Outbound is a MEASUREMENT, so a future month contributes no column at
       * all and its heading is dropped with it.
       */
      /*
       * Opening, what went out, closing - in that order, per month.
       *
       * Read left to right the three tell one story: this is what the month
       * started with, this is what left, this is what it ended with. Store SOH
       * and Store DTL follow, on the same date as that month's closing.
       */
      return [
        ...identity,
        ...months
          .filter((mo) => !future.has(mo.key))
          .flatMap((mo) =>
            ['WH_Opening_SOH', 'Consumed_Qty', 'WH_Closing_SOH', 'Store_SOH', 'Store_DTL']
              .filter((k) => k === 'Consumed_Qty' || permitted(k))
              .map((k) => monthColumn(k, mo))
              .filter(Boolean)
          ),
        ...stockColumns(['Open_PO_Qty']),
      ]
    }

    // Product mix: what the recipes implied, what was used, and the score.
    return [
      ...identity,
      ...months.flatMap((mo) =>
        ['Component_Forecast_Qty', 'Component_Actual_Qty', 'Sales_Accuracy']
          /*
           * A month that has not happened shows its forecast alone. Nothing
           * measured it, so there is no actual and no score to show, and an
           * empty column under a month heading invites the question twice.
           */
          .filter((k) => !future.has(mo.key) || k.endsWith('Forecast_Qty'))
          .map((k) => monthColumn(k, mo))
          .filter(Boolean)
      ),
    ]
  }, [mode, months, future, identity, stockColumns, permitted])

  /** The month headings above the shaded runs, plus the stock one. */
  const groups = useMemo(() => {
    const out = {}
    /*
     * How many columns each month heading actually spans.
     *
     * A heading is centred over its own run, so the run has to be wide enough
     * to hold it. On Outbound a month spans ONE numeric column and
     * "September 2026" is wider than the number under it, so the heading ran
     * past the column and out of the table. One column gets the short form -
     * "SEP 2026" - which fits; two or three keep the full month name.
     */
    const span = new Map()
    for (const c of columns) {
      if (c.group) span.set(c.group, (span.get(c.group) ?? 0) + 1)
    }
    for (const mo of months) {
      // A month whose columns were all dropped gets no heading either.
      if (!span.has(mo.key)) continue
      out[mo.key] = {
        label: span.get(mo.key) === 1 ? mo.short : mo.label,
        help: future.has(mo.key)
          ? `${mo.label} has not happened yet, so only the forecast is shown. There is nothing measured to compare it against.`
          : undefined,
      }
    }
    /*
     * Pending POs are the only figure left outside a month.
     *
     * The balances moved into their own month groups on 15 Oct 2026, so each
     * month's opening, outbound and closing sit together under its heading.
     * What stays here is the order book as it stands, and the heading names the
     * month it was read in so nobody reads it as belonging to the whole range.
     */
    if (span.has('stock')) {
      out.stock = {
        label: stockLabel,
        help:
          'Units bought and not yet arrived, as the order book stood on the last day the inventory feed had ' +
          'reported in ' +
          (stockMonth ? stockMonth.label : 'the selected period') +
          '. It is the position now rather than a monthly quantity, so it is shown once: for an earlier ' +
          'month, the outstanding orders have since arrived or been cancelled.',
      }
    }
    return out
  }, [months, future, mode, columns, stockLabel, stockMonth])

  /* --------------------------------------------------------------- render -- */

  const busy = loading || !ready
  const monthSpan = months.length
    ? `${months[0].label}${months.length > 1 ? ` – ${months[months.length - 1].label}` : ''}`
    : null

  /*
   * The workbook, with the month as a header spanning its own columns.
   *
   * A CSV cannot merge a cell, so every column had to repeat its month -
   * "September 2026 - Store SOH" beside "September 2026 - Store DTL" - which is
   * the same month written out five times a row. An xlsx carries the two-row
   * header the page shows: the month once, centred over its columns, and the
   * figure names underneath.
   *
   * The styles are the ones the workbook already defines, so a percentage
   * arrives as a percentage and a quantity carries thousands separators rather
   * than landing as text Excel has to be told how to read.
   */
  const styleFor = (c) => {
    if (c.key.endsWith('Accuracy') || c.key.endsWith('Sales_Accuracy')) return S.PCT
    if (c.key.endsWith('Store_DTL')) return S.RATE
    return c.num ? S.QTY : S.PLAIN
  }

  const download = () => {
    // Columns of the same group sit together, so a run is a month.
    const runs = []
    columns.forEach((c, i) => {
      const last = runs[runs.length - 1]
      if (last && c.group && last.group === c.group) last.end = i
      else runs.push({ group: c.group ?? null, start: i, end: i })
    })

    const head = columns.map(() => null)
    const merges = []
    for (const run of runs) {
      if (!run.group) continue
      const label = groups[run.group]?.label
      if (!label) continue
      head[run.start] = { v: label, s: S.SPAN }
      if (run.end > run.start) {
        merges.push(`${colName(run.start + 1)}1:${colName(run.end + 1)}1`)
      }
    }

    const sheet = {
      name: 'Article Detail',
      rows: [
        head,
        columns.map((c) => ({ v: c.label, s: S.HEAD })),
        ...rows.map((r) =>
          columns.map((c) => {
            const v = r[c.key]
            if (v === null || v === undefined || v === '') return null
            const n = Number(v)
            return Number.isFinite(n) && c.num
              ? { v: n, s: styleFor(c) }
              : { v: String(v), s: S.PLAIN }
          })
        ),
      ],
      // Both header rows stay in view while the articles scroll.
      freeze: 2,
      merges,
      widths: columns.map((c) => (c.num ? 16 : Math.min(42, Math.max(14, (c.label?.length ?? 10) + 6)))),
    }

    downloadXlsx(
      exportFileName(MODES.find((m) => m.key === mode)?.label ?? 'Procurement', {
        dateFrom: filters?.dateFrom,
        dateTo: filters?.dateTo,
        ext: 'xlsx',
      }),
      [sheet]
    )
  }

  const current = MODES.find((m) => m.key === mode) ?? MODES[0]

  return (
    <>
      {/*
        * The same standing notice every other data page opens with, so a page
        * that shows FM rows says what they are here too.
        */}
      <FmNotice />

      {/*
        * The three cards, which are the page's one control.
        *
        * Each is a `KpiCard` inside a bare button, rather than markup of its
        * own: the chip, the uppercase label, the figure type and the accent bar
        * are then literally the cards on Products and Stock Article, and a
        * change to those lands here without anybody remembering to make it.
        * The button carries the behaviour and nothing visual.
        *
        * `aria-pressed` rather than a tab role - there is one panel below and
        * it is not a tabpanel, so a toggle is what these actually are. It is
        * also what says "selected" to a screen reader, since the card carries
        * no label text of its own; the sighted signals are the accent bar, the
        * border and the ground, so none of them is colour alone either.
        */}
      {/*
        * The figures first, the controls under them.
        *
        * The cards sit in one fixed row at the top, as they do on Stock
        * Article, and the three buttons run in a single line directly beneath.
        * Reading order follows: here is how the selection scored, and here is
        * what you can select.
        */}
      {allPast && mode !== 'outbound' && (
        <div className="kpis proc__metrics">
          {mode === 'mix' ? (
            <MetricCard
              label="Product mix accuracy"
              calc="card-product-mix,component-forecast,outbound"
              hint="How close the recipe side was, averaged across articles: 1 − |Forecast − Actual| ÷ the larger of the two."
              accent={cards.mix === null ? 'slate' : cards.mix >= 0.9 ? 'green' : 'amber'}
              progress={cards.mix ?? 0}
              loading={busy}
              value={cards.mix === null ? '–' : fmtPct(cards.mix, 1)}
              foot={
                cards.mix === null ? (
                  'Nothing has sold in this period yet'
                ) : (
                  <>
                    Average article · {fmtInt(cards.mixCount)} scored
                    <br />
                    {cards.mixVolume === null
                      ? 'No volume to weight by'
                      : `Volume accuracy · ${fmtPct(cards.mixVolume, 1)}`}
                  </>
                )
              }
            />
          ) : (
            /*
             * The warehouse score, on its own.
             *
             * "Outbound vs forecast" sat beside this and was removed on 15 Oct
             * 2026. It asked a different question - outbound DIVIDED BY
             * forecast, directional and unbounded, where this one is symmetric
             * and bounded - and two percentages side by side that cannot be
             * compared is a card that mostly generates questions. Stock Article
             * still carries it; this page does not need it.
             */
            <MetricCard
              label="Warehouse accuracy"
              calc="card-warehouse,wh-forecast,outbound"
              hint="How close the WH forecast was to what shipped, weighted by volume: 1 − |Forecast − Outbound| ÷ the larger of the two."
              accent={cards.wh === null ? 'slate' : cards.wh >= 0.9 ? 'green' : 'amber'}
              progress={cards.wh ?? 0}
              loading={busy}
              value={cards.wh === null ? '–' : fmtPct(cards.wh, 1)}
              foot={
                cards.wh === null
                  ? 'Needs a forecast and an outbound figure on the same article'
                  : `Volume weighted · ${fmtInt(cards.whCount)} scored`
              }
            />
          )}
        </div>
      )}

      <div className="kpis proc__cards" role="group" aria-label="What to show">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            aria-pressed={mode === m.key}
            className={`proc__card${mode === m.key ? ' proc__card--on' : ''}`}
            onClick={() => setMode(m.key)}
          >
            <KpiCard
              value={m.label}
              textValue
              foot={m.blurb}
              accent={m.accent}
              icon={<m.Icon size={13} />}
              progress={mode === m.key ? 1 : 0}
            />
          </button>
        ))}
    </div>

      <Panel
        title="Article Detail"
        calc={current.calc}
        sub={
          monthSpan
            ? `${current.label} · ${monthSpan} · one row per article`
            : 'Choose a date range to plan for'
        }
        count={rows.length || undefined}
        busy={busy}
        tools={
          rows.length ? (
            <button type="button" className="btn" onClick={download}>
              <IconDownload size={12} />
              Excel
            </button>
          ) : null
        }
      >
        {busy && !rows.length ? (
          <ChartSkeleton height={320} />
        ) : !months.length ? (
          <Empty title="Choose a date range">
            Pick the months you are planning for and the three views fill with them.
          </Empty>
        ) : !rows.length ? (
          <Empty title="No articles for these filters" />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            groups={groups}
            totals
            // The article and its code stay put while the months scroll under
            // the headings - a twelve-month range is wider than any screen.
            freeze={2}
            maxHeight={620}
            initialSort={{
              key: months.length ? `${months[0].key}__${mode === 'mix' ? 'Component_Forecast_Qty' : 'WH_Constant_Forecast_Qty'}` : 'Item',
              dir: 'desc',
            }}
            searchPlaceholder="Search article…"
            tableId={`procurement-${mode}-v1`}
          />
        )}
      </Panel>
    </>
  )
}

export default Procurement
