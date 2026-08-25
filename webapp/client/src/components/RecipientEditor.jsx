import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { IconClose, IconCheck, IconSearch, IconPlus, IconChevron } from './Icons.jsx'
import { InfoBanner } from './ui.jsx'

/**
 * Who receives a report, and what they receive.
 *
 * Deliberately not tied to a user account. The people who need a branch's prep
 * list at seven in the morning are not always the people with a dashboard
 * login — a kitchen's shared mailbox or an area manager's address is a
 * perfectly good recipient, and requiring an account for each would mean
 * creating logins nobody uses.
 *
 * Several addresses can be added at once, and each one carries its own brands
 * and branches. A shared scope was the obvious way to build this and the wrong
 * one: the list being typed in is usually one branch's mailbox, then another
 * branch's, then an area manager covering six — three different scopes, and
 * one form. The report itself stays shared, because that is what the form is
 * for: adding people to a report.
 */
export function RecipientEditor({ mode, recipient, reports, brands, departments = [], onClose, onSaved }) {
  const creating = mode === 'create'

  const blank = () => ({ email: '', name: '', brands: [], locations: [], open: true })

  const [people, setPeople] = useState(() => [
    {
      email: recipient?.email ?? '',
      name: recipient?.name ?? '',
      brands: recipient?.brands ?? [],
      locations: recipient?.locations ?? [],
      open: true,
    },
  ])

  const [report, setReport] = useState(recipient?.report ?? 'store_plan')
  const [department, setDepartment] = useState(recipient?.department ?? '')
  const [active, setActive] = useState(recipient?.active ?? true)

  const [byBrand, setByBrand] = useState({})
  const [loadingBrands, setLoadingBrands] = useState([])
  const [query, setQuery] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const meta = reports?.[report] ?? {}
  const needsLocation = Boolean(meta.needsLocation)
  // The digest is the whole group by definition, so a brand choice would be a
  // control that does nothing.
  const usesBrands = report !== 'daily_digest'

  const setPerson = (i, patch) =>
    setPeople((list) => list.map((p, n) => (n === i ? { ...p, ...patch } : p)))
  const addPerson = () => setPeople((list) => [...list.map((p) => ({ ...p, open: false })), blank()])
  const dropPerson = (i) =>
    setPeople((list) => (list.length === 1 ? list : list.filter((_, n) => n !== i)))

  /**
   * A pasted list becomes rows.
   *
   * People arrive with addresses separated by commas, semicolons or newlines,
   * out of Outlook or a spreadsheet column. Splitting them here saves retyping
   * a list somebody already has. The rows inherit the scope of the one pasted
   * into, which is right far more often than an empty scope would be.
   */
  const pasteInto = (i, text) => {
    const parts = String(text)
      .split(/[,;\n\r\t]+/)
      .map((v) => v.trim())
      .filter((v) => v.includes('@'))
    if (parts.length < 2) return false
    setPeople((list) => {
      const next = [...list]
      const from = next[i]
      next[i] = { ...from, email: parts[0] }
      next.splice(
        i + 1,
        0,
        ...parts.slice(1).map((email) => ({
          email,
          name: '',
          brands: [...from.brands],
          locations: [...from.locations],
          open: false,
        }))
      )
      return next
    })
    return true
  }

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  /*
   * Branch lists are fetched per brand and shared by every row.
   *
   * Three people covering BBT is one query, not three. Each list is its own DAX
   * query against that brand's model, so the saving is real.
   */
  const wantedBrands = useMemo(
    () => [...new Set(people.flatMap((p) => p.brands))],
    [people]
  )

  useEffect(() => {
    if (!needsLocation) return
    const missing = wantedBrands.filter((code) => !byBrand[code])
    if (!missing.length) return

    let cancelled = false
    setLoadingBrands((prev) => [...new Set([...prev, ...missing])])
    Promise.all(
      missing.map((code) =>
        api
          .slicers({ brands: [code], need: ['locations'] })
          .then((r) => [code, (r.locations ?? []).map((l) => String(l)).sort()])
          .catch(() => [code, []])
      )
    ).then((pairs) => {
      if (cancelled) return
      setByBrand((prev) => ({ ...prev, ...Object.fromEntries(pairs) }))
      setLoadingBrands((prev) => prev.filter((c) => !missing.includes(c)))
    })
    return () => {
      cancelled = true
    }
  }, [wantedBrands, needsLocation, byBrand])

  /* ------------------------------------------------------- one person ---- */

  // A bare "ADL" is how branches were written before brands were kept apart,
  // and still means that branch in every brand the recipient covers.
  const has = (person, code, branch) =>
    person.locations.includes(`${code}:${branch}`) || person.locations.includes(branch)

  const toggleBranch = (i, code, branch) => {
    const person = people[i]
    const key = `${code}:${branch}`
    let next
    if (person.locations.includes(key)) next = person.locations.filter((l) => l !== key)
    else if (person.locations.includes(branch)) {
      // Splitting an old bare entry: it stays for the other brands that had it.
      next = person.locations.filter((l) => l !== branch)
      for (const other of person.brands) {
        if (other !== code && (byBrand[other] ?? []).includes(branch)) next.push(`${other}:${branch}`)
      }
    } else next = [...person.locations, key]
    setPerson(i, { locations: next })
  }

  /*
   * Dropping a brand drops its branches with it. Leaving them behind meant a
   * recipient could keep BBT:ADL after BBT had been unticked — invisible in the
   * form, and still sent every morning.
   */
  const toggleBrandFor = (i, code) => {
    const person = people[i]
    if (person.brands.includes(code)) {
      setPerson(i, {
        brands: person.brands.filter((c) => c !== code),
        locations: person.locations.filter((l) => !String(l).startsWith(`${code}:`)),
      })
    } else setPerson(i, { brands: [...person.brands, code] })
  }

  const branchesOf = (person) =>
    person.brands.map((code) => {
      const q = (query[`${person.email}|${code}`] ?? '').trim().toLowerCase()
      const all = byBrand[code] ?? []
      return {
        code,
        label: brands?.find((b) => b.code === code)?.label ?? code,
        all,
        rows: q ? all.filter((l) => l.toLowerCase().includes(q)) : all,
        chosen: all.filter((l) => has(person, code, l)),
      }
    })

  const countFor = (person) =>
    person.brands.reduce((n, code) => n + (byBrand[code] ?? []).filter((l) => has(person, code, l)).length, 0)

  /** What the collapsed row says it will send. */
  const summaryOf = (person) => {
    if (!usesBrands) return 'Every brand'
    if (!person.brands.length) return 'No brand chosen'
    if (!needsLocation) return person.brands.join(', ')
    const parts = branchesOf(person)
      .filter((g) => g.chosen.length)
      .map((g) => `${g.code} · ${g.chosen.join(', ')}`)
    return parts.length ? parts.join('   ') : 'No store chosen'
  }

  const ready = (person) =>
    person.email.includes('@') &&
    (!usesBrands || person.brands.length > 0 || !needsLocation) &&
    (!needsLocation || countFor(person) > 0)

  const valid = people.filter((p) => p.email.includes('@'))
  const complete = people.filter(ready)
  const canSave = complete.length > 0 && complete.length === valid.length

  /* ------------------------------------------------------------ saving --- */

  async function save() {
    setBusy(true)
    setError(null)

    const payloadFor = (person) => ({
      email: person.email.trim(),
      name: person.name.trim(),
      report,
      department: department || null,
      brands: usesBrands ? person.brands : [],
      locations: needsLocation ? person.locations : [],
      active,
    })

    if (!creating) {
      try {
        await api.admin.updateRecipient(recipient.id, payloadFor(people[0]))
        onSaved(`Saved ${recipient.email}.`)
      } catch (err) {
        setError(err.message)
        setBusy(false)
      }
      return
    }

    /*
     * One address at a time, and one failure does not lose the rest.
     *
     * An address already receiving this report comes back as a conflict from
     * the unique index — which is the right answer, not an error worth
     * abandoning the other nine for. So each is reported and the run carries on.
     */
    const added = []
    const failed = []
    for (const person of complete) {
      try {
        await api.admin.createRecipient(payloadFor(person))
        added.push(person.email.trim())
      } catch (err) {
        failed.push(`${person.email.trim()} — ${err.message}`)
      }
    }

    if (!added.length) {
      setError(failed.join('; ') || 'Nothing was added.')
      setBusy(false)
      return
    }

    const what = meta.label ?? report
    onSaved(
      added.length === 1
        ? `${added[0]} will now receive ${what}.${failed.length ? ` ${failed.length} skipped.` : ''}`
        : `${added.length} addresses will now receive ${what}.${
            failed.length ? ` ${failed.length} skipped: ${failed.join('; ')}` : ''
          }`
    )
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

  /* ------------------------------------------------------------- markup --- */

  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal__card" role="dialog" aria-modal="true" aria-label={creating ? 'Add recipients' : 'Edit recipient'}>
        <div className="modal__head">
          <div>
            <h2 className="modal__title">{creating ? 'Add recipients' : recipient.email}</h2>
            <span className="modal__sub">
              {creating
                ? 'Each address gets its own brands and branches'
                : 'Choose what this address receives each morning'}
            </span>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body">
          {error && <InfoBanner tone="warn">{error}</InfoBanner>}

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
            <span className="field__help">{meta.detail} Everyone below receives this report.</span>
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
                Which part of the business these addresses belong to. It does not change what is sent —
                it is so a list of forty recipients can be read at a glance.
              </span>
            </div>
          )}

          <div className="field">
            <span className="field__label">
              {creating ? 'Recipients' : 'Address'}
              {creating && people.length > 1 && (
                <span className="field__help"> {people.length} on this form</span>
              )}
            </span>

            {people.map((person, i) => {
              const groups = branchesOf(person)
              const count = countFor(person)
              return (
                <div className={`rcard${person.open ? ' rcard--open' : ''}`} key={i}>
                  <div className="rcard__top">
                    <input
                      className="field__input"
                      type="email"
                      value={person.email}
                      disabled={!creating}
                      placeholder="name@swishhh.net"
                      onChange={(e) => setPerson(i, { email: e.target.value })}
                      onPaste={(e) => {
                        const text = e.clipboardData.getData('text')
                        if (creating && pasteInto(i, text)) e.preventDefault()
                      }}
                    />
                    <input
                      className="field__input"
                      value={person.name}
                      placeholder="Name (optional)"
                      onChange={(e) => setPerson(i, { name: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn--icon"
                      onClick={() => setPerson(i, { open: !person.open })}
                      aria-expanded={person.open}
                      title={person.open ? 'Hide brands and stores' : 'Choose brands and stores'}
                    >
                      <IconChevron size={12} />
                    </button>
                    {creating && (
                      <button
                        type="button"
                        className="btn btn--icon"
                        onClick={() => dropPerson(i)}
                        disabled={people.length === 1}
                        title="Remove this address"
                        aria-label="Remove this address"
                      >
                        <IconClose size={12} />
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    className={`rcard__summary${ready(person) ? '' : ' rcard__summary--todo'}`}
                    onClick={() => setPerson(i, { open: !person.open })}
                  >
                    {summaryOf(person)}
                    {needsLocation && count > 0 && (
                      <span className="rcard__count">
                        {count} email{count === 1 ? '' : 's'} a day
                      </span>
                    )}
                  </button>

                  {person.open && usesBrands && (
                    <div className="rcard__scope">
                      <div className="choices choices--wrap">
                        {(brands ?? []).map((b) => (
                          <button
                            key={b.code}
                            type="button"
                            className={`choice${person.brands.includes(b.code) ? ' choice--on' : ''}`}
                            onClick={() => toggleBrandFor(i, b.code)}
                          >
                            {person.brands.includes(b.code) && <IconCheck size={11} />}
                            {b.label}
                          </button>
                        ))}
                      </div>

                      {i > 0 && (
                        <button
                          type="button"
                          className="pop__link rcard__copy"
                          onClick={() =>
                            setPerson(i, {
                              brands: [...people[0].brands],
                              locations: [...people[0].locations],
                            })
                          }
                        >
                          Same as the first address
                        </button>
                      )}

                      {needsLocation &&
                        groups.map((group) => (
                          <div className="brandstores" key={group.code}>
                            <div className="brandstores__head">
                              <span className="brandstores__name">{group.label}</span>
                              <span className="brandstores__count">
                                {group.chosen.length} of {group.all.length}
                              </span>
                              <button
                                type="button"
                                className="pop__link"
                                onClick={() => {
                                  const all = group.chosen.length === group.all.length
                                  const kept = person.locations.filter(
                                    (l) => !String(l).startsWith(`${group.code}:`) && !group.all.includes(l)
                                  )
                                  setPerson(i, {
                                    locations: all ? kept : [...kept, ...group.all.map((l) => `${group.code}:${l}`)],
                                  })
                                }}
                              >
                                {group.chosen.length === group.all.length ? 'None' : 'All'}
                              </button>
                            </div>

                            {group.all.length > 12 && (
                              <div className="pop__search">
                                <IconSearch size={13} />
                                <input
                                  value={query[`${person.email}|${group.code}`] ?? ''}
                                  placeholder={`Find a ${group.label} store…`}
                                  onChange={(e) =>
                                    setQuery((q) => ({ ...q, [`${person.email}|${group.code}`]: e.target.value }))
                                  }
                                />
                              </div>
                            )}

                            <div className="checks">
                              {loadingBrands.includes(group.code) ? (
                                <span className="field__help">Reading stores from Power BI…</span>
                              ) : group.rows.length === 0 ? (
                                <span className="field__help">No store matches.</span>
                              ) : (
                                group.rows.map((branch) => (
                                  <button
                                    key={branch}
                                    type="button"
                                    className={`check${has(person, group.code, branch) ? ' check--on' : ''}`}
                                    onClick={() => toggleBranch(i, group.code, branch)}
                                  >
                                    <span className="check__box">
                                      {has(person, group.code, branch) && <IconCheck size={10} />}
                                    </span>
                                    <span className="check__label">{branch}</span>
                                  </button>
                                ))
                              )}
                            </div>
                          </div>
                        ))}

                      {usesBrands && person.brands.length === 0 && (
                        <span className="field__help">
                          {needsLocation
                            ? 'Choose a brand to see its branches.'
                            : 'None chosen means every brand.'}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {creating && (
              <button type="button" className="btn people__add" onClick={addPerson}>
                <IconPlus size={12} />
                Add another
              </button>
            )}

            <span className="field__help">
              {creating
                ? 'One email per branch per address. Pasting a list of addresses splits it into rows, each copying the scope of the one it was pasted into.'
                : 'The address cannot be changed. Remove this recipient and add it again to move the report elsewhere.'}
            </span>
          </div>

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
            {busy
              ? 'Saving…'
              : !creating
                ? 'Save'
                : complete.length > 1
                  ? `Add ${complete.length} recipients`
                  : 'Add recipient'}
          </button>
        </div>
      </div>
    </div>
  )
}
