import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { IconClose, IconPlus, IconSearch } from './Icons.jsx'
import { InfoBanner } from './ui.jsx'

/**
 * The recipient list as a table you fill in.
 *
 * One line per branch — address, name, brand, branch, on or off — which is how
 * these lists already exist in the business: a spreadsheet with a store in one
 * column and a mailbox in the next. The card form asks for one recipient at a
 * time and is right for adding somebody; this is right for sitting down with a
 * list of eighty-six branches and typing them in.
 *
 * Brand and branch are dropdowns rather than free text, and the branch list is
 * whatever that brand's model actually reports. A branch cannot be misspelled
 * or filed under the wrong brand, which is the failure that matters here: it
 * produces a recipient that matches no rows and silently never receives
 * anything.
 *
 * Rows sharing an address are folded into one recipient on save, so an area
 * manager covering six branches is six lines here and one record underneath.
 */
export function RecipientTable({ recipients, reports, brands, departments = [], onClose, onSaved }) {
  const blank = () => ({ email: '', name: '', brand: '', branch: '', active: true, id: null })

  /*
   * Existing recipients arrive as one record per address holding a list of
   * branches; the table wants one line each, so they are unfolded here and
   * folded back on save.
   */
  const [rows, setRows] = useState(() => {
    const out = []
    for (const r of recipients ?? []) {
      const list = r.locations?.length ? r.locations : [null]
      for (const entry of list) {
        const text = String(entry ?? '')
        const at = text.indexOf(':')
        out.push({
          id: r.id,
          email: r.email,
          name: r.name ?? '',
          report: r.report,
          department: r.department ?? '',
          brand: at > 0 ? text.slice(0, at) : (r.brands?.[0] ?? ''),
          branch: at > 0 ? text.slice(at + 1) : text,
          active: r.active !== false,
        })
      }
    }
    out.sort((a, b) => a.brand.localeCompare(b.brand) || a.branch.localeCompare(b.branch))
    return out.length ? out : [blank()]
  })

  const [report, setReport] = useState(recipients?.[0]?.report ?? 'store_plan')
  const [department, setDepartment] = useState('')
  const [byBrand, setByBrand] = useState({})
  const [loading, setLoading] = useState([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  const meta = reports?.[report] ?? {}
  const needsLocation = Boolean(meta.needsLocation)

  /*
   * If the list arrives after this opened, seed from it — but only while the
   * table is still the single blank line nobody has typed into, so a late
   * response can never overwrite work in progress.
   */
  useEffect(() => {
    if (!recipients?.length) return
    setRows((current) => {
      const untouched = current.length === 1 && !current[0].email && !current[0].branch
      if (!untouched) return current
      const out = []
      for (const r of recipients) {
        const list = r.locations?.length ? r.locations : [null]
        for (const entry of list) {
          const text = String(entry ?? '')
          const at = text.indexOf(':')
          out.push({
            id: r.id,
            email: r.email,
            name: r.name ?? '',
            brand: at > 0 ? text.slice(0, at) : (r.brands?.[0] ?? ''),
            branch: at > 0 ? text.slice(at + 1) : text,
            active: r.active !== false,
          })
        }
      }
      out.sort((a, b) => a.brand.localeCompare(b.brand) || a.branch.localeCompare(b.branch))
      return out.length ? out : current
    })
  }, [recipients])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  /* Branch lists, one query per brand, shared by every row using that brand. */
  const wanted = useMemo(() => [...new Set(rows.map((r) => r.brand).filter(Boolean))], [rows])

  useEffect(() => {
    const missing = wanted.filter((code) => !byBrand[code])
    if (!missing.length) return
    let cancelled = false
    setLoading((prev) => [...new Set([...prev, ...missing])])
    Promise.all(
      missing.map((code) =>
        api
          .slicers({ brands: [code], need: ['locations'] })
          .then((r) => [code, (r.locations ?? []).map(String).sort()])
          .catch(() => [code, []])
      )
    ).then((pairs) => {
      if (cancelled) return
      setByBrand((prev) => ({ ...prev, ...Object.fromEntries(pairs) }))
      setLoading((prev) => prev.filter((c) => !missing.includes(c)))
    })
    return () => {
      cancelled = true
    }
  }, [wanted, byBrand])

  const setRow = (i, patch) =>
    setRows((list) => list.map((r, n) => (n === i ? { ...r, ...patch } : r)))

  const addRow = () =>
    setRows((list) => {
      const last = list[list.length - 1]
      // A new line inherits the brand above it, because a list is typed one
      // brand at a time and re-picking it on every row is the tedious part.
      return [...list, { ...blank(), brand: last?.brand ?? '' }]
    })

  const dropRow = (i) => setRows((list) => (list.length === 1 ? [blank()] : list.filter((_, n) => n !== i)))

  /** Pasting a column of addresses fills the rows below in one go. */
  const pasteInto = (i, text) => {
    const parts = String(text)
      .split(/[,;\n\r\t]+/)
      .map((v) => v.trim())
      .filter((v) => v.includes('@'))
    if (parts.length < 2) return false
    setRows((list) => {
      const next = [...list]
      const from = next[i]
      next[i] = { ...from, email: parts[0] }
      next.splice(i + 1, 0, ...parts.slice(1).map((email) => ({ ...blank(), email, brand: from.brand })))
      return next
    })
    return true
  }

  const problem = (r) => {
    if (!r.email && !r.branch && !r.name) return null // an untouched line is not an error
    if (!r.email.includes('@')) return 'needs an email address'
    if (!r.brand) return 'needs a brand'
    if (needsLocation && !r.branch) return 'needs a branch'
    const list = byBrand[r.brand]
    if (needsLocation && list?.length && !list.includes(r.branch)) return `${r.branch} is not a ${r.brand} branch`
    return null
  }

  const filled = rows.filter((r) => r.email.includes('@'))
  const broken = rows.filter((r) => problem(r))
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows.map((r, i) => ({ r, i }))
    return rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => `${r.email} ${r.name} ${r.brand} ${r.branch}`.toLowerCase().includes(q))
  }, [rows, query])

  async function save() {
    setBusy(true)
    setError(null)

    /* Fold the lines back into one record per address. */
    const byEmail = new Map()
    for (const r of filled) {
      if (problem(r)) continue
      const key = r.email.trim().toLowerCase()
      const entry = byEmail.get(key) ?? {
        id: r.id ?? null,
        email: r.email.trim(),
        name: r.name.trim(),
        brands: new Set(),
        locations: new Set(),
        active: r.active,
      }
      if (r.name.trim() && !entry.name) entry.name = r.name.trim()
      if (r.brand) entry.brands.add(r.brand)
      if (needsLocation && r.branch) entry.locations.add(`${r.brand}:${r.branch}`)
      entry.active = entry.active && r.active
      byEmail.set(key, entry)
    }

    let created = 0
    let updated = 0
    const failed = []
    for (const e of byEmail.values()) {
      const payload = {
        email: e.email,
        name: e.name,
        report,
        department: department || null,
        brands: [...e.brands],
        locations: [...e.locations],
        active: e.active,
      }
      try {
        if (e.id) {
          await api.admin.updateRecipient(e.id, payload)
          updated += 1
        } else {
          await api.admin.createRecipient(payload)
          created += 1
        }
      } catch (err) {
        failed.push(`${e.email} — ${err.message}`)
      }
    }

    if (!created && !updated) {
      setError(failed.join('; ') || 'Nothing to save — fill in at least one line.')
      setBusy(false)
      return
    }
    onSaved(
      `${created} added, ${updated} updated${failed.length ? `, ${failed.length} skipped: ${failed.join('; ')}` : ''}.`
    )
  }

  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal__card modal__card--wide" role="dialog" aria-modal="true" aria-label="Recipient list">
        <div className="modal__head">
          <div>
            <h2 className="modal__title">Recipient list</h2>
            <span className="modal__sub">One line per branch — fill it in like a spreadsheet</span>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} disabled={busy} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body">
          {error && <InfoBanner tone="warn">{error}</InfoBanner>}
          {note && <InfoBanner>{note}</InfoBanner>}

          <div className="rtable__bar">
            <label className="field rtable__pick">
              <span className="field__label">What everyone here receives</span>
              <select className="field__input" value={report} onChange={(e) => setReport(e.target.value)}>
                {Object.entries(reports ?? {}).map(([key, r]) => (
                  <option key={key} value={key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            {departments.length > 0 && (
              <label className="field rtable__pick">
                <span className="field__label">Department</span>
                <select
                  className="field__input"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                >
                  <option value="">—</option>
                  {departments.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="tsearch rtable__find">
              <IconSearch size={12} />
              <input
                value={query}
                placeholder="Find a row…"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Find a row"
              />
            </label>
          </div>

          <div className="rtable__wrap">
            <table className="rtable">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>#</th>
                  <th>Email address</th>
                  <th>Name</th>
                  <th style={{ width: 150 }}>Brand</th>
                  <th style={{ width: 120 }}>Branch</th>
                  <th style={{ width: 86 }}>Active</th>
                  <th style={{ width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {visible.map(({ r, i }) => {
                  const wrong = problem(r)
                  const list = byBrand[r.brand] ?? []
                  return (
                    <tr key={i} className={wrong ? 'rtable__row--bad' : undefined}>
                      <td className="rtable__n">{i + 1}</td>
                      <td>
                        <input
                          className="rtable__in"
                          type="email"
                          value={r.email}
                          placeholder="branch@swishhh.net"
                          onChange={(e) => setRow(i, { email: e.target.value })}
                          onPaste={(e) => {
                            if (pasteInto(i, e.clipboardData.getData('text'))) e.preventDefault()
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="rtable__in"
                          value={r.name}
                          placeholder="Optional"
                          onChange={(e) => setRow(i, { name: e.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          className="rtable__in"
                          value={r.brand}
                          onChange={(e) => setRow(i, { brand: e.target.value, branch: '' })}
                        >
                          <option value="">—</option>
                          {(brands ?? []).map((b) => (
                            <option key={b.code} value={b.code}>
                              {b.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          className="rtable__in"
                          value={r.branch}
                          disabled={!r.brand || !needsLocation}
                          onChange={(e) => setRow(i, { branch: e.target.value })}
                        >
                          <option value="">
                            {!r.brand ? '—' : loading.includes(r.brand) ? 'loading…' : '—'}
                          </option>
                          {list.map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                          {/* A code saved before, no longer in the model, stays
                              visible rather than silently resetting to blank. */}
                          {r.branch && !list.includes(r.branch) && (
                            <option value={r.branch}>{r.branch}</option>
                          )}
                        </select>
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`choice choice--tiny${r.active ? ' choice--on' : ''}`}
                          onClick={() => setRow(i, { active: !r.active })}
                        >
                          {r.active ? 'On' : 'Paused'}
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--icon"
                          onClick={() => dropRow(i)}
                          title="Remove this line"
                          aria-label="Remove this line"
                        >
                          <IconClose size={11} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <button type="button" className="btn people__add" onClick={addRow}>
            <IconPlus size={12} />
            Add a line
          </button>

          <span className="field__help">
            {broken.length
              ? `${broken.length} line${broken.length === 1 ? ' needs' : 's need'} attention — ${problem(broken[0])}. Outlined below, and skipped when saving.`
              : 'Lines sharing an address become one recipient covering all of its branches. Paste a column of addresses into the email box to fill several lines at once.'}
          </span>
        </div>

        <div className="modal__foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || filled.length === broken.length}
            onClick={save}
          >
            {busy ? 'Saving…' : `Save ${filled.length - broken.length} recipient${filled.length - broken.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
