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
import { fmtInt, fmtPct, fmtSignedPct, fmtLongDate } from '../../api.js'

/** Colour for a signed bias: green on track, amber drifting, red an outlier. */
function biasColor(bias, colors, ok = 0.05, limit = 0.15) {
  const m = Math.abs(bias)
  if (m > limit) return colors.red
  return m <= ok ? colors.actual : colors.amber
}

/** Symmetric percent axis around zero, so over and under read at equal weight. */
function symmetricPercentDomain(values, floor = 0.05) {
  const max = Math.max(floor, ...values.map((v) => Math.abs(Number(v) || 0)))
  const step = max <= 0.05 ? 0.025 : max <= 0.1 ? 0.05 : max <= 0.2 ? 0.1 : 0.2
  const top = Math.ceil(max / step) * step
  return { domain: [-top, top], ticks: [-top, 0, top] }
}

/**
 * Bias by day of week. The daily line shows *when* forecast and actual diverge;
 * this shows whether a particular weekday is always wrong, which is the part
 * you can actually fix in the model.
 */
export function WeekdayBiasChart({ data, height = 220, fill = false }) {
  const colors = useChartTheme()
  const { domain, ticks } = symmetricPercentDomain(data.map((d) => d.bias))

  const chart = (
    <ResponsiveContainer width="100%" height={fill ? '100%' : height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="26%">
        <CartesianGrid stroke={colors.grid} vertical={false} syncWithTicks />
        <XAxis
          dataKey="day"
          tick={{ fill: colors.muted, fontSize: 11, fontFamily: 'Inter, sans-serif' }}
          tickLine={false}
          axisLine={false}
          dy={4}
        />
        <YAxis
          tick={{ fill: colors.muted, fontSize: 10, fontFamily: 'Inter, sans-serif' }}
          tickLine={false}
          axisLine={false}
          width={44}
          domain={domain}
          ticks={ticks}
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
        />
        <ReferenceLine y={0} stroke={colors.line} />
        <Tooltip
          cursor={{ fill: colors.grid, fillOpacity: 0.6 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            const row = payload[0].payload
            return (
              <div className="tt">
                <div className="tt__title">{label}</div>
                <div className="tt__row">
                  <span className="tt__name">{row.bias >= 0 ? 'Under forecast' : 'Over forecast'}</span>
                  <span className="tt__val">{fmtSignedPct(row.bias)}</span>
                </div>
                <div className="tt__row">
                  <span className="tt__name">Accuracy</span>
                  <span className="tt__val">{fmtPct(row.accuracy)}</span>
                </div>
                <div className="tt__delta">
                  <span className="tt__name">Days in range</span>
                  <span className="tt__val">{row.days}</span>
                </div>
              </div>
            )
          }}
        />
        <Bar dataKey="bias" radius={[2, 2, 2, 2]} maxBarSize={34} isAnimationActive animationDuration={650}>
          {data.map((d) => (
            <Cell key={d.day} fill={biasColor(d.bias, colors)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )

  // Paired with a tall table, the bars should use the panel rather than leave a
  // band of empty card under them.
  return fill ? (
    <div className="chartfill" style={{ minHeight: height }}>
      {chart}
    </div>
  ) : (
    chart
  )
}

/**
 * Which products account for the total miss, largest first, with the running
 * share of the gap written on each bar. Turns one aggregate number into a
 * short, ordered fix-list.
 */
export function GapParetoChart({ data, onBarClick, height = 260, fill = false }) {
  const colors = useChartTheme()
  const max = Math.max(1, ...data.map((d) => d.abs))

  const chart = (
    <ResponsiveContainer width="100%" height={fill ? '100%' : height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 64, bottom: 0, left: 0 }}
        barCategoryGap="24%"
      >
        <CartesianGrid stroke={colors.grid} vertical horizontal={false} syncWithTicks />
        <XAxis
          type="number"
          domain={[0, max]}
          ticks={[0, max / 2, max]}
          tick={{ fill: colors.muted, fontSize: 10, fontFamily: 'Inter, sans-serif' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => fmtInt(v)}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fill: colors.muted, fontSize: 11, fontFamily: 'Inter, sans-serif' }}
          tickLine={false}
          axisLine={false}
          width={168}
          interval={0}
          tickFormatter={(v) => (String(v).length > 24 ? `${String(v).slice(0, 23)}…` : v)}
        />
        <Tooltip
          cursor={{ fill: colors.grid, fillOpacity: 0.6 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            const row = payload[0].payload
            return (
              <div className="tt">
                <div className="tt__title">{label}</div>
                <div className="tt__row">
                  <span className="tt__name">{row.gap >= 0 ? 'Under forecast by' : 'Over forecast by'}</span>
                  <span className="tt__val">{fmtInt(row.abs)} units</span>
                </div>
                <div className="tt__row">
                  <span className="tt__name">Variance</span>
                  <span className="tt__val">{fmtSignedPct(row.pct)}</span>
                </div>
                <div className="tt__delta">
                  <span className="tt__name">Running share of gap</span>
                  <span className="tt__val">{fmtPct(row.cum, 0)}</span>
                </div>
              </div>
            )
          }}
        />
        <Bar
          dataKey="abs"
          radius={[0, 2, 2, 0]}
          maxBarSize={16}
          isAnimationActive
          animationDuration={650}
          onClick={onBarClick}
          cursor={onBarClick ? 'pointer' : undefined}
          label={(props) => {
            const row = data[props.index]
            if (!row) return null
            return (
              <text
                x={Number(props.x) + Number(props.width) + 8}
                y={Number(props.y) + Number(props.height) / 2 + 3}
                fill={colors.muted}
                fontSize={10}
                fontFamily="Inter, sans-serif"
              >
                {fmtPct(row.cum, 0)}
              </text>
            )
          }}
        >
          {data.map((d) => (
            <Cell key={d.name} fill={d.gap >= 0 ? colors.actual : colors.red} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )

  return fill ? (
    <div className="chartfill" style={{ minHeight: height }}>
      {chart}
    </div>
  ) : (
    chart
  )
}

/**
 * Seven-day rolling accuracy against target. A single daily figure is noisy;
 * the rolling window answers the question the daily line cannot — is this
 * getting better or worse?
 */
export function RollingAccuracyChart({ data, target = 0.95, height = 220 }) {
  const colors = useChartTheme()
  const values = data.map((d) => d.accuracy).filter((v) => Number.isFinite(v))
  const lo = Math.min(target, ...values)
  const hi = Math.max(target, ...values)
  const pad = Math.max(0.01, (hi - lo) * 0.25)
  const domain = [Math.max(0, lo - pad), Math.min(1, hi + pad)]

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={colors.grid} vertical={false} syncWithTicks />
        <XAxis
          dataKey="Date"
          tick={{ fill: colors.muted, fontSize: 10, fontFamily: 'Inter, sans-serif' }}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          dy={4}
          tickFormatter={(v) => fmtLongDate(v).replace(/^\w+, /, '').replace(/ \d{4}$/, '')}
        />
        <YAxis
          tick={{ fill: colors.muted, fontSize: 10, fontFamily: 'Inter, sans-serif' }}
          tickLine={false}
          axisLine={false}
          width={44}
          domain={domain}
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
        />
        <ReferenceLine
          y={target}
          stroke={colors.amber}
          strokeDasharray="4 3"
          label={{ value: 'Target', position: 'insideTopRight', fill: colors.muted, fontSize: 10 }}
        />
        <Tooltip
          cursor={{ stroke: colors.line, strokeWidth: 1 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            return (
              <div className="tt">
                <div className="tt__title">{fmtLongDate(label)}</div>
                <div className="tt__row">
                  <span className="tt__name">7-day accuracy</span>
                  <span className="tt__val">{fmtPct(payload[0].value)}</span>
                </div>
              </div>
            )
          }}
        />
        <Line
          type="monotone"
          dataKey="accuracy"
          stroke={colors.actual}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3.5, strokeWidth: 2, stroke: colors.surface }}
          isAnimationActive
          animationDuration={700}
          animationEasing="ease-out"
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
