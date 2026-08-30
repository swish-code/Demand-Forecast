import { useEffect, useState } from 'react'
import { api, fmtInt } from '../api.js'
import { Panel, Empty } from './ui.jsx'
import { BrandTag } from './BrandTag.jsx'

/**
 * What the local copy holds, and how old it is.
 *
 * Worth a panel of its own. Once the pages answer from a copy rather than from
 * Power BI, "as of when" stops being an implementation detail and becomes
 * something a reader is entitled to see before they trust a number.
 */
function ago(iso) {
  if (!iso) return 'never'
  const then = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (Number.isNaN(then)) return iso
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  return hrs < 24 ? `${hrs} hour${hrs === 1 ? '' : 's'} ago` : `${Math.round(hrs / 24)} days ago`
}

export function CubeStatus() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [starting, setStarting] = useState(false)
  const [note, setNote] = useState(null)

  useEffect(() => {
    let live = true
    const load = () =>
      api.admin
        .cube()
        .then((d) => live && setData(d))
        .catch((e) => live && setError(e.message))
    load()
    const t = setInterval(load, 60_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])

  /*
   * Rebuilding after the semantic model changes.
   *
   * The copy refreshes its recent days every hour and rebuilds itself
   * overnight, which is right for sales landing day by day and wrong for the
   * model being edited: a changed measure or a renamed product affects the
   * whole calendar, and waiting until two in the morning to see your own change
   * is not a reasonable answer.
   *
   * It walks every brand one branch at a time and takes a good while, so it is
   * started rather than awaited. The panel polls, and says so while it runs.
   */
  const rebuild = async () => {
    setStarting(true)
    setNote(null)
    try {
      await api.admin.rebuildCube()
      setNote('Rebuilding. It reads every brand from Power BI and takes a while — this panel follows it.')
      setData((d) => (d ? { ...d, running: true } : d))
    } catch (err) {
      setNote(err.message)
    } finally {
      setStarting(false)
    }
  }

  const brands = data?.brands ?? []

  return (
    <Panel
      title="Local copy of the forecast"
      count={data ? `${fmtInt(data.rows)} rows` : undefined}
      tools={
        <button
          type="button"
          className="btn"
          disabled={starting || data?.running}
          onClick={rebuild}
          title="Read every brand from Power BI again. Use this after changing the semantic model."
        >
          {data?.running ? 'Rebuilding…' : starting ? 'Starting…' : 'Rebuild from Power BI'}
        </button>
      }
      sub={
        error
          ? undefined
          : data?.running
            ? 'Extracting now…'
            : data?.last
              ? `Last ${data.last.label} took ${data.last.seconds}s · ${ago(new Date(data.last.at).toISOString())}`
              : 'Waiting for the first extract'
      }
    >
      {note && <p className="cube__note">{note}</p>}
      {error ? (
        <p className="digest__error">{error}</p>
      ) : brands.length === 0 ? (
        <Empty title="Nothing extracted yet">
          Every page is answering from Power BI directly until the first extract finishes.
        </Empty>
      ) : (
        <>
          <p className="review__intro">
            The Overview page reads these rows instead of querying Power BI, which is why changing a
            brand, branch, product or date range is instant. Anything outside the window below, and
            every other page, still goes to Power BI.
          </p>
          <table className="dt">
            <thead>
              <tr>
                <th scope="col">Brand</th>
                <th scope="col">Covers</th>
                <th scope="col" style={{ textAlign: 'right' }}>Rows</th>
                <th scope="col">Refreshed</th>
              </tr>
            </thead>
            <tbody>
              {brands.map((b) => (
                <tr key={b.brand}>
                  <td><BrandTag code={b.brand} /></td>
                  <td className="dim">{b.from_date} → {b.to_date}</td>
                  <td style={{ textAlign: 'right' }}>{fmtInt(b.rows)}</td>
                  <td className="dim">{ago(b.refreshed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.lastError && (
            <p className="digest__error" style={{ marginTop: 12 }}>
              Last extract reported: {data.lastError}
            </p>
          )}
        </>
      )}
    </Panel>
  )
}
