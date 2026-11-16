import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useChartTheme } from './useChartTheme.js'
import { compactInt, fmtQty, fmtSignedPct } from '../../api.js'
import { monthLabel } from '../../consumptionWindow.js'
/*
 * The arithmetic lives in its own module so it can be tested - `node --test`
 * cannot import JSX. Re-exported here so every caller keeps one import.
 */
export {
  topVarianceArticles,
  monthlyVariance,
  monthlyVarianceByArticle,
  engineVarianceByArticle,
  engineMonthlyTotals,
  mcMonthlyTotals,
  completeMonths,
  persistentVarianceArticles,
} from './varianceFolds.js'

/*
 * The visuals on the Consumption page. Asked for on 9 Nov 2026.
 *
 * COLOUR, AND WHY IT IS THESE TWO
 *
 * A variance has a DIRECTION, so the colour job here is diverging, not
 * categorical: two poles and a neutral middle. The app already has that pair -
 * `.pos` is `--amber` and `.neg` is `--blue` (theme.css) - and the table's own
 * variance figures are already drawn with it. Reusing it means amber means
 * "used more than the recipe says" everywhere on the page, in the table and in
 * the charts, rather than one thing in each.
 *
 * Checked rather than assumed: the pair separates by dE 30.3 under protanopia
 * and 24.1 under tritanopia, well clear of the 8 floor, and 32.6 for normal
 * vision. Contrast against the light surface is below 3:1, which obliges
 * visible labels - every bar carries its figure, and the table sits directly
 * below with the same numbers.
 *
 * ONE ARTICLE AT A TIME, NOT SIX AT ONCE
 *
 * Six articles on one pair of axes would need six distinguishable hues and the
 * theme defines two. Small multiples were tried on 9 Nov 2026 and removed the
 * same day on request - a 190px drawing is too small to read, which was the
 * complaint about the sparkline column before it. So the per-article trend is
 * ONE article, full width, chosen from the list beside it: one series, one
 * hue, no legend, and the room to carry its own figures.
 */

const axisTickOf = (colors) => ({
  fill: colors.muted,
  fontSize: 10,
  fontFamily: 'Inter, sans-serif',
})

const truncate = (v, n) => (String(v).length > n ? `${String(v).slice(0, n - 1)}…` : String(v))

const shortMonth = (iso) => monthLabel(iso).replace(/ \d{4}$/, '').slice(0, 3)

/** A variance, signed, as the table writes it. */
const signed = (v) => `${Number(v) > 0 ? '+' : ''}${fmtQty(v)}`


function BarTip({ active, payload, colors }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  const over = row.variance > 0
  return (
    <div className="tt">
      <div className="tt__title">{row.name}</div>
      <div className="tt__row">
        <span className="legend__swatch" style={{ background: colors.neutral }} />
        <span className="tt__name">Oracle theoretical</span>
        <span className="tt__val">{fmtQty(row.theoretical)}</span>
      </div>
      <div className="tt__row">
        <span className="legend__swatch" style={{ background: colors.plain }} />
        <span className="tt__name">Consumption</span>
        <span className="tt__val">{fmtQty(row.consumption)}</span>
      </div>
      <div className="tt__delta">
        <span className="tt__name">{over ? 'Used more than the recipe' : 'Used less than the recipe'}</span>
        <span className="tt__val">
          {signed(row.variance)}
          {row.pct === null ? '' : ` · ${fmtSignedPct(row.pct, 1)}`}
        </span>
      </div>
    </div>
  )
}

/** The figure at the end of each bar, on the side the bar points. */
function BarValue({ x, y, width, height, value, colors }) {
  if (!Number.isFinite(Number(value))) return null
  const n = Number(value)
  const w = Number(width) || 0
  // A negative bar is drawn to the left of zero, so its label goes further left
  // again; Recharts still reports a positive width.
  const atEnd = n >= 0 ? Number(x) + w + 6 : Number(x) - 6
  return (
    <text
      x={atEnd}
      y={Number(y) + Number(height) / 2 + 3}
      textAnchor={n >= 0 ? 'start' : 'end'}
      fill={colors.plain}
      fontSize={10}
      fontFamily="Inter, sans-serif"
    >
      {signed(n)}
    </text>
  )
}

/**
 * Top articles by variance, as diverging bars either side of zero.
 *
 * Bars rather than a table because the question is "how much bigger is the
 * first than the fifth", which is a length comparison; the figures are written
 * on the bars so nothing depends on reading colour or estimating length.
 */
