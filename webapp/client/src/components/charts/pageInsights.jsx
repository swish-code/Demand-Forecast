import { useMemo } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useChartTheme } from './useChartTheme.js'
import { fmtInt } from '../../api.js'

/**
 * The production plan's own chart.
 *
 * Forecast-accuracy visuals used to live here too, on the product and component
 * pages. They were taken out deliberately: how wrong the model has been is an
 * operator's question, and the admin page answers it. A branch opening the plan
 * needs to know what to prepare, not how much to distrust it.
 */

const AXIS = { fontSize: 10, fontFamily: 'Inter, sans-serif' }
const CURSOR = { fill: 'rgba(0,0,0,0.04)' }

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

/* -------------------------------------------------------- prep pressure */

/**
 * Tomorrow's prep load per branch, split by which way each product is moving.
 *
 * A branch with sixty products all needing extra prep is a different morning
 * from one with sixty products running normally, and the plan table sorted by
 * volume never shows that. Stacked because the parts sum to a real total: every
 * product on that branch's plan.
 */
export function PrepPressureChart({ rows, height = 260, onSelect }) {
  const colors = useChartTheme()

  const data = useMemo(() => {
    const map = new Map()
    for (const r of rows) {
      const key = r.LocationID || '—'
      const prev = map.get(key) ?? { location: key, extra: 0, normal: 0, reduced: 0, qty: 0 }
      if (r.Prep_Status === 'Extra Prep Needed') prev.extra += 1
      else if (r.Prep_Status === 'Reduced Prep Needed') prev.reduced += 1
      else prev.normal += 1
      prev.qty += Number(r.Tomorrow_Forecast_Qty) || 0
      map.set(key, prev)
    }
    // Ordered by how much of the branch is changing, not by size: the busiest
    // branch is not necessarily the one with the most to rethink.
    return [...map.values()]
      .map((d) => ({ ...d, changing: d.extra + d.reduced }))
      .sort((a, b) => b.changing - a.changing)
      .slice(0, 14)
  }, [rows])

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="24%">
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
          width={40}
          allowDecimals={false}
          tickCount={4}
        />
        <Tooltip
          cursor={CURSOR}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload
            return (
              <Tip
                title={p.location}
                rows={[
                  ['Extra prep', fmtInt(p.extra), colors.amber],
                  ['Normal', fmtInt(p.normal), colors.neutral],
                  ['Reduced prep', fmtInt(p.reduced), colors.actual],
                  ['Tomorrow forecast', fmtInt(p.qty)],
                ]}
              />
            )
          }}
        />
        {/* 2px surface gap between segments, so the split reads as parts. */}
        <Bar dataKey="extra" stackId="p" fill={colors.amber} isAnimationActive animationDuration={600}
          stroke={colors.surface} strokeWidth={2}
          onClick={(d) => onSelect?.(d?.payload ?? d)} cursor={onSelect ? 'pointer' : undefined} />
        <Bar dataKey="normal" stackId="p" fill={colors.neutral} isAnimationActive animationDuration={600}
          stroke={colors.surface} strokeWidth={2}
          onClick={(d) => onSelect?.(d?.payload ?? d)} cursor={onSelect ? 'pointer' : undefined} />
        <Bar dataKey="reduced" stackId="p" fill={colors.actual} radius={[4, 4, 0, 0]} isAnimationActive
          stroke={colors.surface} strokeWidth={2}
          animationDuration={600} onClick={(d) => onSelect?.(d?.payload ?? d)} cursor={onSelect ? 'pointer' : undefined} />
      </BarChart>
    </ResponsiveContainer>
  )
}
