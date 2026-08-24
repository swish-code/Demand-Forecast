import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useChartTheme } from './useChartTheme.js'
import { compactInt, fmtInt, fmtSignedPct } from '../../api.js'
import { twoLineScale } from './scale.js'

function BarTooltip({ active, payload, label, colors, categoryLabel, actualLabel, forecastLabel }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  const variance = row.Forecast_Qty ? (row.Actual_Qty - row.Forecast_Qty) / row.Forecast_Qty : null

  return (
    <div className="tt">
      <div className="tt__title">
        {categoryLabel}: {label}
      </div>
      <div className="tt__row">
        <span className="legend__swatch" style={{ background: colors.actual }} />
        <span className="tt__name">{actualLabel}</span>
        <span className="tt__val">{fmtInt(row.Actual_Qty)}</span>
      </div>
      <div className="tt__row">
        <span className="legend__swatch" style={{ background: colors.forecast }} />
        <span className="tt__name">{forecastLabel}</span>
        <span className="tt__val">{fmtInt(row.Forecast_Qty)}</span>
      </div>
      {variance !== null && (
        <div className="tt__delta">
          <span className="tt__name">Variance</span>
          <span className="tt__val">{fmtSignedPct(variance)}</span>
        </div>
      )}
    </div>
  )
}

/**
 * The gap between the pair, written at the end of the bar. Coloured only once
 * the gap passes the outlier limit; inside it the figure is plain text, so a
 * coloured label down the list always means something.
 */
function DeltaLabel({ x, y, width, height, value, colors, limit = 0.15 }) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null
  const n = Number(value)
  const outlier = Math.abs(n) > limit
  return (
    <text
      x={Number(x) + Number(width) + 8}
      y={Number(y) + Number(height) / 2 + 3}
      fill={outlier ? (n > 0 ? colors.actual : colors.red) : colors.plain}
      fontSize={10}
      fontFamily="Inter, sans-serif"
    >
      {(n > 0 ? '+' : '') + (n * 100).toFixed(1) + '%'}
    </text>
  )
}

const truncate = (v, n) => (String(v).length > n ? `${String(v).slice(0, n - 1)}…` : String(v))

/** Grouped actual-vs-forecast bars, two colours, two gridlines. */
/* eslint-disable react/prop-types */
export function CategoryBarChart({
  data,
  dataKey,
  categoryLabel,
  orientation = 'columns',
  height = 320,
  actualLabel = 'Actual',
  forecastLabel = 'Forecast',
  fill = false,
  showDelta = false,
  onBarClick,
}) {
  const colors = useChartTheme()
  // The same actual/forecast pair as the trend chart, so one colour means one
  // thing everywhere on the page.
  const barColors = { actual: colors.actual, forecast: colors.forecast }
  const horizontal = orientation === 'bars'
  const axisTick = { fill: colors.muted, fontSize: 10, fontFamily: 'Inter, sans-serif' }
  const { domain, ticks } = twoLineScale(data, ['Actual_Qty', 'Forecast_Qty'])

  const chart = (
    <ResponsiveContainer width="100%" height={fill ? '100%' : height}>
      <BarChart
        data={data}
        layout={horizontal ? 'vertical' : 'horizontal'}
        /* Delta labels sit past the bar end, so reserve room or they clip. */
        margin={{ top: 4, right: showDelta ? 56 : 16, bottom: 0, left: 0 }}
        barGap={2}
        barCategoryGap="26%"
      >
        <CartesianGrid stroke={colors.grid} vertical={horizontal} horizontal={!horizontal} syncWithTicks />

        {horizontal ? (
          <>
            <XAxis
              type="number"
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              domain={domain}
              ticks={ticks}
              tickFormatter={compactInt}
            />
            <YAxis
              type="category"
              dataKey={dataKey}
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              width={150}
              tickFormatter={(v) => truncate(v, 22)}
              interval={0}
            />
          </>
        ) : (
          <>
            <XAxis
              type="category"
              dataKey={dataKey}
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              interval={0}
              dy={4}
              tickFormatter={(v) => truncate(v, 12)}
            />
            <YAxis
              type="number"
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              width={44}
              domain={domain}
              ticks={ticks}
              tickFormatter={compactInt}
            />
          </>
        )}

        <Tooltip
          content={
            <BarTooltip
              colors={barColors}
              categoryLabel={categoryLabel}
              actualLabel={actualLabel}
              forecastLabel={forecastLabel}
            />
          }
          cursor={{ fill: colors.grid, fillOpacity: 0.7 }}
        />

        <Bar
          dataKey="Actual_Qty"
          name={actualLabel}
          fill={barColors.actual}
          onClick={onBarClick}
          cursor={onBarClick ? 'pointer' : undefined}
          radius={horizontal ? [0, 2, 2, 0] : [2, 2, 0, 0]}
          maxBarSize={horizontal ? 10 : 40}
          isAnimationActive
          animationDuration={650}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="Forecast_Qty"
          name={forecastLabel}
          fill={barColors.forecast}
          radius={horizontal ? [0, 2, 2, 0] : [2, 2, 0, 0]}
          maxBarSize={horizontal ? 10 : 40}
          onClick={onBarClick}
          cursor={onBarClick ? 'pointer' : undefined}
          isAnimationActive
          animationDuration={650}
          animationEasing="ease-out"
        >
          {showDelta && (
            <LabelList
              dataKey="Variance_Pct"
              position="right"
              offset={8}
              content={(props) => <DeltaLabel {...props} colors={colors} />}
            />
          )}
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

/** Single-series magnitude bars, used for one unit of measure at a time. */
export function SingleBarChart({ data, dataKey, valueKey, unit, color, height = 300, formatValue = fmtInt }) {
  const colors = useChartTheme()
  const axisTick = { fill: colors.muted, fontSize: 10, fontFamily: 'Inter, sans-serif' }
  const { domain, ticks } = twoLineScale(data, [valueKey])
  const fill = color ?? colors.actual

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid stroke={colors.grid} vertical horizontal={false} syncWithTicks />
        <XAxis
          type="number"
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          domain={domain}
          ticks={ticks}
          tickFormatter={compactInt}
        />
        <YAxis
          type="category"
          dataKey={dataKey}
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={168}
          interval={0}
          tickFormatter={(v) => truncate(v, 24)}
        />
        <Tooltip
          cursor={{ fill: colors.grid, fillOpacity: 0.7 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            return (
              <div className="tt">
                <div className="tt__title">{label}</div>
                <div className="tt__row">
                  <span className="legend__swatch" style={{ background: fill }} />
                  <span className="tt__name">Forecast qty</span>
                  <span className="tt__val">
                    {formatValue(payload[0].value)} {unit}
                  </span>
                </div>
              </div>
            )
          }}
        />
        <Bar
          dataKey={valueKey}
          fill={fill}
          radius={[0, 2, 2, 0]}
          maxBarSize={11}
          isAnimationActive
          animationDuration={650}
          animationEasing="ease-out"
        >
          {/* Rank fade: the leading bar is full strength, each one below a little
              lighter, so the ordering reads even before the labels do. */}
          {data.map((row, i) => (
            <Cell key={row[dataKey] ?? i} fillOpacity={Math.max(0.42, 1 - i * 0.075)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