export function TopVarianceChart({ data, height = 360, onPick }) {
  const colors = useChartTheme()
  const axisTick = axisTickOf(colors)
  if (!data?.length) return null

  const values = data.map((d) => d.variance)
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  // Room at both ends for the labels that sit past the bar.
  const padding = Math.max(Math.abs(lo), Math.abs(hi)) * 0.18 || 1

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 56, bottom: 0, left: 0 }}
        barCategoryGap="22%"
      >
        <CartesianGrid stroke={colors.grid} vertical horizontal={false} syncWithTicks />
        <XAxis
          type="number"
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          domain={[lo - padding, hi + padding]}
          tickFormatter={compactInt}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={168}
          interval={0}
          tickFormatter={(v) => truncate(v, 24)}
        />
        <Tooltip content={<BarTip colors={colors} />} cursor={{ fill: colors.grid, fillOpacity: 0.7 }} />
        {/* Zero is the reference the whole chart is read against. */}
        <ReferenceLine x={0} stroke={colors.line} />
        <Bar
          dataKey="variance"
          radius={[0, 2, 2, 0]}
          maxBarSize={13}
          onClick={onPick}
          cursor={onPick ? 'pointer' : undefined}
          isAnimationActive
          animationDuration={650}
          animationEasing="ease-out"
        >
          {data.map((row) => (
            <Cell key={row.article} fill={row.variance > 0 ? colors.amber : colors.blue} />
          ))}
          {/*
            * LabelList with `content`, as CategoryBarChart does it. The `label`
            * prop would also take a function, but this is the pattern already
            * proven in this codebase and it keeps the label a child of the bar
            * it belongs to.
            */}
          <LabelList dataKey="variance" position="right" offset={6} content={(props) => <BarValue {...props} colors={colors} />} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function TrendTip({ active, payload, label, colors }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <div className="tt">
      <div className="tt__title">{monthLabel(label)}</div>
      <div className="tt__row">
        <span
          className="legend__rule"
          style={{ color: row.variance > 0 ? colors.amber : colors.blue }}
        />
        <span className="tt__name">Variance</span>
        <span className="tt__val">{signed(row.variance)}</span>
      </div>
      <div className="tt__row">
        <span className="legend__swatch" style={{ background: 'transparent' }} />
        <span className="tt__name">{row.articles} articles</span>
      </div>
    </div>
  )
}

/**
 * The selection's total variance over every month Oracle holds.
 *
 * ONE series, so there is no legend - the panel title names it. The zero rule is
 * the thing being read against: above it the outlets used more than the recipe
 * explains, below it less.
 */
