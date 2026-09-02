import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, fmtInt, fmtPct, downloadCsv } from '../api.js'
import {
  Panel,
  MetricCard,
  ErrorBanner,
  ChartSkeleton,
  Empty,
  Pill,
  InfoBanner,
} from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { IconDownload, IconRefresh } from '../components/Icons.jsx'
import { UserEditor } from '../components/UserEditor.jsx'
import { LoginActivityChart, UsageBarChart } from '../components/charts/adminCharts.jsx'
import { DigestPanel } from '../components/DigestPanel.jsx'
import { AlertsPanel } from '../components/AlertsPanel.jsx'
import { EmailPanel } from '../components/EmailPanel.jsx'
import { WhyPanel } from '../components/WhyPanel.jsx'
import { ModelReview } from '../components/ModelReview.jsx'
import { CubeStatus } from '../components/CubeStatus.jsx'
import { NonRecipePanel } from '../components/NonRecipePanel.jsx'
import { useData } from '../useData.js'

/**
 * Admin panel: who exists, what they may see, and whether they actually use it.
 *
 * Deliberately assembled from the same Panel / DataTable / MetricCard pieces the
 * dashboard uses, so adding an audit tab or a CSV export later is a new section
 * rather than a new design.
 */

const USAGE_VIEWS = [
  { id: 'role', label: 'Role' },
  { id: 'brand', label: 'Brand' },
  { id: 'location', label: 'Store' },
  { id: 'department', label: 'Dept' },
]

const STATUS_TONE = { active: 'green', pending: 'amber', suspended: 'red', disabled: 'slate' }

