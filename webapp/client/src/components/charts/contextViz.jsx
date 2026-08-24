import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useChartTheme } from './useChartTheme.js'
import { fmtInt, fmtSignedPct, fmtDate } from '../../api.js'

/**
 * Charts that explain the gap between forecast and actual, for the pages
 * ordinary users read.
 *
 * They exist because "the forecast said 300 and we sold 260" is a complaint
 * until something tells you why. All three are honest about the case where the
 * forecast itself is at fault — that is the point of them, not a caveat.
 */

const AXIS = { fontSize: 10, fontFamily: 'Inter, sans-serif' }

function Tip({ title, rows }) {
  return (
    <div className="tt">
      <div className="tt__title">{title}</div>
      {rows.map(([name, value, color]) => (
        <div className="tt__row" key={name}>
          <span className="legend__swatch" style={{ background: color ?? 'transparent' }} />
          <span className="tt__name">{name}</span>
          <span className="tt__val">{value}</span>
        </div>
      ))}
    </div>
  )
}

const pctAxis = (v) => `${(v * 100).toFixed(0)}%`

/**
 * Week-on-week change in what sold, against week-on-week change in what was
 * forecast.
 *
 * When the lines move together the forecast is tracking demand. When actual
 * turns and forecast does not, the space between them is the reason this week's
 * numbers are off — and it is a demand event, not a calculation fault. One axis:
 * both series are percentage change on the previous week.
 */
export function DemandResponseChart({ weekly, height = 170 }) {
  const colors = useChartTheme()
  const data = (weekly ?? []).filter((w) => w.actualChange !== null)
  if (!data.length) return null

  const spread = Math.max(
    0.05,
    ...data.flatMap((d) => [Math.abs(d.actualChange ?? 0), Math.abs(d.forecastChange ?? 0)])
  )
  const top = Math.ceil(spread * 20) / 20

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={colors.grid} vertical={false} syncWithTicks />
        <XAxis
          dataKey="to"
          tickFormatter={(v) => `w/e ${fmtDate(v)}`}
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          dy={4}
        />
        <YAxis
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          width={46}
          domain={[-top, top]}
          ticks={[-top, 0, top]}
          tickFormatter={pctAxis}
        />
        <ReferenceLine y={0} stroke={colors.neutral} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload
            const lag = (p.actualChange ?? 0) - (p.forecastChange ?? 0)
            return (
              <Tip
                title={`Week ending ${fmtDate(p.to)}`}
                rows={[
                  ['Sold, vs prior week', fmtSignedPct(p.actualChange), colors.actual],
                  ['Forecast, vs prior week', fmtSignedPct(p.forecastChange), colors.forecast],
                  ['Forecast behind demand by', fmtSignedPct(lag)],
                  ['Units sold', fmtInt(p.actual)],
                ]}
              />
            )
          }}
        />
        <Line
          type="monotone"
          dataKey="actualChange"
          name="Sold"
          stroke={colors.actual}
          strokeWidth={2}
          dot={{ r: 3, strokeWidth: 0, fill: colors.actual }}
          isAnimationActive
          animationDuration={600}
        />
        <Line
          type="monotone"
          dataKey="forecastChange"
          name="Forecast"
          stroke={colors.forecast}
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={{ r: 3, strokeWidth: 0, fill: colors.forecast }}
          isAnimationActive
          animationDuration={600}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

/**
 * How far each weekday has run over or under, with the day being planned
 * highlighted.
 *
 * A branch preparing for Wednesday needs to know Wednesday is habitually over,
 * not that the month averaged 9% out. Green is on track, amber drifting, red an
 * outlier — the same thresholds as everywhere else in the app.
 */