export function VarianceTrendChart({ data, height = 300 }) {
  const colors = useChartTheme()
  const axisTick = axisTickOf(colors)
  if (!data?.length) return null

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={colors.grid} vertical={false} syncWithTicks />
        <XAxis
          dataKey="month"
          tickFormatter={shortMonth}
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          dy={6}
          interval={0}
        />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={compactInt}
        />
        <Tooltip content={<TrendTip colors={colors} />} cursor={{ stroke: colors.line, strokeWidth: 1 }} />
        <ReferenceLine y={0} stroke={colors.line} />
        <Line
          type="monotone"
          dataKey="variance"
          stroke={colors.amber}
          strokeWidth={2}
          dot={{ r: 2.5, strokeWidth: 0, fill: colors.amber }}
          activeDot={{ r: 4, strokeWidth: 2, stroke: colors.surface }}
          isAnimationActive
          animationDuration={700}
          animationEasing="ease-out"
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

/*
 * THE PERIOD OVERVIEW - 9 Nov 2026, on request.
 *
 * "Show the variance trends of these articles in the last 6 months, so I can
 * get the articles that have high variance during this period, instead of just
 * considering October."
 *
 * WHY A MATRIX AND NOT LINES
 *
 * The question is comparative across BOTH axes at once: which articles, and in
 * which months. Lines answer it for about four articles and then collapse - a
 * dozen series needs a dozen distinguishable hues and this theme defines two,
 * which is exactly what made the small multiples unreadable earlier today. A
 * matrix puts one article per row and one month per column, so persistence
 * reads as a solid row of colour and a single bad month reads as a single cell.
 *
 * WHY COLOUR IS THE SHARE, NOT THE QUANTITY
 *
 * These articles differ by three orders of magnitude. Scaled on quantity, the
 * top row would be saturated and everything below it blank - which is the
 * complaint about ranking by October, restated as colour. The share of Oracle's
 * own theoretical is comparable between a napkin and a beef portion, so that is
 * what the colour carries; the quantity is on the row, in figures, where a
 * number belongs.
 *
 * Articles with no theoretical at all are left out rather than coloured: a
 * share of nothing cannot go on a scale of shares, and they are a different
 * finding - no recipe exists.
 *
 * COLOUR JOB: diverging. Two poles and a neutral middle, the app's own
 * `.pos`/`.neg` pair - amber used more than the recipe explains, blue used
 * less - so a colour means the same thing here, in the table, and in the
 * detail chart below. The band edges are the ones the reader already has in
 * the figures: 1%, 10%, 25%, 100%.
 */
const BANDS = [0.01, 0.1, 0.25, 1]

/** 0 for agreement, then 1..4 outward. */
const bandOf = (pct) => {
  const a = Math.abs(Number(pct) || 0)
  if (a <= BANDS[0]) return 0
  if (a <= BANDS[1]) return 1
  if (a <= BANDS[2]) return 2
  if (a <= BANDS[3]) return 3
  return 4
}

/* How much of the pole colour each band carries. Mixed with the surface rather
 * than set as a fixed hex, so one definition serves both themes: the ramp is
 * always light-to-saturated against whatever the page is sitting on. */
const WEIGHT = [0, 26, 48, 70, 92]

const cellFill = (pct) => {
  const band = bandOf(pct)
  if (band === 0) return 'var(--grid)'
  const pole = Number(pct) > 0 ? 'var(--amber)' : 'var(--blue)'
  return `color-mix(in oklab, ${pole} ${WEIGHT[band]}%, var(--surface))`
}

const BAND_LABEL = ['within 1%', '1–10%', '10–25%', '25–100%', 'over 100%']

/** The scale, spelled out - identity never rests on colour alone. */
function HeatLegend() {
  const step = (pct, key) => (
    <span key={key} className="legend__item" style={{ gap: 4 }}>
      <span
        className="legend__swatch"
        style={{ background: cellFill(pct), borderRadius: 2, width: 14, height: 14 }}
      />
      <span>{BAND_LABEL[bandOf(pct)]}</span>
    </span>
  )
  return (
    <div className="legend" style={{ flexWrap: 'wrap', rowGap: 6 }}>
      <span className="muted" style={{ fontSize: 11 }}>Used less</span>
      {[-2, -0.5, -0.2, -0.05].map((p, i) => step(p, `n${i}`))}
      {step(0, 'zero')}
      {[0.05, 0.2, 0.5, 2].map((p, i) => step(p, `p${i}`))}
      <span className="muted" style={{ fontSize: 11 }}>Used more</span>
    </div>
  )
}

/**
 * Articles down, months across, the variance as colour.
 *
 * Plain CSS grid rather than SVG: there is no scale to place marks on - a cell
 * is a cell - and a grid cannot produce the overlapping labels or clipped
 * geometry that hand-written SVG coordinates can. It also wraps and scrolls on
 * a narrow screen for free.
 *
 * Each cell carries its own figures in `title`, and clicking a row opens that
 * article in the detail chart below, so no reading of the colour is ever
 * required to get an exact number.
 */
export function VarianceHeatmap({ data, months, onPick }) {
  if (!data?.length || !months?.length) return null

  /*
   * The track list is inline because it depends on how many months there are,
   * and `display` travels with it deliberately.
   *
   * Without the grid these rows collapse to run-together inline text and the
   * cells - spans with a height - vanish, because an inline box ignores height.
   * That is a mess rather than a degradation, and it happened once already on
   * 9 Nov 2026 when a stylesheet edit had not reached the browser. The layout a
   * row cannot be read without therefore does not depend on the stylesheet
   * arriving; theme.css keeps the colours, spacing and states.
   */
  const cols = `minmax(150px, 1fr) repeat(${months.length}, minmax(44px, 56px)) 104px 64px`
  const grid = { display: 'grid', gridTemplateColumns: cols }

  const head = (
    <div className="heat__row heat__row--head" style={grid}>
      <span className="heat__name">Article</span>
      {months.map((m) => (
        <span key={m} className="heat__head">{shortMonth(m)}</span>
      ))}
      <span className="heat__head">6 months</span>
      <span className="heat__head">Months high</span>
    </div>
  )

  return (
    <div style={{ display: 'grid', gap: 'var(--s4)' }}>
      <HeatLegend />
      <div className="heat__scroll">
        <div className="heat">
          {head}
          {data.map((d) => {
            const byMonth = new Map(d.trend.map((p) => [p.month, p]))
            return (
              <div
                key={d.key}
                className="heat__row"
                style={grid}
                role="button"
                tabIndex={0}
                onClick={() => onPick?.(d)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onPick?.(d)
                  }
                }}
                title={`${d.name}${d.brand ? ` · ${d.brand}` : ''} — click for the menu items that use it`}
              >
                <span className="heat__name" title={`${d.article} · ${d.name}`}>
                  {d.brand ? <span className="heat__brand">{d.brand}</span> : null}
                  {d.name}
                </span>

                {months.map((m) => {
                  const p = byMonth.get(m)
                  if (!p) {
                    return (
                      <span
                        key={m}
                        className="heat__cell heat__cell--none"
                        title={`${monthLabel(m)} — no row for this article, which is not the same as agreeing`}
                      />
                    )
                  }
                  return (
                    <span
                      key={m}
                      className="heat__cell"
                      style={{ background: cellFill(p.pct) }}
                      title={
                        `${monthLabel(m)} — ${signed(p.variance)}` +
                        (p.pct === null || p.pct === undefined
                          ? ' (no theoretical)'
                          : ` · ${fmtSignedPct(p.pct, 1)} of Oracle’s theoretical`)
                      }
                    />
                  )
                })}

                {/* The quantity as a figure, because the colour is the share. */}
                <span className={`heat__num ${d.variance > 0 ? 'pos' : d.variance < 0 ? 'neg' : ''}`}>
                  {signed(d.variance)}
                </span>
                <span className="heat__num muted">
                  {d.monthsHigh} of {d.monthsSeen}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ArticleTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  const over = row.variance > 0
  return (
    <div className="tt">
      <div className="tt__title">{monthLabel(label)}</div>
      <div className="tt__delta" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
        <span className="tt__name">{over ? 'Used more than the recipe' : 'Used less than the recipe'}</span>
        <span className="tt__val">
          {signed(row.variance)}
          {row.pct === null || row.pct === undefined ? '' : ` · ${fmtSignedPct(row.pct, 1)}`}
        </span>
      </div>
    </div>
  )
}

/**
 * ONE article's variance, month by month, at full width.
 *
 * Replaces the small multiples that were here for part of 9 Nov 2026. Six
 * articles at 190px each answered direction and nothing else - the same
 * complaint as the sparkline column before them - so this shows one article
 * with the room to carry its own figures, and the list beside it chooses which.
 *
 * Columns rather than a line: six months is six readings, not a continuous
 * quantity, and a column has a length to compare where a line segment has only
 * a slope. Each is coloured by its own sign, so a month that crossed over is
 * visible as a change of colour rather than only as a crossing of the rule.
 */
export function ArticleVarianceTrend({ points, height = 300 }) {
  const colors = useChartTheme()
  const axisTick = axisTickOf(colors)
  if (!points?.length) return null

  const values = points.map((p) => Number(p.variance) || 0)
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const padding = Math.max(Math.abs(lo), Math.abs(hi)) * 0.15 || 1

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={points} margin={{ top: 16, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid stroke={colors.grid} vertical={false} syncWithTicks />
        <XAxis
          dataKey="month"
          tickFormatter={shortMonth}
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          dy={6}
          interval={0}
        />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={56}
          domain={[lo - padding, hi + padding]}
          tickFormatter={compactInt}
        />
        <Tooltip content={<ArticleTip />} cursor={{ fill: colors.grid, fillOpacity: 0.7 }} />
        {/* Zero is what the whole chart is read against. */}
        <ReferenceLine y={0} stroke={colors.line} />
        <Bar
          dataKey="variance"
          radius={[2, 2, 0, 0]}
          maxBarSize={44}
          isAnimationActive
          animationDuration={650}
          animationEasing="ease-out"
        >
          {points.map((p) => (
            <Cell key={p.month} fill={Number(p.variance) > 0 ? colors.amber : colors.blue} />
          ))}
          <LabelList
            dataKey="variance"
            content={(props) => {
              const n = Number(props.value)
              if (!Number.isFinite(n)) return null
              // Above a positive column, below a negative one - never inside,
              // where a short column would clip the figure.
              const above = n >= 0
              return (
                <text
                  x={Number(props.x) + Number(props.width) / 2}
                  y={above ? Number(props.y) - 5 : Number(props.y) + Number(props.height) + 12}
                  textAnchor="middle"
                  fill={colors.plain}
                  fontSize={10}
                  fontFamily="Inter, sans-serif"
                >
                  {signed(n)}
                </text>
              )
            }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
