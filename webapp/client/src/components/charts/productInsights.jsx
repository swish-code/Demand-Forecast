import { useMemo } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import { useChartTheme } from './useChartTheme.js'
import { fmtInt, fmtSignedPct, compactInt } from '../../api.js'

/**
 * Two views of what is happening to demand, for the product page.
 *
 * Neither is about forecast error — that belongs on the admin page. These are
 * about the products themselves: what moved, and what is worth caring about.
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

/**
 * Products ranked by how much their demand moved against the previous period.
 *
 * The point is that it needs no reading: 543 rows sorted by volume hide a line
 * collapsing 95% somewhere in the middle, and this puts it at the top. Rises
 * and falls share one chart because a range change usually shows as both at
 * once — something new appearing while something else disappears.
 *
 * Restricted to lines with real volume on one side or the other, so a product
 * that went from two units to six does not outrank one that lost twenty
 * thousand.
 */
export function MoversChart({ rows, height = 320, onSelect, minUnits = 200, top = 8 }) {
  const colors = useChartTheme()

  const data = useMemo(() => {
    const comparable = rows
      .filter((r) => r.Demand_Shift_Pct !== null && r.Demand_Shift_Pct !== undefined)
      .filter((r) => Number(r.Actual_Qty) >= minUnits || Number(r.Prev_Actual_Qty) >= minUnits)
      .map((r) => ({
        name: r.ProductName_Fixed_Option,
        article: r.Clean_ItemID,
        now: Number(r.Actual_Qty) || 0,
        was: Number(r.Prev_Actual_Qty) || 0,
        change: Number(r.Demand_Shift_Pct),
      }))

    const up = [...comparable].sort((a, b) => b.change - a.change).slice(0, top)
    const down = [...comparable].sort((a, b) => a.change - b.change).slice(0, top)

    // Falls first, so the eye lands on what disappeared.
    return [...down.reverse(), ...up].filter(
      (v, i, arr) => arr.findIndex((x) => x.article === v.article) === i
    )
  }, [rows, minUnits, top])

  if (!data.length) return null

  // Clamped: one line going from 20 units to 1,655 is +8,000%, which would
  // flatten every other bar to nothing.
  const cap = 2
  const plotted = data.map((d) => ({ ...d, bar: Math.max(-1, Math.min(cap, d.change)) }))

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={plotted} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 0 }} barCategoryGap="18%">
        <CartesianGrid stroke={colors.grid} horizontal={false} syncWithTicks />
        <XAxis
          type="number"
          domain={[-1, cap]}
          ticks={[-1, -0.5, 0, 1, 2]}
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%`}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          width={150}
        />
        <ReferenceLine x={0} stroke={colors.neutral} />
        <Tooltip
          cursor={{ fill: 'rgba(0,0,0,0.04)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload
            return (
              <Tip
                title={p.name}
                rows={[
                  ['Article', String(p.article)],
                  ['Change', fmtSignedPct(p.change), p.change >= 0 ? colors.actual : colors.red],
                  ['This period', fmtInt(p.now)],
                  ['Previous', fmtInt(p.was)],
                ]}
              />
            )
          }}
        />
        <Bar
          dataKey="bar"
          radius={[2, 2, 2, 2]}
          maxBarSize={18}
          isAnimationActive
          animationDuration={600}
          onClick={(d) => onSelect?.(d?.payload ?? d)}
          cursor={onSelect ? 'pointer' : undefined}
        >
          {plotted.map((d) => (
            <Cell key={d.article} fill={d.change >= 0 ? colors.actual : colors.red} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * Every product placed by size against direction: how much it sells, and
 * whether it is growing or shrinking.
 *
 * The quadrant it lands in is the instruction. Top right is growing volume —
 * protect the supply. Bottom right is the one that matters: big and falling,
 * which costs the most and is easiest to miss in a table. Left of the volume
 * line is small either way, and mostly safe to ignore.
 */
export function VolumeChangeChart({ rows, height = 320, onSelect, limit = 400 }) {
  const colors = useChartTheme()

  const points = useMemo(
    () =>
      rows
        .filter((r) => r.Demand_Shift_Pct !== null && r.Demand_Shift_Pct !== undefined)
        .filter((r) => Number(r.Actual_Qty) > 0)
        .sort((a, b) => Number(b.Actual_Qty) - Number(a.Actual_Qty))
        .slice(0, limit)
        .map((r) => ({
          name: r.ProductName_Fixed_Option,
          article: r.Clean_ItemID,
          qty: Number(r.Actual_Qty),
          change: Math.max(-1, Math.min(2, Number(r.Demand_Shift_Pct))),
          raw: Number(r.Demand_Shift_Pct),
        })),
    [rows, limit]
  )

  // The line between "big" and "small" is this brand's own median, not a
  // number picked in advance — a big product for Just C is a rounding error
  // for BBT.
  const median = useMemo(() => {
    if (!points.length) return 0
    const sorted = points.map((p) => p.qty).sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }, [points])

  const ticks = useMemo(() => {
    if (!points.length) return undefined
    const hi = Math.max(...points.map((p) => p.qty))
    const out = []
    for (let e = 0; Math.pow(10, e) <= hi * 10; e++) out.push(Math.pow(10, e))
    return out.length > 1 ? out : undefined
  }, [points])

  if (!points.length) return null

  const colorFor = (p) =>
    p.qty >= median ? (p.raw >= 0 ? colors.actual : colors.red) : p.raw >= 0 ? colors.forecast : colors.amber

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 10, right: 14, bottom: 4, left: 0 }}>
        <CartesianGrid stroke={colors.grid} vertical={false} />
        <XAxis
          type="number"
          dataKey="qty"
          scale="log"
          domain={['auto', 'auto']}
          ticks={ticks}
          allowDataOverflow
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          tickFormatter={compactInt}
          height={28}
        />
        <YAxis
          type="number"
          dataKey="change"
          domain={[-1, 2]}
          ticks={[-1, -0.5, 0, 1, 2]}
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          width={50}
          tickFormatter={(v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%`}
        />
        <ZAxis range={[34, 34]} />

        {/* The two lines that make the quadrants. */}
        <ReferenceLine y={0} stroke={colors.neutral} />
        <ReferenceLine
          x={median}
          stroke={colors.neutral}
          strokeDasharray="4 3"
          label={{
            value: 'median size',
            position: 'top',
            fill: colors.muted,
            fontSize: 10,
            fontFamily: 'Inter, sans-serif',
          }}
        />

        <Tooltip
          cursor={{ strokeDasharray: '3 3' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const p = payload[0].payload
            const quadrant =
              p.qty >= median
                ? p.raw >= 0
                  ? 'Big and growing — protect supply'
                  : 'Big and shrinking — the one that costs'
                : p.raw >= 0
                  ? 'Small and growing — one to watch'
                  : 'Small and shrinking — low priority'
            return (
              <Tip
                title={p.name}
                rows={[
                  ['Units sold', fmtInt(p.qty), colorFor(p)],
                  ['Change', fmtSignedPct(p.raw)],
                  [quadrant, ''],
                ]}
              />
            )
          }}
        />
        <Scatter
          data={points}
          isAnimationActive
          animationDuration={600}
          onClick={(d) => onSelect?.(d?.payload ?? d)}
          cursor={onSelect ? 'pointer' : undefined}
        >
          {points.map((p) => (
            <Cell
              key={`${p.article}-${p.name}`}
              fill={colorFor(p)}
              fillOpacity={0.6}
              stroke={colors.surface}
              strokeWidth={1}
            />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  )
}
