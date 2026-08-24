import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { IconClose, IconCheck, IconSearch } from './Icons.jsx'
import { InfoBanner, Pill } from './ui.jsx'

/**
 * Create or edit one account.
 *
 * Kept as its own component because it is the only place in the app that
 * *writes* anything, and because scope assignment has real teeth: what an admin
 * ticks here is what the server will let that person query. Locations are read
 * live from the model rather than a stored list, so a new store shows up here
 * the moment it appears in Power BI.
 */

const ROLE_HELP = {
  admin: 'Sees every brand and location, and can manage users.',
  stakeholder: 'Read-only across the brands you grant. Intended for head office.',
  store: 'Read-only, normally locked to one brand and its own locations.',
  viewer:
    'View only. Sees the brands and stores you grant, and is never added to the daily emails — for someone in a department who just needs to look.',
}

const STATUS_HELP = {
  active: 'Can sign in now.',
  pending: 'Cannot sign in until you make them active.',
  suspended: 'Blocked, and any open session ends immediately.',
  disabled: 'Blocked. Use for people who have left.',
}

export function UserEditor({ mode, user, roles, statuses, departments = [], brands, currentUserId, onClose, onSaved }) {
  const creating = mode === 'create'

  const [email, setEmail] = useState(user?.email ?? '')
  const [name, setName] = useState(user?.name ?? '')
  const [role, setRole] = useState(user?.role ?? 'store')
  const [status, setStatus] = useState(user?.status ?? 'active')
  const [department, setDepartment] = useState(user?.department ?? '')
  const [brandCodes, setBrandCodes] = useState(
    () => new Set((user?.scopes ?? []).map((s) => s.brand).filter(Boolean))
  )
  const [locations, setLocations] = useState(
    () => new Set((user?.scopes ?? []).map((s) => s.location).filter(Boolean))
  )

  const [available, setAvailable] = useState([])
  const [loadingLocations, setLoadingLocations] = useState(false)
  const [locationQuery, setLocationQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [issued, setIssued] = useState(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [pwValue, setPwValue] = useState('')
  const dialog = useRef(null)

  // Admins are all-access by definition, so a scope picker would be a lie.
  const scoped = role !== 'admin'

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    dialog.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // Locations for whichever brands are ticked, straight from the model.
  useEffect(() => {
    if (!scoped || brandCodes.size === 0) {
      setAvailable([])
      return
    }
    let cancelled = false
    setLoadingLocations(true)
    Promise.all(
      [...brandCodes].map((code) =>
        api
          .slicers({ brand: code })
          .then((r) => (r.locations ?? []).map((l) => ({ brand: code, location: String(l) })))
          .catch(() => [])
      )
    )
      .then((lists) => {
        if (cancelled) return
        const seen = new Set()
        const flat = []
        for (const row of lists.flat()) {
          if (seen.has(row.location)) continue
          seen.add(row.location)
          flat.push(row)
        }
        setAvailable(flat.sort((a, b) => a.location.localeCompare(b.location)))
      })
      .finally(() => !cancelled && setLoadingLocations(false))
    return () => {
      cancelled = true
    }
  }, [brandCodes, scoped])

  const visibleLocations = useMemo(() => {
    const q = locationQuery.trim().toLowerCase()
    if (!q) return available
    return available.filter((r) => r.location.toLowerCase().includes(q))
  }, [available, locationQuery])

  const toggle = (set, value, apply) => {
    const next = new Set(set)
    next.has(value) ? next.delete(value) : next.add(value)
    apply(next)
  }

  // Locations that belong to a brand no longer ticked would be dead rows.
  useEffect(() => {
    if (!available.length) return
    const valid = new Set(available.map((r) => r.location))
    setLocations((prev) => {
      const next = new Set([...prev].filter((l) => valid.has(l)))
      return next.size === prev.size ? prev : next
    })
  }, [available])

  const scopes = useMemo(() => {
    if (!scoped) return []
    const rows = [...brandCodes].map((brand) => ({ brand, location: null }))
    const byBrand = new Map(available.map((r) => [r.location, r.brand]))
    for (const location of locations) {
      rows.push({ brand: byBrand.get(location) ?? [...brandCodes][0] ?? null, location })
    }
    return rows
  }, [scoped, brandCodes, locations, available])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      if (creating) {
        const res = await api.admin.createUser({ email, name, role, status, department: department || null, scopes })
        // Shown once and never recoverable — the admin has to pass it on now.
        setIssued({ email: res.user.email, password: res.password, verb: 'created' })
      } else {
        await api.admin.updateUser(user.id, { name, role, status, department: department || null, scopes })
        onSaved(`Saved changes to ${user.email}.`)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function resetPassword(chosen) {
    setBusy(true)
    setError(null)
    try {
      const res = await api.admin.resetPassword(user.id, chosen || undefined)
      if (res.password) {
        setIssued({ email: user.email, password: res.password, verb: 'reset' })
      } else {
        // They typed it, so there is nothing to reveal back to them.
        onSaved(
          isSelf
            ? 'Your password has been changed. Other devices signed in as you were signed out.'
            : `Password changed for ${user.email}.`
        )
      }
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${user.email}? Their sign-in history is removed too.`)) return
    setBusy(true)
    setError(null)
    try {
      await api.admin.deleteUser(user.id)
      onSaved(`Deleted ${user.email}.`)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const canSave = creating ? email.includes('@') : true
  // Deleting the account you are signed in as is refused by the server; not
  // offering the button is kinder than explaining the refusal.
  const isSelf = !creating && user?.id === currentUserId

  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        className="modal__card"
        role="dialog"
        aria-modal="true"
        aria-label={creating ? 'Add user' : `Edit ${user?.email}`}
        tabIndex={-1}
        ref={dialog}
      >
        <div className="modal__head">
          <div>
            <h2 className="modal__title">{creating ? 'Add user' : name || user?.email}</h2>
            {!creating && <span className="modal__sub">{user?.email}</span>}
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body">
          {issued ? (
            <>
              <InfoBanner tone="warn">
                <strong>Copy this password now.</strong> It is shown once and cannot be retrieved
                afterwards — if it is lost, reset it and issue a new one.
              </InfoBanner>
              <div className="issued">
                <span className="issued__label">{issued.email}</span>
                <code className="issued__value">{issued.password}</code>
                <button
                  type="button"
                  className="btn"
                  onClick={() => navigator.clipboard?.writeText(issued.password)}
                >
                  Copy
                </button>
              </div>
            </>
          ) : (
            <>
              {error && <InfoBanner tone="warn">{error}</InfoBanner>}

              <div className="form2">
                <label className="field">
                  <span className="field__label">Email</span>
                  <input
                    className="field__input"
                    type="email"
                    value={email}
                    disabled={!creating}
                    autoComplete="off"
                    placeholder="name@swishhh.net"
                    onChange={(e) => setEmail(e.target.value)}
                  />
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

              <div className="form2">
                <div className="field">
                  <span className="field__label">Role</span>
                  <div className="choices">
                    {roles.map((r) => (
                      <button
                        key={r}
                        type="button"
                        className={`choice${role === r ? ' choice--on' : ''}`}
                        onClick={() => setRole(r)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <span className="field__help">{ROLE_HELP[role]}</span>
                </div>

                <div className="field">
                  <span className="field__label">Status</span>
                  <div className="choices">
                    {statuses.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`choice${status === s ? ' choice--on' : ''}`}
                        onClick={() => setStatus(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <span className="field__help">{STATUS_HELP[status]}</span>
                </div>
              </div>

              {departments.length > 0 && (
                <div className="field">
                  <span className="field__label">Department</span>
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
                    Which part of the business they sit in. Separate from role — role decides what
                    they may see; this is who they are, and the usage figures group on it.
                  </span>
                </div>
              )}

              <div className="field">
                <span className="field__label">Brands</span>
                {scoped ? (
                  <>
                    <div className="choices choices--wrap">
                      {brands.map((b) => (
                        <button
                          key={b.code}
                          type="button"
                          className={`choice${brandCodes.has(b.code) ? ' choice--on' : ''}`}
                          onClick={() => toggle(brandCodes, b.code, setBrandCodes)}
                        >
                          {brandCodes.has(b.code) && <IconCheck size={11} />}
                          {b.label}
                        </button>
                      ))}
                    </div>
                    <span className="field__help">
                      {brandCodes.size === 0
                        ? 'Nothing selected — this account will see no data at all.'
                        : `Sees ${brandCodes.size} of ${brands.length} brands.`}
                    </span>
                  </>
                ) : (
                  <span className="field__help">Admins see every brand. Nothing to choose.</span>
                )}
              </div>

              {pwOpen && !creating && (
                <div className="field">
                  <span className="field__label">
                    {isSelf ? 'New password' : `New password for ${user.email}`}
                  </span>
                  <div className="pwrow">
                    <input
                      className="field__input"
                      type="text"
                      value={pwValue}
                      autoComplete="new-password"
                      placeholder="At least 12 characters"
                      onChange={(e) => setPwValue(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy || pwValue.length < 12}
                      onClick={() => resetPassword(pwValue)}
                    >
                      Set
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => resetPassword(null)}>
                      Generate one
                    </button>
                  </div>
                  <span className="field__help">
                    {isSelf
                      ? 'Your current tab stays signed in; any other device signed in as you is signed out.'
                      : 'Signs this person out everywhere. Generating gives you a password to hand over once.'}
                  </span>
                </div>
              )}

              {scoped && brandCodes.size > 0 && (
                <div className="field">
                  <span className="field__label">
                    Locations
                    {locations.size > 0 && (
                      <button type="button" className="pop__link" onClick={() => setLocations(new Set())}>
                        Clear
                      </button>
                    )}
                  </span>

                  {available.length > 12 && (
                    <div className="pop__search">
                      <IconSearch size={13} />
                      <input
                        value={locationQuery}
                        placeholder="Find a location…"
                        onChange={(e) => setLocationQuery(e.target.value)}
                      />
                    </div>
                  )}

                  <div className="checks">
                    {loadingLocations ? (
                      <span className="field__help">Reading locations from Power BI…</span>
                    ) : visibleLocations.length === 0 ? (
                      <span className="field__help">
                        {available.length === 0
                          ? 'Could not read locations for this brand right now.'
                          : 'No location matches that search.'}
                      </span>
                    ) : (
                      visibleLocations.map((row) => (
                        <button
                          key={row.location}
                          type="button"
                          className={`check${locations.has(row.location) ? ' check--on' : ''}`}
                          onClick={() => toggle(locations, row.location, setLocations)}
                        >
                          <span className="check__box">
                            {locations.has(row.location) && <IconCheck size={10} />}
                          </span>
                          <span className="check__label">{row.location}</span>
                          {brandCodes.size > 1 && <Pill tone="slate">{row.brand}</Pill>}
                        </button>
                      ))
                    )}
                  </div>

                  <span className="field__help">
                    {locations.size === 0
                      ? 'None ticked means every location in the brands above.'
                      : `Limited to ${locations.size} location${locations.size === 1 ? '' : 's'}.`}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal__foot">
          {issued ? (
            <button type="button" className="btn btn--primary" onClick={() => onSaved(null)}>
              Done
            </button>
          ) : (
            <>
              {!creating && (
                <div className="modal__foot-left">
                  <button type="button" className="btn" disabled={busy} onClick={() => setPwOpen((v) => !v)}>
                    {isSelf ? 'Change my password' : 'Reset password'}
                  </button>
                  {!isSelf && (
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={remove}>
                      Delete
                    </button>
                  )}
                </div>
              )}
              <button type="button" className="btn" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" disabled={busy || !canSave} onClick={save}>
                {busy ? 'Saving…' : creating ? 'Create account' : 'Save changes'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