export function WeekdayLeanChart({ weekday, highlight = null, height = 200 }) {
  const colors = useChartTheme()
  const data = weekday ?? []
  if (!data.length) return null

  const top = Math.max(0.05, ...data.map((d) => Math.abs(d.lean)))
  const step = top <= 0.05 ? 0.025 : top <= 0.1 ? 0.05 : top <= 0.2 ? 0.1 : 0.2
  const cap = Math.ceil(top / step) * step

  const tone = (v) => {
    const m = Math.abs(v)
    if (m > 0.15) return colors.red
    return m <= 0.05 ? colors.actual : colors.amber
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="26%">
        <CartesianGrid stroke={colors.grid} vertical={false} syncWithTicks />
        <XAxis
          dataKey="label"
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          dy={4}
          interval={0}
        />
        <YAxis
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          width={44}
          domain={[-cap, cap]}
          ticks={[-cap, 0, cap]}
          tickFormatter={pctAxis}
        />
        <ReferenceLine y={0} stroke={colors.neutral} />
        <Tooltip
          cursor={{ fill: 'rgba(0,0,0,0.04)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload
            return (
              <Tip
                title={p.label}
                rows={[
                  [
                    p.lean > 0 ? 'Forecast above actual' : 'Forecast below actual',
                    fmtSignedPct(p.lean),
                    tone(p.lean),
                  ],
                  ['Weeks measured', String(p.samples)],
                ]}
              />
            )
          }}
        />
        <Bar dataKey="lean" radius={[2, 2, 2, 2]} maxBarSize={38} isAnimationActive animationDuration={600}>
          {data.map((d) => (
            <Cell
              key={d.label}
              fill={tone(d.lean)}
              // The day being planned is outlined rather than the other six
              // being dimmed. Fading them washed the chart out, and the whole
              // point is that the highlighted day reads as part of a pattern.
              stroke={highlight && d.label === highlight ? colors.plain : 'none'}
              strokeWidth={highlight && d.label === highlight ? 1.5 : 0}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * Every branch's lean, sorted.
 *
 * The meaning is in the pattern, not any single bar: all branches leaning one
 * way is a brand-wide model offset that no branch can do anything about. A lone
 * branch leaning the other way is the one worth investigating, and this is the
 * only view where that stands out.
 */
export function BranchLeanChart({ locations, highlight = [], height = 220 }) {
  const colors = useChartTheme()
  const data = locations ?? []
  if (!data.length) return null

  const top = Math.max(0.05, ...data.map((d) => Math.abs(d.lean)))
  const step = top <= 0.05 ? 0.025 : top <= 0.1 ? 0.05 : top <= 0.2 ? 0.1 : 0.2
  const cap = Math.ceil(top / step) * step
  const marked = new Set(highlight.map(String))

  const tone = (v) => {
    const m = Math.abs(v)
    if (m > 0.15) return colors.red
    return m <= 0.05 ? colors.actual : colors.amber
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
        <CartesianGrid stroke={colors.grid} vertical={false} syncWithTicks />
        <XAxis
          dataKey="location"
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          dy={4}
          interval={0}
        />
        <YAxis
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          width={44}
          domain={[-cap, cap]}
          ticks={[-cap, 0, cap]}
          tickFormatter={pctAxis}
        />
        <ReferenceLine y={0} stroke={colors.neutral} />
        <Tooltip
          cursor={{ fill: 'rgba(0,0,0,0.04)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload
            return (
              <Tip
                title={p.location}
                rows={[
                  [
                    p.lean > 0 ? 'Forecast above actual' : 'Forecast below actual',
                    fmtSignedPct(p.lean),
                    tone(p.lean),
                  ],
                  ['Accuracy', `${(p.accuracy * 100).toFixed(1)}%`],
                  ['Units sold', fmtInt(p.qty)],
                ]}
              />
            )
          }}
        />
        <Bar dataKey="lean" radius={[2, 2, 2, 2]} maxBarSize={34} isAnimationActive animationDuration={600}>
          {data.map((d) => (
            <Cell
              key={d.location}
              fill={tone(d.lean)}
              stroke={marked.has(String(d.location)) ? colors.plain : 'none'}
              strokeWidth={marked.has(String(d.location)) ? 1.5 : 0}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
