/**
 * Monthly MC Analysis - the Costing Department's page. 19 Nov 2026.
 *
 * Per article per brand, the selected calendar month and the one before it:
 * MC theoretical, actual consumption, accuracy and variance %, with the
 * article's Recipe / Non-Recipe classification beside them.
 *
 * Every figure comes from the server, computed by the same functions the
 * Variance Analysis page's MC view uses (server/costing/analysis.js) - nothing
 * is recalculated here except the weighted accuracy headlines, which use the
 * Variance page's own "MC Match %" formula over the rows on screen.
 *
 * The classification is the article's, not the row's: one article sold under
 * three brands is three rows and one classification. Changing it is a server
 * write to Snowflake with the signed-in account's identity, guarded by a
 * version number so two people editing at once cannot silently overwrite each
 * other. Every change is in the article's history, which nothing can edit.
 *
 * LAYOUT (20 Nov 2026, on request): the SWiSH Analytics pattern - a large
 * title with the date, pill tabs beside a filter card, a "this month at a
 * glance" row of cards each comparing the month with the one before, then
 * white table cards with uppercase headings, inline bars and a closing note
 * saying how to read them. Styles are scoped under `.mcm` in theme.css.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmtInt, fmtPct, fmtQty, fmtSignedPct, downloadCsv } from '../api.js'
import { useData } from '../useData.js'
import { ErrorBanner, Empty, InfoBanner, Pill } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import {
  IconAlert,
  IconBox,
  IconCalendar,
  IconCheck,
  IconChevron,
  IconClose,
  IconDownload,
  IconFilter,
  IconInsight,
  IconRefresh,
  IconTable,
  IconSummary,
} from '../components/Icons.jsx'

const THRESHOLD = 0.2
const CLASSIFICATIONS = ['Recipe', 'Non-Recipe']

const dash = () => <span className="muted">–</span>

const monthLabel = (m) =>
  m
    ? new Date(`${String(m).slice(0, 10)}T00:00:00Z`).toLocaleString('en-GB', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '–'

const monthShort = (m) => (m ? String(m).slice(0, 7) : '–')

const when = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

/** The last eighteen calendar months, newest first, as 'YYYY-MM-01'. */
function monthChoices(now = new Date()) {
  const out = []
  for (let i = 0; i < 18; i++) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`)
  }
  return out
}

/*
 * THE CURRENT MONTH AND THE PREVIOUS ONE - 28 Nov 2026, on request ("show only
 * current month and previous month's, instead of showing october and
 * september").
 *
 * `monthChoices()` returns eighteen months; this is the window of it the page
 * opens. Index 0 is the month in hand. The page shows that month as Current and
 * the one before as Previous (the server pairs them), and offers no other.
 *
 * This replaces the 20 Nov setting (OFFSET 1), which opened on last month - so
 * Current read October and Previous September while this is November. That
 * was there because the current month used to be empty; since 28 Nov the page
 * reads MC directly and the month in progress carries MC's theoretical to date,
 * with consumption shown as Missing Data until MC closes the month's count.
 *
 * The default month, the picker and the Reset button all read these two.
 */
const MONTH_OFFSET = 0
const MONTH_COUNT = 1

const qty = (v) => (v === null || v === undefined ? dash() : fmtQty(v))

/** Variance %, amber over and blue under, bold past the alert threshold. */
const pctCell = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return dash()
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : ''
  const text = fmtSignedPct(v, 1)
  return (
    <span className={cls} title={Math.abs(v) > THRESHOLD ? 'Beyond the 20% alert threshold' : undefined}>
      {Math.abs(v) > THRESHOLD ? <strong>{text}</strong> : text}
    </span>
  )
}

const accCell = (v) => (v === null || v === undefined ? dash() : fmtPct(v, 1))

/** Accuracy with a bar beside it, as the reference table draws coverage. */
const accBarCell = (v) =>
  v === null || v === undefined ? (
    dash()
  ) : (
    <span className="mcm-acc">
      <span>{fmtPct(v, 1)}</span>
      <span className="mcm-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(0, Math.min(100, Math.round(v * 100)))}%` }} />
      </span>
    </span>
  )

const isScored = (f) => f.status === 'Match' || f.status === 'Variance'
const isFlagged = (f) => f.theoretical > 0 && Math.abs(f.variancePct ?? 0) > THRESHOLD

/** The Variance page's "MC Match %": 1 - Σ|actual - theoretical| / Σ max, scored rows only. */
function weightedAccuracy(rows, slot) {
  let base = 0
  let gap = 0
  for (const r of rows) {
    const f = r[slot]
    if (!isScored(f)) continue
    const t = Number(f.theoretical)
    const a = Number(f.actual)
    if (!Number.isFinite(t) || !Number.isFinite(a)) continue
    base += Math.max(t, a)
    gap += Math.abs(a - t)
  }
  return base > 0 ? Math.max(0, 1 - gap / base) : null
}

/** One month's headline counts over a set of rows. */
function monthStats(rows, slot) {
  let held = 0
  let scored = 0
  let flagged = 0
  let theo = 0
  let cons = 0
  for (const r of rows) {
    const f = r[slot]
    if (f.status !== 'Missing Data') held += 1
    if (isScored(f)) {
      scored += 1
      // The overall variance is over the same scored rows as the accuracy.
      const t = Number(f.theoretical)
      const c = Number(f.actual)
      if (Number.isFinite(t) && Number.isFinite(c)) {
        theo += t
        cons += c
      }
    }
    if (isFlagged(f)) flagged += 1
  }
  return {
    held,
    scored,
    flagged,
    within: Math.max(0, scored - flagged),
    accuracy: weightedAccuracy(rows, slot),
    // Σ(consumption − theoretical) ÷ Σ theoretical - the Variance page's
    // "MC Variance" percentage, over the rows MC scores.
    variance: theo > 0 ? (cons - theo) / theo : null,
  }
}

/* -------------------------------------------------------------- pieces -- */

/**
 * The change pill: an arrow and the change against last month.
 * `kind: 'pct'` is a relative change, `'pts'` a difference of two rates.
 */
function Delta({ now, before, kind = 'pct' }) {
  if (now === null || now === undefined || before === null || before === undefined) return null
  let value
  let text
  if (kind === 'pts') {
    value = (now - before) * 100
    text = `${value > 0 ? '+' : ''}${value.toFixed(1)} pts`
  } else {
    if (!before) return null
    value = (now - before) / before
    text = fmtSignedPct(value, 1)
  }
  const up = value > 0
  return (
    <span className={`mcm-delta${value === 0 ? ' mcm-delta--flat' : ''}`}>
      <span aria-hidden="true">{value === 0 ? '→' : up ? '↗' : '↘'}</span>
      {text}
    </span>
  )
}

