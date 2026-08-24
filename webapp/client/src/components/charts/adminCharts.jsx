import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useChartTheme } from './useChartTheme.js'
import { fmtInt, fmtDate, fmtLongDate } from '../../api.js'
import { Legend } from '../ui.jsx'

/**
 * Charts for the admin panel. Same tokens, same axis treatment and the same
 * tooltip shell as the dashboard — an admin should not feel like they walked
 * into a different product.
 */

const AXIS = { fontSize: 11, fontFamily: 'Inter, sans-serif' }

/** Same tooltip shell as the dashboard charts: swatch, name, value. */
function Tip({ active, payload, label, title, rows }) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div className="tt">
      <div className="tt__title">{title ? title(label, point) : label}</div>
      {rows(point).map(([name, value, color]) => (
        <div className="tt__row" key={name}>
          {color ? (
            <span className="legend__swatch" style={{ background: color }} />
          ) : (
            <span className="legend__swatch" style={{ background: 'transparent' }} />
          )}
          <span className="tt__name">{name}</span>
          <span className="tt__val">{value}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Daily sign-ins with failed attempts overlaid.
 *
 * Both series are counts of attempts, so they share one axis — no second scale.
 * Bars are people who got in; the line is attempts that did not, which is the
 * shape you want to notice when someone is locked out or being probed.
 */
export function LoginActivityChart({ daily, failures, height = 220 }) {
  const colors = useChartTheme()

  const byDay = new Map(daily.map((d) => [d.day, { ...d, failures: 0 }]))
  for (const f of failures ?? []) {
    const row = byDay.get(f.day)
    if (row) row.failures = f.failures
    else byDay.set(f.day, { day: f.day, users: 0, logins: 0, failures: f.failures })
  }
  const data = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
  const anyFailures = data.some((d) => d.failures > 0)

  return (
    <>
      <Legend
        items={[
          { label: 'Users signed in', color: colors.forecast, bar: true },
          ...(anyFailures ? [{ label: 'Failed attempts', color: colors.amber }] : []),
        ]}
      />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="30%">
          <CartesianGrid stroke={colors.grid} vertical={false} syncWithTicks />
          <XAxis
            dataKey="day"
            tick={{ fill: colors.muted, ...AXIS }}
            tickLine={false}
            axisLine={false}
            dy={4}
            minTickGap={24}
            tickFormatter={fmtDate}
          />
          <YAxis
            tick={{ fill: colors.muted, ...AXIS, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={36}
            allowDecimals={false}
            tickCount={4}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
            content={
              <Tip
                title={(day) => fmtLongDate(day)}
                rows={(p) => [
                  ['Users signed in', fmtInt(p.users), colors.forecast],
                  ['Sign-ins', fmtInt(p.logins)],
                  ...(p.failures > 0 ? [['Failed attempts', fmtInt(p.failures), colors.amber]] : []),
                ]}
              />
            }
          />
          <Bar
            dataKey="users"
            name="Users signed in"
            fill={colors.forecast}
            radius={[4, 4, 0, 0]}
            maxBarSize={44}
            isAnimationActive
            animationDuration={520}
          />
          {anyFailures && (
            <Line
              type="monotone"
              dataKey="failures"
              name="Failed attempts"
              stroke={colors.amber}
              strokeWidth={2}
              dot={data.length === 1 ? { r: 3, fill: colors.amber, strokeWidth: 0 } : false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: colors.surface }}
              isAnimationActive
              animationDuration={520}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </>
  )
}

/** A one-line count drawn just past the end of its bar. */
function CountLabel({ x, y, width, height, value, fill }) {
  if (value === undefined || value === null) return null
  return (
    <text
      x={Number(x) + Number(width) + 8}
      y={Number(y) + Number(height) / 2}
      dominantBaseline="central"
      fill={fill}
      fontSize={11}
      fontFamily="Inter, sans-serif"
    >
      {`${fmtInt(value)} account${Number(value) === 1 ? '' : 's'}`}
    </text>
  )
}

/**
 * Sign-ins per group, with the number of accounts written at the end of the bar.
 *
 * The bar deliberately encodes sign-ins rather than accounts: account counts are
 * near-constant across roles, so bars drawn from them would all be the same
 * length and say nothing. Usage is the thing that varies, and the label carries
 * the headcount it should be read against.
 *
 * Used for role, brand and store: the shape of the question is identical, and
 * three near-identical charts would be three places to fix a bug.
 */
export function UsageBarChart({ data, labelKey = 'label', height = 220, width = 92 }) {
  const colors = useChartTheme()
  const rows = data.map((d) => ({ ...d, label: String(d[labelKey] ?? '') }))
  // A little headroom, so a bar never runs into its own label.
  const max = Math.max(1, ...rows.map((r) => r.logins)) * 1.08

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={rows}
        layout="vertical"
        // Right margin has to clear the longest label, or Recharts wraps it.
        margin={{ top: 4, right: 108, bottom: 4, left: 0 }}
        barCategoryGap="28%"
      >
        {/* No grid: every bar is directly labelled, so rules would be pure ink. */}
        <XAxis type="number" domain={[0, max]} hide allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="label"
          tick={{ fill: colors.muted, ...AXIS }}
          tickLine={false}
          axisLine={false}
          width={width}
        />
        <Tooltip
          cursor={{ fill: 'rgba(0,0,0,0.04)' }}
          content={
            <Tip
              rows={(p) => [
                ['Sign-ins in window', fmtInt(p.logins), colors.bar1],
                ['Accounts', fmtInt(p.users)],
              ]}
            />
          }
        />
        <Bar
          dataKey="logins"
          fill={colors.bar1}
          radius={[0, 4, 4, 0]}
          isAnimationActive
          animationDuration={520}
        >
          {/* The bar length is sign-ins; the label supplies the denominator.
              Drawn by hand rather than with Recharts' formatter, because that
              one derives its wrap width from the bar and breaks short bars'
              labels onto two lines. */}
          <LabelList dataKey="users" content={(props) => <CountLabel {...props} fill={colors.plain} />} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
