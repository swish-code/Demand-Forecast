import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { IconClose, IconCheck, IconSearch } from './Icons.jsx'
import { InfoBanner } from './ui.jsx'

/**
 * Who receives a report, and what they receive.
 *
 * Deliberately not tied to a user account. The people who need a branch's prep
 * list at seven in the morning are not always the people with a dashboard
 * login — a kitchen's shared mailbox or an area manager's address is a
 * perfectly good recipient, and requiring an account for each would mean
 * creating logins nobody uses.
 */
export function RecipientEditor({ mode, recipient, reports, brands, departments = [], onClose, onSaved }) {
  const creating = mode === 'create'

  const [email, setEmail] = useState(recipient?.email ?? '')
  const [name, setName] = useState(recipient?.name ?? '')
  const [report, setReport] = useState(recipient?.report ?? 'store_plan')
  const [brandCodes, setBrandCodes] = useState(() => new Set(recipient?.brands ?? []))
  // Branches are held as BBT:ADL. A recipient saved before brands were kept
  // apart has bare codes, which are matched against every brand below.
  const [locations, setLocations] = useState(() => new Set(recipient?.locations ?? []))
  const [active, setActive] = useState(recipient?.active ?? true)
  const [department, setDepartment] = useState(recipient?.department ?? '')

  const [available, setAvailable] = useState([])
  const [loadingLocations, setLoadingLocations] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const meta = reports?.[report] ?? {}
  const needsLocation = Boolean(meta.needsLocation)
  // The digest is the whole group by definition, so a brand choice would be a
  // control that does nothing.
  const usesBrands = report !== 'daily_digest'

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  useEffect(() => {
    if (!needsLocation || brandCodes.size === 0) {
      setAvailable([])
      return
    }
    let cancelled = false
    setLoadingLocations(true)
    Promise.all(
      [...brandCodes].map((code) =>
        api
          .slicers({ brands: [code], need: ['locations'] })
          .then((r) => (r.locations ?? []).map((l) => ({ brand: code, location: String(l) })))
          .catch(() => [])
      )
    )
      .then((lists) => {
        if (cancelled) return
        /*
         * Every brand keeps its own branches.
         *
         * These used to be folded into one list keyed on the branch code, which
         * hid the fact that ADL is a BBT store *and* a Shawarma Shakir store —
         * two different kitchens, two different prep lists. Kept apart, the form
         * can show them under the brand they belong to and send only the one
         * that was actually asked for.
         */
        const seen = new Set()
        const flat = []
        for (const row of lists.flat()) {
          const key = `${row.brand}:${row.location}`
          if (seen.has(key)) continue
          seen.add(key)
          flat.push({ ...row, key })
        }
        setAvailable(flat.sort((a, b) => a.location.localeCompare(b.location)))
      })
      .finally(() => !cancelled && setLoadingLocations(false))
    return () => {
      cancelled = true
    }
  }, [brandCodes, needsLocation])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? available.filter((r) => r.location.toLowerCase().includes(q)) : available
  }, [available, query])

  /** The branches on screen, under the brand each one belongs to. */
  const grouped = useMemo(() => {
    const byBrand = new Map()
    for (const row of visible) {
      if (!byBrand.has(row.brand)) byBrand.set(row.brand, [])
      byBrand.get(row.brand).push(row)
    }
    return [...byBrand.entries()].map(([code, rows]) => ({
      code,
      label: brands?.find((b) => b.code === code)?.label ?? code,
      rows,
    }))
  }, [visible, brands])

  // A bare "ADL" from before still means ADL in every brand, so it stays ticked.
  const picked = (row) => locations.has(row.key) || locations.has(row.location)

  const toggleBranch = (row) => {
    const next = new Set(locations)
    if (next.has(row.key)) next.delete(row.key)
    else if (next.has(row.location)) {
      // Splitting an old bare entry: keep it for the other brands that had it,
      // as this one is being switched off.
      next.delete(row.location)
      for (const other of available) {
        if (other.location === row.location && other.key !== row.key) next.add(other.key)
      }
    } else next.add(row.key)
    setLocations(next)
  }

  const chosenCount = available.filter(picked).length

  /*
   * Dropping a brand drops its branches with it. Leaving them behind meant a
   * recipient could keep BBT:ADL after BBT had been unticked — invisible in the
   * form, and still sent every morning.
   */
  const toggleBrand = (code) => {
    const next = new Set(brandCodes)
    if (next.has(code)) {
      next.delete(code)
      const kept = new Set([...locations].filter((l) => !String(l).startsWith(`${code}:`)))
      if (kept.size !== locations.size) setLocations(kept)
    } else next.add(code)
    setBrandCodes(next)
  }

  const toggle = (set, value, apply) => {
    const next = new Set(set)
    next.has(value) ? next.delete(value) : next.add(value)
    apply(next)
  }

  async function save() {
    setBusy(true)
    setError(null)
    const payload = {
      email,
      name,
      report,
      department: department || null,
      brands: usesBrands ? [...brandCodes] : [],
      locations: needsLocation ? [...locations] : [],
      active,
    }
    try {
      if (creating) await api.admin.createRecipient(payload)
      else await api.admin.updateRecipient(recipient.id, payload)
      onSaved(creating ? `${email} will now receive ${meta.label ?? report}.` : `Saved ${email}.`)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`Stop sending to ${recipient.email}?`)) return
    setBusy(true)
    try {
      await api.admin.deleteRecipient(recipient.id)
      onSaved(`${recipient.email} removed.`)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const canSave = email.includes('@') && (!needsLocation || chosenCount > 0)

  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal__card" role="dialog" aria-modal="true" aria-label={creating ? 'Add recipient' : 'Edit recipient'}>
        <div className="modal__head">
          <div>
            <h2 className="modal__title">{creating ? 'Add a recipient' : email}</h2>
            <span className="modal__sub">Choose what this address receives each morning</span>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body">
          {error && <InfoBanner tone="warn">{error}</InfoBanner>}

          <div className="form2">
            <label className="field">
              <span className="field__label">Email</span>
              <input
                className="field__input"
                type="email"
                value={email}
                disabled={!creating}
                placeholder="name@swishhh.net"
                onChange={(e) => setEmail(e.target.value)}
              />
              <span className="field__help">
                Does not need a dashboard account — a distribution list works.
              </span>
            </label>
            <label className="field">
              <span className="field__label">Name</span>
              <input
                className="field__input"
                value={name}
                placeholder="Optional"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          </div>

          <div className="field">
            <span className="field__label">What to send</span>
            <div className="choices choices--wrap">
              {Object.entries(reports ?? {}).map(([key, r]) => (
                <button
                  key={key}
                  type="button"
                  className={`choice${report === key ? ' choice--on' : ''}`}
                  onClick={() => setReport(key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <span className="field__help">{meta.detail}</span>
          </div>

          {departments.length > 0 && (
            <div className="field">
              <span className="field__label">Who it goes to</span>
              <div className="choices choices--wrap">
                {departments.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`choice${department === d ? ' choice--on' : ''}`}
                    onClick={() => setDepartment(department === d ? '' : d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <span className="field__help">
                Which part of the business this address belongs to. It does not change what is sent —
                it is so a list of forty recipients can be read at a glance.
              </span>
            </div>
          )}

          {usesBrands && (
            <div className="field">
              <span className="field__label">Brands</span>
              <div className="choices choices--wrap">
                {(brands ?? []).map((b) => (
                  <button
                    key={b.code}
                    type="button"
                    className={`choice${brandCodes.has(b.code) ? ' choice--on' : ''}`}
                    onClick={() => toggleBrand(b.code)}
                  >
                    {brandCodes.has(b.code) && <IconCheck size={11} />}
                    {b.label}
                  </button>
                ))}
              </div>
              <span className="field__help">
                {brandCodes.size === 0
                  ? 'None chosen means every brand.'
                  : `${brandCodes.size} of ${brands?.length ?? 0} brands.`}
              </span>
            </div>
          )}

          {needsLocation && brandCodes.size > 0 && (
            <div className="field">
              <span className="field__label">
                Stores
                {chosenCount > 0 && (
                  <button type="button" className="pop__link" onClick={() => setLocations(new Set())}>
                    Clear
                  </button>
                )}
              </span>
              {available.length > 12 && (
                <div className="pop__search">
                  <IconSearch size={13} />
                  <input value={query} placeholder="Find a store…" onChange={(e) => setQuery(e.target.value)} />
                </div>
              )}
              {loadingLocations ? (
                <span className="field__help">Reading stores from Power BI…</span>
              ) : grouped.length === 0 ? (
                <span className="field__help">No store matches.</span>
              ) : (
                grouped.map((group) => {
                  const chosen = group.rows.filter(picked)
                  return (
                    <div className="brandstores" key={group.code}>
                      <div className="brandstores__head">
                        <span className="brandstores__name">{group.label}</span>
                        <span className="brandstores__count">
                          {chosen.length} of {group.rows.length}
                        </span>
                        <button
                          type="button"
                          className="pop__link"
                          onClick={() => {
                            const next = new Set(locations)
                            const all = chosen.length === group.rows.length
                            for (const row of group.rows) {
                              next.delete(row.key)
                              next.delete(row.location)
                              if (!all) next.add(row.key)
                            }
                            setLocations(next)
                          }}
                        >
                          {chosen.length === group.rows.length ? 'None' : 'All'}
                        </button>
                      </div>
                      <div className="checks">
                        {group.rows.map((row) => (
                          <button
                            key={row.key}
                            type="button"
                            className={`check${picked(row) ? ' check--on' : ''}`}
                            onClick={() => toggleBranch(row)}
                          >
                            <span className="check__box">{picked(row) && <IconCheck size={10} />}</span>
                            <span className="check__label">{row.location}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })
              )}
              <span className="field__help">
                {chosenCount === 0
                  ? 'A prep list needs at least one store — nothing is sent without one.'
                  : `One email per store, ${chosenCount} in total.`}
              </span>
            </div>
          )}

          <div className="field">
            <span className="field__label">Sending</span>
            <div className="choices">
              <button
                type="button"
                className={`choice${active ? ' choice--on' : ''}`}
                onClick={() => setActive(true)}
              >
                On
              </button>
              <button
                type="button"
                className={`choice${!active ? ' choice--on' : ''}`}
                onClick={() => setActive(false)}
              >
                Paused
              </button>
            </div>
            <span className="field__help">
              Pausing keeps the setup but stops the mail — for somebody on leave.
            </span>
          </div>
        </div>

        <div className="modal__foot">
          {!creating && (
            <div className="modal__foot-left">
              <button type="button" className="btn btn--danger" disabled={busy} onClick={remove}>
                Remove
              </button>
            </div>
          )}
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={busy || !canSave} onClick={save}>
            {busy ? 'Saving…' : creating ? 'Add recipient' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