function GlanceCard({ icon, label, value, extra, lastLabel = 'Last month', last, delta, foot, loading }) {
  if (loading) return <div className="mcm-card skel" aria-hidden="true" />
  return (
    <div className="mcm-card">
      <div className="mcm-card__label">
        <span className="mcm-card__icon">{icon}</span>
        {label}
      </div>
      <div className="mcm-card__value">
        {value}
        {extra ? <span className="mcm-card__extra">{extra}</span> : null}
      </div>
      <div className="mcm-card__foot">
        {foot ?? (
          <>
            {lastLabel} <strong>{last}</strong>
            {delta}
          </>
        )}
      </div>
    </div>
  )
}

function Section({ title, sub, children }) {
  return (
    <section className="mcm-section">
      <h3 className="mcm-section__title">{title}</h3>
      {sub ? <p className="mcm-section__sub">{sub}</p> : null}
      {children}
    </section>
  )
}

function Card({ title, aside, tools, children, busy }) {
  return (
    <div className={`mcm-box${busy ? ' mcm-box--busy' : ''}`}>
      <div className="mcm-box__head">
        <h4 className="mcm-box__title">{title}</h4>
        <div className="mcm-box__aside">
          {aside ? <span>{aside}</span> : null}
          {tools}
        </div>
      </div>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------ history -- */

function HistoryDialog({ row, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, history: [] })
  useEffect(() => {
    let live = true
    api
      .costingHistory(row.articleId)
      .then((r) => live && setState({ loading: false, error: null, history: r.history ?? [] }))
      .catch((error) => live && setState({ loading: false, error, history: [] }))
    return () => {
      live = false
    }
  }, [row.articleId])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__card" role="dialog" aria-modal="true" aria-label="Classification history">
        <div className="modal__head">
          <div>
            <h2 className="modal__title">{row.articleName}</h2>
            <span className="modal__sub">
              Article {row.articleId} · classification history · initial value{' '}
              <strong>{row.initialClassification}</strong> (from Recipe File SWiSH)
            </span>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>
        <div className="modal__body">
          {state.error ? (
            <ErrorBanner error={state.error} />
          ) : state.loading ? (
            <div className="skel" style={{ height: 120 }} aria-hidden="true" />
          ) : state.history.length === 0 ? (
            <Empty title="Never changed">
              This article still carries its initial classification, {row.initialClassification}, taken
              from Recipe File SWiSH. Nobody has changed it.
            </Empty>
          ) : (
            <DataTable
              columns={[
                { key: 'updatedAt', label: 'When', render: (v) => when(v) ?? dash() },
                { key: 'field', label: 'Field' },
                { key: 'previous', label: 'From', render: (v) => (v ? <Pill tone="plain">{v}</Pill> : dash()) },
                { key: 'next', label: 'To', render: (v) => (v ? <Pill tone="blue">{v}</Pill> : dash()) },
                {
                  key: 'updatedByName',
                  label: 'By',
                  render: (v, r) => <span title={r?.updatedBy ?? undefined}>{v || r?.updatedBy || '–'}</span>,
                },
              ]}
              rows={[...state.history].reverse()}
              searchable={false}
              paginate={false}
              freezable={false}
              maxHeight={360}
            />
          )}
        </div>
        <div className="modal__foot">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------- the page itself -- */

// `filters` is deliberately not read: this page carries its own, and the rail's
// slicers are switched off for it (`slicers: []`). See `request` below.
export function MonthlyMcAnalysis({ ready, refreshNonce, onLoaded }) {
  const months = useMemo(() => monthChoices(), [])
  const today = useMemo(
    () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    []
  )
  const [view, setView] = useState('analysis')
  const [month, setMonth] = useState(months[MONTH_OFFSET])
  const [classFilter, setClassFilter] = useState('All')
  /*
   * The page's own brand filter - 20 Nov 2026, on request.
   *
   * Narrows the rows ALREADY FETCHED rather than re-requesting them. The
   * request asks for every brand the account is allowed - the server decides
   * that, not this page - and this chooses which of them to look at, without
   * a round trip.
   *
   * 'All' is a value, not an absence, so the picker always has something to
   * show as current and the summary line always has a brand to name.
   */
  const [brandFilter, setBrandFilter] = useState('All')
  const [search, setSearch] = useState('')
  /*
   * One article picked from the name list - 23 Nov 2026, on request.
   *
   * Typing in the Article box still narrows the table as you type; picking a
   * name from the list under it pins the table to exactly that article (on
   * every brand that holds it), so "Sunflower Oil" no longer also brings in
   * every other name containing "sunflower". `{ id, name }` or null.
   */
  const [picked, setPicked] = useState(null)
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  /*
   * Hover-to-open, but only with a real pointer on a wide screen.
   *
   * `matchMedia` rather than a width check alone: a touch screen reports
   * `hover: none`, and on one of those `:hover` sticks after a tap, which
   * would leave the panel open with nothing to dismiss it.
   */
  const hoverable = () =>
    typeof window !== 'undefined' &&
    window.matchMedia?.('(hover: hover) and (min-width: 821px)').matches

  const closeTimer = useRef(null)
  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const hoverOpen = () => {
    if (!hoverable()) return
    cancelClose()
    setFiltersOpen(true)
  }
  const hoverClose = () => {
    if (!hoverable()) return
    cancelClose()
    // The pointer crosses a gap between the panel and its flyouts; closing on
    // `mouseleave` alone shut it mid-journey.
    closeTimer.current = setTimeout(() => {
      setFiltersOpen(false)
      setMenu(null)
    }, 240)
  }
  useEffect(() => cancelClose, [])
  /** Which filter's flyout is open: 'month' | 'class' | 'article' | null. */
  const [menu, setMenu] = useState(null)
  const filterRef = useRef(null)
  /*
   * Close on a click outside, or on Escape.
   *
   * `mousedown` rather than `click`: a click that starts inside the panel and
   * ends outside it - dragging to select the text in the Article box - would
   * otherwise shut the panel mid-gesture. Bound only while the panel is open,
   * so the page carries no listener the rest of the time.
   */
  useEffect(() => {
    if (!filtersOpen) return undefined
    const away = (e) => {
      if (filterRef.current?.contains(e.target)) return
      setFiltersOpen(false)
      setMenu(null)
    }
    /*
     * Escape closes one layer at a time: the flyout first, then the panel.
     * Shutting both at once loses the reader's place for a key they pressed to
     * back out of a submenu.
     */
    const key = (e) => {
      if (e.key !== 'Escape') return
      if (menu) setMenu(null)
      else setFiltersOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [filtersOpen, menu])
  const [historyFor, setHistoryFor] = useState(null)
  const [saving, setSaving] = useState(null)
  const [notice, setNotice] = useState(null)
  /*
   * Classifications changed in this session, by article.
   *
   * Applied over the loaded rows so a change shows on every brand row of the
   * article at once, without re-reading MC for the whole table. The next load
   * reads the same values back from Snowflake.
   */
  const [edits, setEdits] = useState(() => new Map())

  /*
   * EVERY brand the account may see - 20 Nov 2026.
   *
   * This used to send `filters.brands`, the rail's own brand slicer. The page
   * is configured with `slicers: []`, so that control is not on screen here:
   * the page was being narrowed by a filter the reader could neither see nor
   * change, and whichever brand they had last chosen on another page silently
   * became the only brand MC Analysis would show. With BBT selected, the
   * brand picker added below could only ever offer BBT.
   *
   * Brands are omitted entirely now, and `brandsFor` on the server reads that
   * as "every brand this account is allowed" - see routes/costing.js. The
   * scope is still enforced there and nothing widens what anyone may read;
   * the page's own Brand filter chooses among what comes back.
   */
  const request = useMemo(() => ({ month }), [month])
  const { data, error, loading, reload } = useData(api.costingAnalysis, request, {
    enabled: ready,
    nonce: refreshNonce,
    onLoaded,
  })
  useEffect(() => setEdits(new Map()), [data])

  /*
   * Only this calendar month and last month - 20 Nov 2026, on request. The
   * page is about the month in hand and the one before; older months are on
   * the Variance Analysis page.
   */
  const monthOptions = useMemo(
    () => months.slice(MONTH_OFFSET, MONTH_OFFSET + MONTH_COUNT),
    [months]
  )

  /*
   * "this month" / "last month", worked out from the month itself.
   *
   * It used to come from the option's INDEX in the list, which was right only
   * while the list began at the current month. With the list starting at last
   * month, index 0 would have labelled October "this month".
   */
  const whenLabel = (m) =>
    m === months[0] ? 'this month' : m === months[1] ? 'last month' : ''

  const storageError = data?.storageError ?? null
  const canEdit = Boolean(data?.canEdit)
  // Allowed to edit, but saving is unavailable: the control is shown switched off.
  const editBlocked = Boolean(data?.editRole) && !canEdit
  const cur = data?.months?.current ?? month
  const prev = data?.months?.previous ?? null
  const filtered =
    brandFilter !== 'All' || classFilter !== 'All' || search.trim() !== '' || Boolean(picked) || onlyFlagged

  const alerts = useData(api.costingAlerts, request, {
    enabled: ready && Boolean(data) && !storageError,
    nonce: refreshNonce,
  })

  const rows = useMemo(() => {
    const base = (data?.rows ?? []).map((r) => {
      const e = edits.get(r.articleId)
      return e ? { ...r, ...e } : r
    })
    const needle = search.trim().toLowerCase()
    return base
      .filter((r) => brandFilter === 'All' || r.brand === brandFilter)
      .filter((r) => classFilter === 'All' || r.classification === classFilter)
      .filter((r) => !picked || String(r.articleId) === picked.id)
      .filter(
        (r) =>
          !needle ||
          String(r.articleId).toLowerCase().includes(needle) ||
          String(r.articleName ?? '').toLowerCase().includes(needle)
      )
      .filter((r) => !onlyFlagged || isFlagged(r.current) || isFlagged(r.previous))
      .map((r) => ({
        ...r,
        cur_theo: r.current.theoretical,
        cur_actual: r.current.actual,
        cur_acc: r.current.accuracy,
        cur_var: r.current.variancePct,
        prev_theo: r.previous.theoretical,
        prev_actual: r.previous.actual,
        prev_acc: r.previous.accuracy,
        prev_var: r.previous.variancePct,
        // Date and the editor's account name; the email is in the hover title.
        lastUpdated: r.lastUpdatedAt ? `${when(r.lastUpdatedAt)} · ${r.lastUpdatedByName || r.lastUpdatedBy}` : '',
      }))
  }, [data, edits, brandFilter, classFilter, search, picked, onlyFlagged])

  /*
   * Every article name in the month, for the Article list.
   *
   * Read off `data`, not the filtered rows, so picking one does not leave it
   * the only name on offer - the same rule as the brand list below. One entry
   * per article number, since an article sits on several brand rows.
   */
  const articleOptions = useMemo(() => {
    const seen = new Map()
    for (const r of data?.rows ?? []) {
      const id = String(r.articleId ?? '').trim()
      if (id && !seen.has(id)) seen.set(id, String(r.articleName ?? '').trim() || id)
    }
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [data])

  // What the list under the box shows: every name, narrowed by what is typed.
  const articleMatches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = needle
      ? articleOptions.filter((o) => o.name.toLowerCase().includes(needle) || o.id.toLowerCase().includes(needle))
      : articleOptions
    return list.slice(0, 200)
  }, [articleOptions, search])

  // A picked article that is not in the new month's data cannot stay picked.
  useEffect(() => {
    if (picked && data && !articleOptions.some((o) => o.id === picked.id)) setPicked(null)
  }, [articleOptions, picked, data])

  /*
   * The brands actually present this month, from the response itself.
   *
   * Taken from the rows rather than from a brand list, so the picker can only
   * offer a brand that has figures behind it: offering one that would produce
   * an empty table is worse than not offering it. Read off `data`, NOT the
   * filtered rows, or choosing a brand would leave it the only option.
   */
  const brandOptions = useMemo(() => {
    const seen = new Set()
    for (const r of data?.rows ?? []) {
      const b = String(r.brand ?? '').trim()
      if (b) seen.add(b)
    }
    return ['All', ...[...seen].sort()]
  }, [data])

  /*
   * A brand that is no longer on offer cannot stay selected.
   *
   * The month changes, or the rail's slicer narrows, and the brand chosen
   * before may not be in the new response - which would show an empty table
   * with a filter naming a brand that is not there. Falls back to All.
   */
  useEffect(() => {
    if (brandFilter !== 'All' && !brandOptions.includes(brandFilter)) setBrandFilter('All')
  }, [brandOptions, brandFilter])

  const glance = useMemo(() => {
    const articles = new Set(rows.map((r) => r.articleId))
    return {
      cur: monthStats(rows, 'current'),
      prev: monthStats(rows, 'previous'),
      articles: articles.size,
      recipe: new Set(rows.filter((r) => r.classification === 'Recipe').map((r) => r.articleId)).size,
    }
  }, [rows])

  /* One line per brand - the "where accuracy stands" table. */
  const byBrand = useMemo(() => {
    const groups = new Map()
    for (const r of rows) {
      if (!groups.has(r.brand)) groups.set(r.brand, [])
      groups.get(r.brand).push(r)
    }
    const line = (brand, list) => ({
      brand,
      rows: list.length,
      cur: monthStats(list, 'current'),
      prev: monthStats(list, 'previous'),
    })
    return {
      lines: [...groups.entries()].map(([b, list]) => line(b, list)).sort((a, b) => b.rows - a.rows),
      total: line('All brands', rows),
    }
  }, [rows])

  /*
   * THE PREVIOUS MONTH LEADS - 28 Nov 2026, on request ("show previous month's
   * as main, then current month"). The last full month is the headline; the
   * month in progress follows as "so far". No up/down arrow compares them: a
   * part-month against a full one would read as a fall that is only the date.
   */
  const prevLoaded = glance.prev.held > 0
  /*
   * What MC holds for the month in progress - 28 Nov 2026, on request ("show
   * whatever is available for november, leave - for those not existing"):
   * its theoretical posted so far, on the article-brands MC has posted it for;
   * consumption only once MC closes the month's stock count.
   */
  const curTheoRows = rows.filter((r) => r.current.theoretical !== null && r.current.theoretical !== undefined).length
  const curConsRows = rows.filter((r) => r.current.actual !== null && r.current.actual !== undefined).length
  const soFar = (v) => (v === null || v === undefined ? 'not counted yet' : v)

  async function classify(row, next) {
    if (next === row.classification) return
    setSaving(row.articleId)
    setNotice(null)
    try {
      const r = await api.costingClassify({
        articleId: row.articleId,
        classification: next,
        expectedVersion: row.version ?? 0,
      })
      setEdits((m) => {
        const out = new Map(m)
        out.set(row.articleId, {
          classification: r.current,
          overridden: true,
          version: r.version,
          lastUpdatedBy: r.updatedBy ?? row.lastUpdatedBy,
          lastUpdatedByName: r.updatedByName ?? r.updatedBy ?? row.lastUpdatedByName,
          lastUpdatedAt: r.updatedAt ?? row.lastUpdatedAt,
        })
        return out
      })
      setNotice({ tone: 'ok', text: `${row.articleName} is now ${r.current}. Recorded in its history.` })
    } catch (err) {
      setNotice({
        tone: 'warn',
        text:
          err.status === 409
            ? `${err.message} Nothing was changed.`
            : `The classification was not saved: ${err.message}`,
        reload: err.status === 409,
      })
    } finally {
      setSaving(null)
    }
  }

  /*
   * No column is locked - 23 Nov 2026, on request. Brand, Article and
   * Classification used to be `required`, so Build view greyed them out as
   * "always". Every column can now be ticked off; Reset in Build view brings
   * them all back.
   */
  const columns = useMemo(
    () => [
      {
        key: 'brand',
        label: 'Brand',
        group: 'id',
        render: (v) => (v ? <Pill>{v}</Pill> : dash()),
      },
      { key: 'articleId', label: 'Article', group: 'id', mono: true, autoWidth: true },
      { key: 'articleName', label: 'Name', group: 'id', autoWidth: true },
      {
        key: 'classification',
        label: 'Classification',
        group: 'id',
        width: 170,
        /*
         * Tinted apart from the Article group it sits in - 19 Nov 2026, on
         * request.
         *
         * It is the one column on this table a reader can CHANGE, and it was
         * shaded identically to the three identifiers beside it, so nothing
         * said so. A light red, paler than the accent tint the page uses for
         * failures - this column is editable, not wrong.
         */
        cell: 'mcm-col--class',
        hint:
          'Starts as Recipe when the article is in Recipe File SWiSH, otherwise Non-Recipe. A manual change is kept until someone changes it again - nothing overwrites it automatically.',
        render: (v, row) => {
          if (!row?.articleId) return v ?? ''
          return (
            <span className="mcm__class" onClick={(e) => e.stopPropagation()}>
              {canEdit || editBlocked ? (
                <select
                  className="field__input mcm__select"
                  value={v}
                  disabled={editBlocked || saving === row.articleId}
                  title={
                    editBlocked
                      ? 'Editing is switched off until the classification store (Snowflake) is connected on the server.'
                      : 'Change this article’s classification. The change is recorded in its history.'
                  }
                  aria-label={`Classification of ${row.articleName}`}
                  onChange={(e) => classify(row, e.target.value)}
                >
                  {CLASSIFICATIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <Pill tone={v === 'Recipe' ? 'green' : 'slate'}>{v}</Pill>
              )}
              {row.overridden ? (
                <span
                  className="mcm-tag mcm-tag--manual"
                  title={`Changed by hand from ${row.initialClassification}. Kept until someone changes it again.`}
                >
                  Manual
                </span>
              ) : null}
            </span>
          )
        },
      },
      { key: 'prev_theo', label: 'MC Theoretical', group: 'prev', num: true, autoWidth: true, render: qty, hint: 'Potential COS QTY - what MC’s own recipes say should have been used.' },
      { key: 'prev_actual', label: 'Consumption', group: 'prev', num: true, autoWidth: true, render: qty, hint: 'MC consumption - what stock says was actually used.' },
      { key: 'prev_acc', label: 'Accuracy %', group: 'prev', num: true, width: 170, render: accBarCell, hint: '1 − |consumption − theoretical| ÷ the larger of the two. Blank where MC holds no theoretical.' },
      { key: 'prev_var', label: 'Variance %', group: 'prev', num: true, autoWidth: true, render: pctCell, hint: '(consumption − theoretical) ÷ theoretical. Blank where the theoretical is zero or missing.' },
      { key: 'cur_theo', label: 'MC Theoretical', group: 'cur', num: true, autoWidth: true, render: qty, hint: 'MC’s theoretical posted so far this month.' },
      { key: 'cur_actual', label: 'Consumption', group: 'cur', num: true, autoWidth: true, render: qty, hint: 'Counted only when MC closes the month’s stock count; a dash until then.' },
      { key: 'cur_acc', label: 'Accuracy %', group: 'cur', num: true, width: 170, render: accBarCell },
      { key: 'cur_var', label: 'Variance %', group: 'cur', num: true, autoWidth: true, render: pctCell },
      {
        key: 'lastUpdated',
        label: 'Last updated',
        group: 'audit',
        autoWidth: true,
        render: (v, row) =>
          row?.articleId ? (
            <span className="mcm__audit">
              {v ? (
                <span title={row.lastUpdatedBy ? `Changed by ${row.lastUpdatedBy}` : undefined}>{v}</span>
              ) : (
                <span className="muted">Never changed</span>
              )}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={(e) => {
                  e.stopPropagation()
                  setHistoryFor(row)
                }}
                disabled={Boolean(storageError)}
              >
                History
              </button>
            </span>
          ) : (
            v ?? ''
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `classify` reads state through its arguments
    [canEdit, editBlocked, saving, storageError]
  )

  const groups = useMemo(
    () => ({
      id: 'Article',
      prev: `Previous — ${monthLabel(prev)}`,
      cur: `Current — ${monthLabel(cur)} (so far)`,
      audit: 'Audit',
    }),
    [cur, prev]
  )

  const alertRows = alerts.data?.alerts ?? []
  const alertCounts = useMemo(() => {
    const n = { sent: 0, pending: 0, failed: 0, baseline: 0 }
    for (const a of alertRows) n[a.status] = (n[a.status] ?? 0) + 1
    return n
  }, [alertRows])

  function clearAll() {
    setMonth(months[MONTH_OFFSET])
    setBrandFilter('All')
    setClassFilter('All')
    setSearch('')
    setPicked(null)
    setOnlyFlagged(false)
  }

  function exportCsv() {
    downloadCsv(
      `Monthly MC Analysis ${monthShort(cur)}.csv`,
      rows,
      [
        { key: 'brand', label: 'Brand' },
        { key: 'articleId', label: 'Article' },
        { key: 'articleName', label: 'Name' },
        { key: 'classification', label: 'Classification' },
        { key: 'initialClassification', label: 'Initial classification' },
        { key: 'prev_theo', label: `MC Theoretical ${monthLabel(prev)}` },
        { key: 'prev_actual', label: `Consumption ${monthLabel(prev)}` },
        { key: 'prev_acc', label: `Accuracy ${monthLabel(prev)}` },
        { key: 'prev_var', label: `Variance % ${monthLabel(prev)}` },
        { key: 'cur_theo', label: `MC Theoretical ${monthLabel(cur)} so far` },
        { key: 'cur_actual', label: `Consumption ${monthLabel(cur)} so far` },
        { key: 'cur_acc', label: `Accuracy ${monthLabel(cur)} so far` },
        { key: 'cur_var', label: `Variance % ${monthLabel(cur)} so far` },
        { key: 'lastUpdated', label: 'Last updated' },
      ],
      [
        ['Consumption', 'MC consumption - what stock says was actually used.'],
        ['Accuracy', '1 - |consumption - MC theoretical| / the larger of the two. Same as the Variance Analysis page.'],
        ['Variance %', '(consumption - MC theoretical) / MC theoretical. Blank where the theoretical is zero or missing.'],
        ['Classification', 'Initially Recipe if the article is in Recipe File SWiSH, otherwise Non-Recipe. Manual changes are kept.'],
      ]
    )
  }

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  const first = loading && !data
  const notLoaded = `MC has not loaded ${monthLabel(prev)} yet`
  const soFarLabel = `${monthShort(cur)} so far`

  /*
   * The filters, behind one pill - 19 Nov 2026, on request, to the pattern of
   * the SWiSH Analytics dashboard.
   *
   * Five controls sat open across the header and took the width the title
   * needed. They are the SAME five, with the same state and the same handlers:
   * only where they live has changed. The pill carries a summary so the current
   * selection is readable without opening anything, which is the whole point of
   * hiding them - a filter you cannot see is a filter you forget is on.
   */
  const filterSummary = [
    monthLabel(month),
    brandFilter === 'All' ? 'All brands' : brandFilter,
    classFilter === 'All' ? 'All classifications' : classFilter,
    onlyFlagged ? 'beyond ±20%' : null,
    picked ? picked.name : null,
    search.trim() ? `“${search.trim()}”` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  // An element, not a component: a component defined here would be a new type
  // on every render and the Article box would lose focus with each keystroke.
  const filterCard = (
    /*
     * Hover opens it, where there is a real pointer - 20 Nov 2026, to the
     * reference. A click still toggles, which is what a touch screen and a
     * keyboard get: `:hover` on a touch device sticks after a tap and would
     * leave the panel open with no way to dismiss it.
     *
     * Closing is DELAYED by 240ms. The flyouts sit beside the panel with a
     * gap between them, and the pointer crosses that gap on its way from a
     * row to its options - closing on `mouseleave` alone shut the panel
     * mid-journey every time.
     */
    <div
      className={`mcm-filterbar${filtersOpen ? ' mcm-filterbar--open' : ''}`}
      ref={filterRef}
      onMouseEnter={hoverOpen}
      onMouseLeave={hoverClose}
    >
      <button
        type="button"
        className="mcm-filterbar__pill"
        aria-expanded={filtersOpen}
        aria-haspopup="dialog"
        onClick={() => {
          setFiltersOpen((v) => !v)
          setMenu(null)
        }}
      >
        <span className="mcm-filterbar__badge" aria-hidden="true">
          <IconFilter size={15} />
        </span>
        <span className="mcm-filterbar__word">Filters</span>
        <span className="mcm-filterbar__rule" aria-hidden="true" />
        <span className="mcm-filterbar__summary" title={filterSummary}>
          {filterSummary}
        </span>
        <span className="mcm-filterbar__caret" aria-hidden="true">
          <IconChevron size={14} />
        </span>
      </button>

      {filtersOpen && (
        <div className="mcm-pop" role="dialog" aria-label="Filters">
          {/*
            * Drill-in rows, not inline controls - 19 Nov 2026, to the reference.
            *
            * Each row states its CURRENT value and opens a panel to the left to
            * change it, so the closed panel reads as a summary of what is on
            * rather than as a form to fill in. The flyout is the only place a
            * value is chosen, which is what keeps every row the same height and
            * the panel the same width whatever the value is.
            */}
          {/* Hovering a row opens its options, as in the reference. The
              Article row is deliberately excluded below: its panel autofocuses
              a text box, and stealing the caret on a pointer passing by is
              not the same kindness as showing a list. */}
          <div
            className={`mcm-pop__row${menu === 'month' ? ' mcm-pop__row--on' : ''}`}
            onMouseEnter={() => hoverable() && setMenu('month')}
          >
            <button
              type="button"
              className="mcm-pop__hit"
              aria-expanded={menu === 'month'}
              onClick={() => setMenu((m) => (m === 'month' ? null : 'month'))}
            >
              <span className="mcm-pop__icon" aria-hidden="true">
                <IconCalendar size={16} />
              </span>
              <span className="mcm-pop__label">Month</span>
              <span className="mcm-pop__value">{monthLabel(month)}</span>
              <span className="mcm-pop__more" aria-hidden="true">
                <IconChevron size={14} />
              </span>
            </button>
            {menu === 'month' && (
              <div className="mcm-sub" role="menu" aria-label="Month">
                {monthOptions.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="menuitemradio"
                    aria-checked={m === month}
                    className={`mcm-sub__opt${m === month ? ' mcm-sub__opt--on' : ''}`}
                    onClick={() => {
                      setMonth(m)
                      setMenu(null)
                    }}
                  >
                    <span>
                      {monthLabel(m)}
                      <span className="mcm-sub__hint">{whenLabel(m)}</span>
                    </span>
                    {m === month ? <span className="mcm-sub__dot" aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            className={`mcm-pop__row${menu === 'brand' ? ' mcm-pop__row--on' : ''}`}
            onMouseEnter={() => hoverable() && setMenu('brand')}
          >
            <button
              type="button"
              className="mcm-pop__hit"
              aria-expanded={menu === 'brand'}
              onClick={() => setMenu((m) => (m === 'brand' ? null : 'brand'))}
            >
              <span className="mcm-pop__icon" aria-hidden="true">
                <IconSummary size={16} />
              </span>
              <span className="mcm-pop__label">Brand</span>
              <span className="mcm-pop__value">{brandFilter}</span>
              <span className="mcm-pop__more" aria-hidden="true">
                <IconChevron size={14} />
              </span>
            </button>
            {menu === 'brand' && (
              <div className="mcm-sub" role="menu" aria-label="Brand">
                {brandOptions.map((b) => (
                  <button
                    key={b}
                    type="button"
                    role="menuitemradio"
                    aria-checked={b === brandFilter}
                    className={`mcm-sub__opt${b === brandFilter ? ' mcm-sub__opt--on' : ''}`}
                    onClick={() => {
                      setBrandFilter(b)
                      setMenu(null)
                    }}
                  >
                    <span>{b}</span>
                    {b === brandFilter ? <span className="mcm-sub__dot" aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            className={`mcm-pop__row${menu === 'class' ? ' mcm-pop__row--on' : ''}`}
            onMouseEnter={() => hoverable() && setMenu('class')}
          >
            <button
              type="button"
              className="mcm-pop__hit"
              aria-expanded={menu === 'class'}
              onClick={() => setMenu((m) => (m === 'class' ? null : 'class'))}
            >
              <span className="mcm-pop__icon" aria-hidden="true">
                <IconTable size={16} />
              </span>
              <span className="mcm-pop__label">Classification</span>
              <span className="mcm-pop__value">{classFilter}</span>
              <span className="mcm-pop__more" aria-hidden="true">
                <IconChevron size={14} />
              </span>
            </button>
            {menu === 'class' && (
              <div className="mcm-sub" role="menu" aria-label="Classification">
                {['All', ...CLASSIFICATIONS].map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="menuitemradio"
                    aria-checked={c === classFilter}
                    className={`mcm-sub__opt${c === classFilter ? ' mcm-sub__opt--on' : ''}`}
                    onClick={() => {
                      setClassFilter(c)
                      setMenu(null)
                    }}
                  >
                    <span>{c}</span>
                    {c === classFilter ? <span className="mcm-sub__dot" aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={`mcm-pop__row${menu === 'article' ? ' mcm-pop__row--on' : ''}`}>
            <button
              type="button"
              className="mcm-pop__hit"
              aria-expanded={menu === 'article'}
              onClick={() => setMenu((m) => (m === 'article' ? null : 'article'))}
            >
              <span className="mcm-pop__icon" aria-hidden="true">
                <IconBox size={16} />
              </span>
              <span className="mcm-pop__label">Article</span>
              <span className="mcm-pop__value">{picked?.name || search.trim() || 'Any'}</span>
              <span className="mcm-pop__more" aria-hidden="true">
                <IconChevron size={14} />
              </span>
            </button>
            {menu === 'article' && (
              <div className="mcm-sub mcm-sub--field">
                {/* autoFocus so the row and the cursor are one action, as a
                    reader who opened "Article" is about to type. */}
                <input
                  className="mcm-sub__input"
                  type="search"
                  value={search}
                  autoFocus
                  placeholder="Type a name or number…"
                  aria-label="Article number or name"
                  onChange={(e) => {
                    setSearch(e.target.value)
                    // Typing again means looking for something else.
                    if (picked) setPicked(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    // Enter on a single match picks it; otherwise it keeps the typed filter.
                    if (search.trim() && articleMatches.length === 1) {
                      setPicked(articleMatches[0])
                      setSearch('')
                    }
                    setMenu(null)
                  }}
                />
                {/*
                  * Every name in the month, narrowed as you type - 23 Nov 2026,
                  * on request. Picking one shows only that article.
                  */}
                <div className="mcm-sub__list" role="listbox" aria-label="Articles">
                  {articleMatches.length === 0 ? (
                    <p className="mcm-sub__none">No article matches “{search.trim()}”.</p>
                  ) : (
                    articleMatches.map((o) => {
                      const on = picked?.id === o.id
                      return (
                        <button
                          key={o.id}
                          type="button"
                          role="option"
                          aria-selected={on}
                          className={`mcm-sub__opt${on ? ' mcm-sub__opt--on' : ''}`}
                          title={`${o.name} · ${o.id}`}
                          onClick={() => {
                            setPicked(o)
                            setSearch('')
                            setMenu(null)
                          }}
                        >
                          <span className="mcm-sub__name">
                            {o.name}
                            <span className="mcm-sub__hint">{o.id}</span>
                          </span>
                          {on ? <span className="mcm-sub__dot" aria-hidden="true" /> : null}
                        </button>
                      )
                    })
                  )}
                </div>
                {articleOptions.length > articleMatches.length && articleMatches.length === 200 ? (
                  <p className="mcm-sub__none">Showing the first 200 - type more to narrow it.</p>
                ) : null}
                {search || picked ? (
                  <button
                    type="button"
                    className="mcm-sub__clear"
                    onClick={() => {
                      setSearch('')
                      setPicked(null)
                    }}
                  >
                    <IconClose size={12} />
                    Clear
                  </button>
                ) : null}
              </div>
            )}
          </div>

          {/* A switch, not a drill-in: there is nothing to choose between. */}
          <div className="mcm-pop__row">
            <button
              type="button"
              className="mcm-pop__hit"
              role="switch"
              aria-checked={onlyFlagged}
              onClick={() => setOnlyFlagged((v) => !v)}
            >
              <span className="mcm-pop__icon" aria-hidden="true">
                <IconAlert size={16} />
              </span>
              <span className="mcm-pop__label">Only beyond ±20%</span>
              <span className={`mcm-pop__switch${onlyFlagged ? ' mcm-pop__switch--on' : ''}`} aria-hidden="true">
                <span className="mcm-pop__knob" />
              </span>
            </button>
          </div>

          <div className="mcm-pop__foot">
            <button
              type="button"
              className="mcm-pop__reset"
              onClick={() => {
                clearAll()
                setMenu(null)
              }}
              disabled={!filtered && month === months[MONTH_OFFSET]}
            >
              <IconRefresh size={14} />
              Reset filters
            </button>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="mcm">
      {/* Title on the left, the filter card beside it on the right (20 Nov 2026, on request). */}
      <header className="mcm-head">
        <div className="mcm-head__text">
          <h1 className="mcm-head__title">Monthly MC Analysis</h1>
          <p className="mcm-head__date">
            {today}
            <span className="mcm-live">
              <span className="mcm-live__dot" aria-hidden="true" />
              Live Power BI
            </span>
          </p>
        </div>
        {filterCard}
      </header>

      <div className="mcm-toolbar">
        <div className="mcm-tabs" role="tablist" aria-label="View">
          {[
            ['analysis', 'MC Analysis'],
            ['brands', 'By Brand'],
            ['alerts', 'Variance Alerts'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              className={`mcm-tabs__tab${view === id ? ' mcm-tabs__tab--on' : ''}`}
              onClick={() => setView(id)}
            >
              {label}
              {id === 'alerts' && alertCounts.failed > 0 ? <span className="mcm-tabs__badge">{alertCounts.failed}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {storageError && (
        <InfoBanner tone="warn">
          <strong>Classifications are read-only.</strong> {storageError} The figures are live; every
          article shows its initial classification from Recipe File SWiSH until the classification
          store can be reached.
          {editBlocked
            ? ' You can change classifications with the Classification dropdown in each row of the table below, once it is connected.'
            : ''}
        </InfoBanner>
      )}
      {view !== 'alerts' && (
        <Section
          title={`${monthLabel(prev)} at a glance`}
          sub={`Each card shows ${monthLabel(prev)}, the last full month; beneath it, ${monthLabel(cur)} so far${filtered ? ' - over the articles the filters leave in' : ''}.`}
        >
          <div className="mcm-cards">
            <GlanceCard
              loading={first}
              icon={<IconInsight size={15} />}
              label="MC accuracy"
              value={glance.prev.accuracy === null ? '–' : fmtPct(glance.prev.accuracy, 1)}
              lastLabel={soFarLabel}
              last={soFar(glance.cur.accuracy === null ? null : fmtPct(glance.cur.accuracy, 1))}
              foot={prevLoaded ? undefined : notLoaded}
            />
            <GlanceCard
              loading={first}
              icon={<IconTable size={15} />}
              label="Article-brands measured"
              value={fmtInt(glance.prev.held)}
              lastLabel={soFarLabel}
              last={fmtInt(glance.cur.held)}
            />
            <GlanceCard
              loading={first}
              icon={<IconAlert size={15} />}
              label="Beyond ±20%"
              value={fmtInt(glance.prev.flagged)}
              lastLabel={soFarLabel}
              last={glance.cur.scored ? fmtInt(glance.cur.flagged) : soFar(null)}
            />
            <GlanceCard
              loading={first}
              icon={<IconCheck size={15} />}
              label="Within ±20%"
              value={fmtInt(glance.prev.within)}
              lastLabel={soFarLabel}
              last={glance.cur.scored ? fmtInt(glance.cur.within) : soFar(null)}
            />
            <GlanceCard
              loading={first}
              icon={<IconBox size={15} />}
              label="Recipe articles"
              value={fmtInt(glance.recipe)}
              foot={
                <>
                  of <strong>{fmtInt(glance.articles)}</strong> articles ·{' '}
                  <strong>{fmtInt(glance.articles - glance.recipe)}</strong> Non-Recipe
                </>
              }
            />
            <GlanceCard
              loading={first}
              icon={<IconSummary size={15} />}
              label="Overall variance %"
              value={glance.prev.variance === null ? '–' : fmtSignedPct(glance.prev.variance, 1)}
              lastLabel={soFarLabel}
              last={soFar(glance.cur.variance === null ? null : fmtSignedPct(glance.cur.variance, 1))}
              foot={prevLoaded ? undefined : notLoaded}
            />
          </div>
        </Section>
      )}

      {/*
        * The informational banners sit BELOW the cards - 19 Nov 2026, on
        * request. The figures are what the page is for, and three lines of
        * explanation above them pushed the glance row off the first screen.
        *
        * Only the informational ones moved. `storageError` and `ErrorBanner`
        * above still come first: a warning that the page is read-only has to
        * be read before the numbers, not after them.
        */}
      {!storageError && data?.storage === 'local' && canEdit && view === 'analysis' && (
        <InfoBanner>
          Change an article’s classification with the <strong>Classification</strong> dropdown in its
          row. Until Snowflake is connected, changes and their history are kept in the app’s own
          database and copied into Snowflake automatically once it is. Alert emails start then too.
        </InfoBanner>
      )}
      {!storageError && data && !canEdit && view === 'analysis' && (
        <InfoBanner>Only the Cost Controller department and administrators can change a classification.</InfoBanner>
      )}
      {data && view === 'analysis' && curTheoRows > 0 && curConsRows === 0 && (
        <InfoBanner>
          <strong>{monthLabel(cur)} so far:</strong> MC’s theoretical is shown for {fmtInt(curTheoRows)} article-brands
          (posted to date); the rest show a dash because MC has posted none for them this month. Consumption,
          accuracy and variance for {monthLabel(cur)} appear when MC closes the month’s stock count.
        </InfoBanner>
      )}
      {notice && (
        <InfoBanner tone={notice.tone === 'ok' ? 'info' : 'warn'}>
          {notice.text}{' '}
          {notice.reload && (
            <button type="button" className="btn btn--sm" onClick={reload}>
              Reload
            </button>
          )}
        </InfoBanner>
      )}

      {view === 'analysis' && (
        <Section
          title="Article by article"
          sub="One row per article per brand. A month MC has not loaded shows as a dash, never as zero. Sorted by the largest variance first."
        >
          <Card
            title="Articles by brand"
            aside={`${fmtInt(rows.length)} article-brands`}
            busy={loading && Boolean(data)}
            tools={
              <button type="button" className="btn btn--sm" disabled={!rows.length} onClick={exportCsv}>
                <IconDownload size={12} />
                CSV
              </button>
            }
          >
            {first ? (
              <div className="skel" style={{ height: 320 }} aria-hidden="true" />
            ) : rows.length === 0 ? (
              <Empty title="No article for these filters">
                MC holds no consumption for {monthLabel(cur)} or {monthLabel(prev)} on the brands selected,
                or the classification and article filters exclude every row.
              </Empty>
            ) : (
              <DataTable
                tableId="monthly-mc-analysis"
                columns={columns}
                rows={rows}
                groups={groups}
                freezable
                /*
                 * The table's own search, with names suggested as you type -
                 * 23 Nov 2026, on request, the same control as Stock Article's
                 * table. Works within whatever the Filters panel leaves in.
                 */
                searchPlaceholder="Search article or name…"
                suggest={{ label: 'articleName', code: 'articleId' }}
              />
            )}
          </Card>
          <Note>
            <strong>Read every figure against these definitions.</strong> MC Theoretical is Potential COS
            QTY, what MC’s own recipes say should have been used; Consumption is MC’s measured
            consumption, what stock says was actually used.{' '}
            <strong>Variance %</strong> is (consumption − theoretical) ÷ theoretical and{' '}
            <strong>Accuracy</strong> is 1 − |consumption − theoretical| ÷ the larger of the two, exactly as on
            the Variance Analysis page. Catering’s theoretical is excluded. The classification starts from
            Recipe File SWiSH; a manual change is kept and every change is recorded in the article’s
            history.
          </Note>
        </Section>
      )}

      {view === 'brands' && (
        <Section
          title="Where accuracy stands"
          sub={`Each brand’s MC accuracy for ${monthLabel(prev)}, the last full month, with how many article-brands sit beyond ±20% - and ${monthLabel(cur)} so far beside it.`}
        >
          <Card title="MC accuracy by brand" aside={monthShort(prev)} busy={loading && Boolean(data)}>
            {first ? (
              <div className="skel" style={{ height: 220 }} aria-hidden="true" />
            ) : (
              <div className="mcm-tablewrap">
                <table className="mcm-table">
                  <thead>
                    <tr>
                      <th>Brand</th>
                      <th className="num">Article-brands</th>
                      <th className="num">Scored</th>
                      <th className="num">Beyond ±20%</th>
                      <th className="num">Accuracy {monthShort(prev)}</th>
                      <th className="num">Accuracy {monthShort(cur)} so far</th>
                      <th className="mcm-table__barcol" aria-label="Accuracy bar" />
                    </tr>
                  </thead>
                  <tbody>
                    {byBrand.lines.map((l) => (
                      <BrandLine key={l.brand} line={l} />
                    ))}
                  </tbody>
                  <tfoot>
                    <BrandLine line={byBrand.total} total />
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
          <Note>
            <strong>Accuracy here is weighted by quantity.</strong> Every scored article-brand counts in
            proportion to the larger of its theoretical and consumption, so one beef portion outweighs a
            napkin — the same headline as the Variance Analysis page’s MC Match %. Units are mixed across
            articles, so no quantity is totalled on this page. A brand MC has not loaded for the month is
            marked rather than shown as 0%.
          </Note>
        </Section>
      )}

      {view === 'alerts' && (
        <>
          <Section
            title="Alerts at a glance"
            sub={`Article-brands beyond ±20% in ${monthLabel(cur)} or ${monthLabel(prev)}, and what happened to their email.`}
          >
            <div className="mcm-cards mcm-cards--four">
              <GlanceCard loading={alerts.loading && !alerts.data} icon={<IconCheck size={15} />} label="Emailed" value={fmtInt(alertCounts.sent)} foot="sent once, never repeated" />
              <GlanceCard loading={alerts.loading && !alerts.data} icon={<IconRefresh size={15} />} label="Waiting" value={fmtInt(alertCounts.pending)} foot="go out on the next daily run" />
              <GlanceCard loading={alerts.loading && !alerts.data} icon={<IconAlert size={15} />} label="Failed" value={fmtInt(alertCounts.failed)} foot="retried on the next run, up to 5 times" />
              <GlanceCard loading={alerts.loading && !alerts.data} icon={<IconTable size={15} />} label="Baseline" value={fmtInt(alertCounts.baseline)} foot="already beyond when alerts began" />
            </div>
          </Section>
          <Section title="Every alert" sub="Newest first. Hover a failed status for the delivery error.">
            <Card title="Variance alerts" aside={`${fmtInt(alertRows.length)} alerts`} busy={alerts.loading && Boolean(alerts.data)}>
              {alerts.data?.storage === 'local' ? (
                <Empty title="Alert emails start when Snowflake is connected">
                  Alert records are kept in Snowflake, which IT has not connected yet. Nothing is emailed
                  until then.
                </Empty>
              ) : storageError ? (
                <Empty title="Alerts are not available">
                  Alert records are kept in Snowflake, which this server cannot reach yet.
                </Empty>
              ) : alerts.error ? (
                <ErrorBanner error={alerts.error} onRetry={alerts.reload} />
              ) : alertRows.length === 0 ? (
                <Empty title="No alerts recorded for these months">
                  The daily run records an alert the first time an article-brand goes beyond ±20%.
                </Empty>
              ) : (
                <DataTable
                  tableId="monthly-mc-alerts"
                  columns={[
                    { key: 'brand', label: 'Brand', render: (v) => (v ? <Pill>{v}</Pill> : dash()) },
                    { key: 'articleId', label: 'Article', mono: true, autoWidth: true },
                    { key: 'articleName', label: 'Name', autoWidth: true },
                    { key: 'month', label: 'Month', render: (v) => monthLabel(v) },
                    { key: 'theoretical', label: 'MC Theoretical', num: true, render: qty },
                    { key: 'actual', label: 'Consumption', num: true, render: qty },
                    { key: 'variancePct', label: 'Variance %', num: true, render: pctCell },
                    {
                      key: 'status',
                      label: 'Status',
                      render: (v, r) => (
                        <span className={`mcm-tag mcm-tag--${v}`} title={r?.lastError ?? undefined}>
                          {v === 'failed' ? `Failed ×${r?.attempts ?? 1}` : v}
                        </span>
                      ),
                    },
                    { key: 'createdAt', label: 'Detected', render: (v) => when(v) ?? dash() },
                    { key: 'sentAt', label: 'Emailed', render: (v) => when(v) ?? dash() },
                  ]}
                  rows={alertRows}
                  searchPlaceholder="Search article or name…"
                />
              )}
            </Card>
            <Note>
              <strong>How alerts work.</strong> Once a day the server checks both months. An
              article-brand whose variance goes beyond ±20% is recorded once and included in that day’s
              single email to the Cost Controller department. It is never emailed again for the same
              month. Alerts only notify — <strong>no classification is ever changed automatically</strong>.
            </Note>
          </Section>
        </>
      )}

      {historyFor && <HistoryDialog row={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  )
}

function SignedCount({ n }) {
  if (!n) return null
  return <>{`${n > 0 ? '+' : '−'}${fmtInt(Math.abs(n))}`}</>
}

function Note({ children }) {
  return <div className="mcm-note">{children}</div>
}

function BrandLine({ line, total = false }) {
  // The previous (last full) month leads; the month in progress follows - 28 Nov 2026.
  const acc = line.prev.accuracy
  const loaded = line.prev.held > 0
  return (
    <tr className={total ? 'mcm-table__total' : undefined}>
      <td>{total ? line.brand : <Pill>{line.brand}</Pill>}</td>
      <td className="num">{fmtInt(line.rows)}</td>
      <td className="num">{loaded ? fmtInt(line.prev.scored) : '–'}</td>
      <td className="num">{loaded ? fmtInt(line.prev.flagged) : '–'}</td>
      <td className="num">{acc === null ? '–' : fmtPct(acc, 1)}</td>
      <td className="num">{line.cur.accuracy === null ? '–' : fmtPct(line.cur.accuracy, 1)}</td>
      <td className="mcm-table__barcol">
        {total ? null : loaded && acc !== null ? (
          <span className="mcm-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(acc * 100)}%` }} />
          </span>
        ) : (
          <span className="mcm-bar-wrap">
            <span className="mcm-bar" aria-hidden="true" />
            <span className="mcm-flag">Not loaded</span>
          </span>
        )}
      </td>
    </tr>
  )
}
