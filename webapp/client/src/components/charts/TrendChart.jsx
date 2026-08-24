import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useChartTheme } from './useChartTheme.js'
import { compactInt, fmtInt, fmtLongDate, fmtSignedPct } from '../../api.js'
import { tightScale } from './scale.js'

function TrendTooltip({ active, payload, label, colors }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  // Whether the day landed inside the band. Said in words, because a reader
  // hovering a point should not have to eyeball whether it is inside a shape.
  const usual = row.usual
  const inBand =
    usual && row.Actual_Qty !== null && row.Actual_Qty !== undefined
      ? row.Actual_Qty >= usual[0] && row.Actual_Qty <= usual[1]
      : null
  const actual = row.Actual_Qty
  const forecast = row.Forecast_Qty
  const variance = forecast ? (actual - forecast) / forecast : null

  return (
    <div className="tt">
      <div className="tt__title">{fmtLongDate(label)}</div>
      <div className="tt__row">
        <span className="legend__rule" style={{ color: colors.actual }} />
        <span className="tt__name">Actual</span>
        <span className="tt__val">{fmtInt(actual)}</span>
      </div>
      <div className="tt__row">
        <span className="legend__rule legend__rule--dashed" style={{ color: colors.forecast }} />
        <span className="tt__name">Forecast</span>
        <span className="tt__val">{fmtInt(forecast)}</span>
      </div>
      {actual !== null && actual !== undefined && variance !== null && (
        <div className="tt__delta">
          <span className="tt__name">Variance</span>
          <span className="tt__val">{fmtSignedPct(variance)}</span>
        </div>
      )}
      {inBand !== null && (
        <div className="tt__row">
          <span className="legend__swatch" style={{ background: 'transparent' }} />
          <span className="tt__name">{inBand ? 'Within the usual range' : 'Outside the usual range'}</span>
        </div>
      )}
    </div>
  )
}

/**
 * Actual vs forecast over time. Actual is a solid line over a soft area fill;
 * forecast is a dashed line, so the two are separable without relying on colour.
 * The value axis uses evenly spaced round steps, as in the reference UI.
 */
export function TrendChart({ data, today, height = 300, fill = false, band = null }) {
  const colors = useChartTheme()
  const { domain, ticks } = tightScale(data, ['Actual_Qty', 'Forecast_Qty'])

  // Bands between the two lines. The name describes the FORECAST's error:
  //   forecast BELOW actual -> we forecast too little -> under-forecast
  //   forecast ABOVE actual -> we forecast too much   -> over-forecast
  // Equal endpoints collapse to zero height, so no nulls are needed and the two
  // bands never overlap.
  const banded = data.map((d) => {
    const a = d.Actual_Qty
    const f = d.Forecast_Qty
    const both = a !== null && a !== undefined && f !== null && f !== undefined
    return {
      ...d,
      under: both ? [f, Math.max(a, f)] : null,
      over: both ? [Math.min(a, f), f] : null,
      // Where actual lands on a normal day, given this forecast. Drawn from the
      // 10th–90th percentile of the brand's own recent daily variance, so
      // "normal" means normal for this brand rather than an assumed tolerance.
      usual:
        band && f !== null && f !== undefined
          ? [f / (1 + band.hi), f / (1 + band.lo)]
          : null,
    }
  })

  const chart = (
    <ResponsiveContainer width="100%" height={fill ? '100%' : height}>
      <ComposedChart data={banded} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="actualFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors.actual} stopOpacity={0.16} />
            <stop offset="100%" stopColor={colors.actual} stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid stroke={colors.grid} vertical={false} syncWithTicks />

        {/* Behind everything else: context, not a series. */}
        {band && (
          <Area
            type="monotone"
            dataKey="usual"
            stroke={colors.neutral}
            strokeOpacity={0.28}
            strokeWidth={1}
            strokeDasharray="3 3"
            fill={colors.neutral}
            fillOpacity={0.07}
            isAnimationActive={false}
            connectNulls={false}
            legendType="none"
          />
        )}
        <XAxis
          dataKey="Date"
          tickFormatter={(v) => fmtLongDate(v).replace(/^\w+, /, '').replace(/ \d{4}$/, '')}
          tick={{ fill: colors.muted, fontSize: 10, fontFamily: 'Inter, sans-serif' }}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          dy={6}
        />
        <YAxis
          tick={{ fill: colors.muted, fontSize: 10, fontFamily: 'Inter, sans-serif' }}
          tickLine={false}
          axisLine={false}
          width={44}
          domain={domain}
          ticks={ticks}
          tickFormatter={compactInt}
        />
        <Tooltip content={<TrendTooltip colors={colors} />} cursor={{ stroke: colors.line, strokeWidth: 1 }} />

        {today && <ReferenceLine x={today} stroke={colors.line} />}

        <Area
          type="monotone"
          dataKey="under"
          stroke="none"
          fill={colors.actual}
          fillOpacity={0.18}
          isAnimationActive
          animationDuration={700}
          animationEasing="ease-out"
          connectNulls={false}
        />
        <Area
          type="monotone"
          dataKey="over"
          stroke="none"
          fill={colors.red}
          fillOpacity={0.18}
          isAnimationActive
          animationDuration={700}
          animationEasing="ease-out"
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey="Forecast_Qty"
          name="Forecast"
          stroke={colors.forecast}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
          activeDot={{ r: 3.5, strokeWidth: 2, stroke: colors.surface }}
          isAnimationActive
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Line
          type="monotone"
          dataKey="Actual_Qty"
          name="Actual"
          stroke={colors.actual}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3.5, strokeWidth: 2, stroke: colors.surface }}
          connectNulls={false}
          isAnimationActive
          animationDuration={700}
          animationEasing="ease-out"
        />
      </ComposedChart>
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