const relative = (iso) => {
  if (!iso) return 'never'
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime()
  if (Number.isNaN(then)) return iso
  const mins = Math.floor((Date.now() - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`
}

/** A user's grants, written the way an admin would say them out loud. */
function scopeSummary(user) {
  if (user.role === 'admin') return 'Everything'
  if (!user.scopes.length) return 'Nothing assigned'

  const brands = [...new Set(user.scopes.map((s) => s.brand).filter(Boolean))]
  const locations = [...new Set(user.scopes.map((s) => s.location).filter(Boolean))]
  const brandPart = brands.length ? brands.join(', ') : 'All brands'
  const locationPart = locations.length ? `${locations.length} location${locations.length === 1 ? '' : 's'}` : 'all locations'
  return `${brandPart} · ${locationPart}`
}

export function Admin({ session }) {
  const [data, setData] = useState(null)
  const [analytics, setAnalytics] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(true)
  const [editing, setEditing] = useState(null)
  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [users, stats] = await Promise.all([api.admin.users(), api.admin.analytics()])
      setData(users)
      setAnalytics(stats)
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }, [])

  const [granting, setGranting] = useState(null)

  /*
   * One press: active, and able to see every brand.
   *
   * Every brand rather than none, because an account that is active with no
   * grants can sign in and see an empty application, which reads as broken
   * rather than as restricted. Narrowing afterwards is a deliberate act with
   * the scope editor; the common case here is a colleague who should see the
   * lot.
   */
  const grant = useCallback(
    async (user) => {
      setGranting(user.id)
      try {
        /*
         * One row per brand, every location.
         *
         * "All brands" has no single representation — a scope row with neither
         * a brand nor a location is discarded on the way in, so granting it
         * that way produced an active account that could see nothing at all,
         * which looks broken rather than restricted. A row per brand with no
         * location says the same thing in the form the scope table holds.
         */
        await api.admin.updateUser(user.id, {
          name: user.name ?? '',
          role: user.role,
          status: 'active',
          department: user.department ?? null,
          scopes: (session?.brands ?? []).map((b) => ({ brand: b.code, location: null })),
        })
        await load()
      } catch (err) {
        setError(err.message)
      }
      setGranting(null)
    },
    [load]
  )
  const [notice, setNotice] = useState(null)
  const [usageBy, setUsageBy] = useState('role')

  /**
   * Why forecast and actual differ, across every brand at once.
   *
   * This lives here rather than on the report pages: how far the model has been
   * off is an operator's question. Merged across all brands because an admin is
   * asking about the group, not about one chain.
   */
  const contextFilters = useMemo(
    () => ({ brands: (session?.brands ?? []).map((b) => b.code) }),
    [session]
  )
  const { data: context, loading: contextLoading } = useData(api.context, contextFilters, {
    enabled: (session?.brands ?? []).length > 0,
  })

  useEffect(() => {
    load()
  }, [load])

  const users = data?.users ?? []
  const totals = analytics?.totals ?? {}
  const pending = users.filter((u) => u.status === 'pending')

  const columns = useMemo(
    () => [
      { key: 'name', label: 'Name', strong: true, render: (v, row) => v || row.email.split('@')[0] },
      { key: 'email', label: 'Email' },
      {
        key: 'role',
        label: 'Role',
        width: 116,
        render: (v) => <Pill tone="slate">{v}</Pill>,
      },
      {
        key: 'status',
        label: 'Status',
        width: 112,
        render: (v) => <Pill tone={STATUS_TONE[v] ?? 'slate'}>{v}</Pill>,
      },
      {
        key: 'department',
        label: 'Department',
        width: 128,
        render: (v) => (v ? <Pill tone="slate">{v}</Pill> : <span className="dim">—</span>),
      },
      { key: 'scope', label: 'Sees', render: (_v, row) => scopeSummary(row) },
      { key: 'login_count', label: 'Logins', width: 88, num: true, render: fmtInt },
      { key: 'last_login_at', label: 'Last seen', width: 116, render: (v) => relative(v) },
    ],
    []
  )

  const rows = useMemo(() => users.map((u) => ({ ...u, scope: scopeSummary(u) })), [users])

  // One chart, three cuts of the same question — role, brand, store.
  const usage = useMemo(() => {
    if (usageBy === 'brand') {
      return {
        rows: analytics?.byBrand ?? [],
        key: 'label',
        width: 128,
        empty: 'No brand has been granted to anyone yet',
      }
    }
    if (usageBy === 'department') {
      return {
        rows: analytics?.byDepartment ?? [],
        key: 'department',
        width: 128,
        empty: 'No department set on any account yet',
      }
    }
    if (usageBy === 'location') {
      return {
        rows: analytics?.byLocation ?? [],
        key: 'location',
        width: 108,
        empty: 'Nobody is limited to specific stores yet',
      }
    }
    return { rows: analytics?.byRole ?? [], key: 'role', width: 92, empty: 'Nothing to show yet' }
  }, [analytics, usageBy])

  if (error) return <ErrorBanner error={error} onRetry={load} />

  return (
    <>
      {notice && (
        <InfoBanner tone="warn">
          {notice}{' '}
          <button type="button" className="pop__link" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </InfoBanner>
      )}

      {/*
        Approving somebody was always possible and never visible: it meant
        opening the row, finding the status control and switching it. Somebody
        signing in and being told to wait for an administrator deserves an
        administrator who can see them and act in one press.
      */}
      {pending.length > 0 && (
        <InfoBanner tone="warn">
          <div className="grantrow">
            <div>
              <strong>
                {pending.length} account{pending.length === 1 ? '' : 's'} waiting for access
              </strong>{' '}
              — signed in with Microsoft and cannot see anything yet.
              <div className="grantrow__hint">
                {/* Both buttons now leave the account able to sign in. Setting
                    brands without setting the status was what left people
                    asking for access somebody thought they had given. */}
                <strong>Grant access</strong> gives every brand in one press.{' '}
                <strong>Choose scope</strong> opens the same account to pick brands and branches
                first — it saves as active too, so either way they can sign in afterwards. The
                address shown is the one their Microsoft account signs in with.
              </div>
            </div>
            <div className="grantrow__list">
              {pending.map((u) => (
                <span className="grantrow__one" key={u.id}>
                  <span className="grantrow__who">
                    {u.name ? `${u.name} · ` : ''}
                    {u.email}
                  </span>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={granting === u.id}
                    onClick={() => grant(u)}
                    title={`Give ${u.email} access to every brand`}
                  >
                    {granting === u.id ? 'Granting…' : 'Grant access'}
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => setEditing({ mode: 'edit', user: u })}>
                    Choose scope
                  </button>
                </span>
              ))}
            </div>
          </div>
        </InfoBanner>
      )}

      <div className="metrics">
        <MetricCard
          label="Total users"
          accent="blue"
          progress={1}
          loading={busy}
          value={fmtInt(totals.total ?? 0)}
          foot={`${fmtInt(totals.never_signed_in ?? 0)} never signed in`}
        />
        <MetricCard
          label="Active"
          accent="green"
          progress={totals.total ? (totals.active ?? 0) / totals.total : 0}
          loading={busy}
          value={fmtInt(totals.active ?? 0)}
          foot={totals.total ? `${fmtPct((totals.active ?? 0) / totals.total, 0)} of accounts` : ''}
        />
        <MetricCard
          label="Seen in 30 days"
          accent="green"
          progress={totals.active ? (totals.seen_recently ?? 0) / totals.active : 0}
          loading={busy}
          value={fmtInt(totals.seen_recently ?? 0)}
          foot="Signed in at least once"
        />
        <MetricCard
          label="Pending or blocked"
          accent={pending.length ? 'amber' : 'slate'}
          progress={totals.total ? ((totals.pending ?? 0) + (totals.inactive ?? 0)) / totals.total : 0}
          loading={busy}
          value={fmtInt((totals.pending ?? 0) + (totals.inactive ?? 0))}
          foot={`${fmtInt(totals.pending ?? 0)} pending · ${fmtInt(totals.inactive ?? 0)} suspended`}
        />
      </div>

      {/* Adding someone is the single most common reason an admin opens this
          page, so it sits directly under the counts rather than buried in the
          toolbar of a table further down. */}
      <section className="addbar">
        <div className="addbar__text">
          <h2>Add a user</h2>
          <p>
            Set their role and which brands and stores they may see. They get a password shown once,
            which you pass on — nobody, including you, can read it back afterwards.
          </p>
        </div>

        {pending.length > 0 && (
          <div className="addbar__pending">
            <span className="addbar__pendingLabel">Waiting for approval</span>
            <div className="addbar__chips">
              {pending.slice(0, 4).map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="choice"
                  onClick={() => setEditing({ mode: 'edit', user: u })}
                >
                  {u.name || u.email}
                </button>
              ))}
              {pending.length > 4 && <span className="field__help">+{pending.length - 4} more</span>}
            </div>
          </div>
        )}

        <button
          type="button"
          className="btn btn--primary addbar__cta"
          onClick={() => setEditing({ mode: 'create' })}
        >
          Add user
        </button>
      </section>

      {/* The list sits directly under the controls that change it: somebody who
          has just added or approved an account looks for it here, not past the
          charts. */}
      <Panel
        title="Users"
        count={busy ? undefined : `${users.length} accounts`}
        sub="Click a row to change role, scope or status"
        flush
        tools={
          <>
            <button type="button" className="btn" onClick={load}>
              <IconRefresh size={12} />
              Refresh
            </button>
            <button
              type="button"
              className="btn"
              disabled={!users.length}
              onClick={() =>
                downloadCsv(
                  'demand-forecast-users.csv',
                  rows,
                  [
                    { key: 'email', label: 'Email' },
                    { key: 'name', label: 'Name' },
                    { key: 'role', label: 'Role' },
                    { key: 'department', label: 'Department' },
                    { key: 'status', label: 'Status' },
                    { key: 'scope', label: 'Sees' },
                    { key: 'login_count', label: 'Logins' },
                    { key: 'last_login_at', label: 'Last login' },
                  ]
                )
              }
            >
              <IconDownload size={12} />
              CSV
            </button>
          </>
        }
      >
        {busy ? (
          <div style={{ padding: 16 }}>
            <ChartSkeleton height={280} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            initialSort={{ key: 'last_login_at', dir: 'desc' }}
            searchPlaceholder="Search name or email…"
            paginate={users.length > 50}
            maxHeight={520}
            onRowClick={(row) => setEditing({ mode: 'edit', user: row })}
          />
        )}
      </Panel>

      {/* What the forecast says, beside what has broken. Two different jobs:
          one is read each morning, the other is cleared when it is fixed. */}
      <div className="grid2">
        <DigestPanel />
        <AlertsPanel />
      </div>

      <WhyPanel
        context={context}
        loading={contextLoading}
        title="Why forecast and actual differ"
      />

      <CubeStatus />

      <NonRecipePanel />

      <ModelReview />

      <div className="grid2">
        <Panel title="Sign-in activity" sub={`Distinct users per day · last ${analytics?.days ?? 30} days`}>
          {busy ? (
            <ChartSkeleton height={220} />
          ) : !analytics?.daily?.length ? (
            <Empty title="No sign-ins recorded yet" />
          ) : (
            <LoginActivityChart daily={analytics.daily} failures={analytics.failures} />
          )}
        </Panel>

        <Panel
          title="Where the app is used"
          sub="Sign-ins in the window, against the number of accounts"
          tools={
            <div className="choices">
              {USAGE_VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`choice${usageBy === v.id ? ' choice--on' : ''}`}
                  onClick={() => setUsageBy(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          }
        >
          {busy ? (
            <ChartSkeleton height={220} />
          ) : !usage.rows.length ? (
            <Empty title={usage.empty} />
          ) : (
            <UsageBarChart data={usage.rows} labelKey={usage.key} width={usage.width} />
          )}
        </Panel>
      </div>

      <EmailPanel />

      <Panel title="Recent sign-in attempts" sub="Successes and failures, newest first" flush>
        {busy ? (
          <div style={{ padding: 16 }}>
            <ChartSkeleton height={220} />
          </div>
        ) : !analytics?.recent?.length ? (
          <Empty title="Nothing recorded yet" />
        ) : (
          <DataTable
            columns={[
              { key: 'created_at', label: 'When', width: 150, render: (v) => relative(v) },
              { key: 'email_attempted', label: 'Email' },
              { key: 'role', label: 'Role', width: 112, render: (v) => (v ? <Pill tone="slate">{v}</Pill> : '—') },
              {
                key: 'success',
                label: 'Result',
                width: 112,
                render: (v, row) =>
                  v ? <Pill tone="green">signed in</Pill> : <Pill tone="red">{row.reason ?? 'failed'}</Pill>,
              },
              { key: 'ip', label: 'IP', width: 148 },
            ]}
            rows={analytics.recent}
            searchable={false}
            paginate={false}
            maxHeight={300}
          />
        )}
      </Panel>

      {editing && (
        <UserEditor
          mode={editing.mode}
          user={editing.user}
          roles={data?.roles ?? []}
          statuses={data?.statuses ?? []}
          departments={data?.departments ?? []}
          departmentScopes={data?.departmentScopes ?? {}}
          departmentPages={data?.departmentPages ?? {}}
          brands={session?.brands ?? []}
          currentUserId={session?.user?.id}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null)
            if (message) setNotice(message)
            load()
          }}
        />
      )}
    </>
  )
}
