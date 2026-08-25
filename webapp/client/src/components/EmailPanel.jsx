import { useCallback, useEffect, useState } from 'react'
import { api, fmtInt } from '../api.js'
import { Panel, Empty, ChartSkeleton, Pill, InfoBanner } from './ui.jsx'
import { DataTable } from './DataTable.jsx'
import { IconRefresh, IconCheck } from './Icons.jsx'
import { RecipientEditor } from './RecipientEditor.jsx'
import { BulkRecipients } from './BulkRecipients.jsx'
import { RecipientTable } from './RecipientTable.jsx'

/**
 * Controls for the daily reports.
 *
 * The order here is deliberate — check the mailbox works, see who would be
 * reached, look at what they would actually get, and only then send. Every one
 * of those steps is reversible; the send is not.
 */

const STATUS_TONE = { sent: 'green', failed: 'red', skipped: 'slate' }

function ago(iso) {
  if (!iso) return ''
  const t = Date.parse(iso.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return iso
  const mins = Math.floor((Date.now() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`
}

export function EmailPanel() {
  const [state, setState] = useState(null)
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState(true)
  const [working, setWorking] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [editing, setEditing] = useState(null)
  const [transport, setTransport] = useState(null)
  const [importing, setImporting] = useState(false)
  const [listing, setListing] = useState(false)

  const connectMailbox = async () => {
    const { url } = await api.admin.connectMailbox()
    window.location.href = url
  }

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [list, mailbox, howItSends] = await Promise.all([
        api.admin.emailRecipients(),
        api.admin.emailCheck().catch((e) => ({ ok: false, error: e.message })),
        api.admin.emailTransport().catch(() => null),
      ])
      setState(list)
      setCheck(mailbox)
      setTransport(howItSends)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const run = async (opts, label) => {
    setWorking(label)
    setError(null)
    setNote(null)
    try {
      const res = await api.admin.sendEmail(opts)
      const c = res.run.counts
      setNote(
        opts.dryRun
          ? `Built ${c.built} report${c.built === 1 ? '' : 's'} without sending. ${c.skipped} recipient${c.skipped === 1 ? '' : 's'} skipped.`
          : `${c.sent} sent, ${c.failed} failed, ${c.skipped} skipped${res.run.redirectedTo ? ` — all delivered to ${res.run.redirectedTo} because MAIL_TEST_TO is set` : ''}.`
      )
      setState((s) => ({ ...s, log: res.log, summary: res.summary }))
    } catch (err) {
      setError(err.message)
    } finally {
      setWorking(null)
    }
  }

  const list = state?.recipients ?? []
  const willSend = list.filter((r) => r.active)
  const skipped = list.filter((r) => r.report === 'store_plan' && !r.locations?.length)

  return (
    <Panel
      title="Daily reports"
      count={busy ? undefined : `${willSend.length} recipient${willSend.length === 1 ? '' : 's'}`}
      sub={
        busy
          ? 'Checking…'
          : state?.enabled
            ? `Sent automatically at ${String(state.hour).padStart(2, '0')}:00 · always from ${state.mailbox}, whoever presses send`
            : `Scheduling is off — set MAIL_ENABLED=1 to send automatically from ${state?.mailbox ?? 'the configured mailbox'}`
      }
      tools={
        <>
          <button
            type="button"
            className="btn"
            disabled={Boolean(working)}
            onClick={() => run({ dryRun: true }, 'dry')}
          >
            {working === 'dry' ? 'Building…' : 'Dry run'}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={Boolean(working) || !check?.ok}
            title={check?.ok ? 'Send now' : 'The mailbox is not usable yet'}
            onClick={() => run({}, 'send')}
          >
            {working === 'send' ? 'Sending…' : 'Send now'}
          </button>
          <button type="button" className="btn" onClick={() => setEditing({ mode: 'create' })}>
            Add recipient
          </button>
          {/* Only once the list has arrived: the table seeds itself from it, and
              opening early would show an empty grid over a full list. */}
          <button
            type="button"
            className="btn"
            disabled={busy || !state}
            onClick={() => setListing(true)}
          >
            Edit as table
          </button>
          <button type="button" className="btn" onClick={() => setImporting(true)}>
            Import list
          </button>
          <button type="button" className="btn" onClick={load}>
            <IconRefresh size={12} />
          </button>
        </>
      }
    >
      {busy ? (
        <ChartSkeleton height={200} />
      ) : (
        <>
          {error && <InfoBanner tone="warn">{error}</InfoBanner>}
          {note && <InfoBanner>{note}</InfoBanner>}

          {check && !check.ok && (
            <InfoBanner tone="warn">
              {/* The server names the exact missing permission, so repeating a
                  generic hint here only said the same thing twice. */}
              <strong>Mail cannot be sent yet.</strong> {check.error}
            </InfoBanner>
          )}

          {/* What this particular transport still needs.
              The banner above says why the current route is blocked; this says
              what to do about it, and the answer depends on which route is
              selected. */}
          {transport && !transport.ready && (
            <InfoBanner tone={transport.transport === 'flow' ? 'info' : 'info'}>
              {transport.transport === 'flow' ? (
                <>
                  <strong>Power Automate is selected, but there is no flow to post to.</strong>{' '}
                  Build the flow, copy its HTTP POST URL into <code>POWER_AUTOMATE_URL</code> and
                  restart. The steps and the exact trigger schema are in{' '}
                  <code>docs/EMAIL.md</code>.
                </>
              ) : transport.transport === 'delegated' ? (
                <>
                  <strong>No mailbox is connected yet.</strong> Sign in once as the sending account
                  and it can send without any tenant permission.{' '}
                  <button type="button" className="pop__link" onClick={connectMailbox}>
                    Connect a mailbox
                  </button>
                </>
              ) : (
                <>
                  <strong>This transport is not configured.</strong> Missing:{' '}
                  <code>{(transport.missing ?? []).join(', ')}</code>.
                </>
              )}
            </InfoBanner>
          )}

          {/* Always offered, whatever is selected: it needs nobody's approval. */}
          {transport && !transport.ready && transport.transport !== 'delegated' && (
            <InfoBanner>
              <strong>Or send as a mailbox instead.</strong>{' '}
              {transport.connectedMailbox
                ? `${transport.connectedMailbox.email} is connected — set MAIL_TRANSPORT=delegated to use it.`
                : 'One sign-in as the sending account, no tenant permission and no password.'}{' '}
              <button type="button" className="pop__link" onClick={connectMailbox}>
                {transport.connectedMailbox ? 'Reconnect' : 'Connect a mailbox'}
              </button>
            </InfoBanner>
          )}

          {state?.testTo && (
            <InfoBanner>
              <strong>Test mode.</strong> Every report is delivered to <code>{state.testTo}</code>{' '}
              instead of its real recipient, with the intended address in the subject. Clear{' '}
              <code>MAIL_TEST_TO</code> in <code>.env</code> to send for real.
            </InfoBanner>
          )}

          {list.length === 0 ? (
            <Empty title="Nobody is set up to receive reports">
              Use <strong>Add recipient</strong> to choose an address and what it receives. An account
              is not required — a distribution list works.
            </Empty>
          ) : (
            <DataTable
              columns={[
                { key: 'email', label: 'Recipient', strong: true },
                { key: 'name', label: 'Name', render: (v) => v || <span className="dim">—</span> },
                {
                  key: 'department',
                  label: 'Goes to',
                  width: 128,
                  render: (v) => (v ? <Pill tone="slate">{v}</Pill> : <span className="dim">—</span>),
                },
                {
                  key: 'reportLabel',
                  label: 'Receives',
                  width: 168,
                  render: (v) => <Pill tone="slate">{v}</Pill>,
                },
                { key: 'summary', label: 'Scope' },
                {
                  key: 'active',
                  label: 'Sending',
                  width: 96,
                  render: (v) => (v ? <Pill tone="green">on</Pill> : <Pill tone="slate">paused</Pill>),
                },
                {
                  key: 'preview',
                  label: '',
                  width: 150,
                  // Edit was only ever a click on the row, which nobody can see.
                  render: (_v, row) => (
                    <span className="rowactions">
                      <a
                        className="btn"
                        href={`/api/admin/email/preview/${row.id}?html=1`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Preview
                      </a>
                      <button
                        type="button"
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditing({ mode: 'edit', recipient: row })
                        }}
                      >
                        Edit
                      </button>
                    </span>
                  ),
                },
              ]}
              rows={list}
              searchable={list.length > 8}
              paginate={false}
              maxHeight={300}
              onRowClick={(row) => setEditing({ mode: 'edit', recipient: row })}
            />
          )}

          {skipped.length > 0 && (
            <p className="field__help" style={{ marginTop: 8 }}>
              {skipped.length} recipient{skipped.length === 1 ? '' : 's'} will not receive anything —
              a prep list needs at least one store chosen, so it is skipped rather than sent every
              branch in the brand.
            </p>
          )}

          {state?.log?.length > 0 && (
            <div className="emaillog">
              <h3 className="digest__groupHead">
                <span>Recent sends</span>
              </h3>
              <ul className="digest__list">
                {state.log.slice(0, 6).map((l) => (
                  <li className="emaillog__row" key={l.id}>
                    <Pill tone={STATUS_TONE[l.status] ?? 'slate'}>
                      {l.status === 'sent' && <IconCheck size={10} />}
                      {l.status}
                    </Pill>
                    <span className="emaillog__to">{l.email}</span>
                    <span className="emaillog__subject">{l.subject || l.error}</span>
                    <span className="emaillog__when">{ago(l.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {editing && (
        <RecipientEditor
          mode={editing.mode}
          recipient={editing.recipient}
          reports={state?.reports}
          brands={state?.brands}
          departments={state?.departments}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null)
            setNote(message)
            load()
          }}
        />
      )}
      {listing && (
        <RecipientTable
          recipients={state?.recipients}
          reports={state?.reports}
          brands={state?.brands}
          departments={state?.departments}
          onClose={() => setListing(false)}
          onSaved={(message) => {
            setListing(false)
            setNote(message)
            load()
          }}
        />
      )}
      {importing && (
        <BulkRecipients
          onClose={() => setImporting(false)}
          onDone={(message) => {
            setImporting(false)
            setNote(message)
            load()
          }}
        />
      )}
    </Panel>
  )
}
