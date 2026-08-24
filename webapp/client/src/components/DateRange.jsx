import { Popover, FilterTrigger } from './Popover.jsx'
import { IconCheck } from './Icons.jsx'
import { fmtDate } from '../api.js'

const DAY = 86_400_000
const iso = (d) => new Date(d).toISOString().slice(0, 10)

/** Date-range slicer: presets plus an explicit from/to, as in the report. */
export function DateRange({ label = 'Date', from, to, min, max, today, onChange }) {
  const anchor = today || max || iso(Date.now())

  /**
   * Backward ranges end yesterday, not today.
   *
   * Today's actuals are still being written, so including it compares a full
   * day of forecast against a part day of sales and drags every figure down for
   * a reason that has nothing to do with the forecast. Forward ranges are the
   * opposite case — they are about what is still to come, and today is part of
   * that, so they start today.
   */
  const past = iso(new Date(anchor).getTime() - DAY)

  const presets = [
    { key: 'l7', label: 'Last 7 days', range: () => [iso(new Date(past).getTime() - 6 * DAY), past] },
    { key: 'l14', label: 'Last 14 days', range: () => [iso(new Date(past).getTime() - 13 * DAY), past] },
    { key: 'l30', label: 'Last 30 days', range: () => [iso(new Date(past).getTime() - 29 * DAY), past] },
    { key: 'mtd', label: 'Month to date', range: () => [`${past.slice(0, 7)}-01`, past] },
    // The day the prep plan is for, on its own — the question a kitchen asks
    // most mornings is about tomorrow and nothing else.
    {
      key: 'tmr',
      label: 'Tomorrow',
      range: () => {
        const t = iso(new Date(anchor).getTime() + DAY)
        return [t, t]
      },
    },
    { key: 'n7', label: 'Next 7 days', range: () => [anchor, iso(new Date(anchor).getTime() + 6 * DAY)] },
    { key: 'n30', label: 'Next 30 days', range: () => [anchor, iso(new Date(anchor).getTime() + 29 * DAY)] },
    { key: 'all', label: 'All dates', range: () => [min, max] },
  ]

  const clamp = (v) => {
    if (!v) return v
    if (min && v < min) return min
    if (max && v > max) return max
    return v
  }

  const apply = (f, t) => {
    let a = clamp(f)
    let b = clamp(t)
    if (a && b && a > b) [a, b] = [b, a] // keep the range the right way round
    onChange(a, b)
  }

  const activeKey = presets.find((p) => {
    const [f, t] = p.range()
    return f === from && t === to
  })?.key

  // Name the window when it matches a preset, so a rolling range does not read
  // as an arbitrary calendar span.
  const preset = presets.find((p) => p.key === activeKey)
  const summary = preset ? preset.label : from && to ? `${fmtDate(from)} – ${fmtDate(to)}` : 'All dates'


  return (
    <Popover
      align="right"
      trigger={({ open, toggle }) => (
        <FilterTrigger
          label={label}
          value={summary}
          open={open}
          toggle={toggle}
          active={Boolean(from || to)}
        />
      )}
      render={() => (
        <div className="dr">
          <div className="dr__presets">
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`dr__preset${activeKey === p.key ? ' dr__preset--on' : ''}`}
                onClick={() => {
                  const [f, t] = p.range()
                  apply(f, t)
                }}
              >
                {activeKey === p.key ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
                {p.label}
              </button>
            ))}
          </div>

          <div className="dr__fields">
            <label className="dr__field">
              <span>From</span>
              <input type="date" value={from || ''} min={min} max={max} onChange={(e) => apply(e.target.value, to)} />
            </label>
            <label className="dr__field">
              <span>To</span>
              <input type="date" value={to || ''} min={min} max={max} onChange={(e) => apply(from, e.target.value)} />
            </label>
            <p className="dr__note">
              Model covers {fmtDate(min)} – {fmtDate(max)}.
              {today ? ` Today is ${fmtDate(today)}, and past ranges stop at ${fmtDate(past)} — today has only part of its sales in.` : ''}
            </p>
          </div>
        </div>
      )}
    />
  )
}
