import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { useData } from './useData.js'
import { SideNav } from './components/SideNav.jsx'
import { FilterBar } from './components/FilterBar.jsx'
import { ErrorBanner, InfoBanner } from './components/ui.jsx'
import { IconSummary, IconProduct, IconComponent, IconPlan, IconUsers } from './components/Icons.jsx'
import { ForecastSummary } from './pages/ForecastSummary.jsx'
import { ProductLevel } from './pages/ProductLevel.jsx'
import { ComponentLevel } from './pages/ComponentLevel.jsx'
import { ProductionPlan } from './pages/ProductionPlan.jsx'
import { Admin } from './pages/Admin.jsx'
import { Guide } from './pages/Guide.jsx'

/** One entry per report page: rail label, rail kicker, blurb and slicers. */
const PAGES = [
  {
    id: 'summary',
    label: 'Overview',
    kicker: 'How we are tracking',
    blurb: 'Actual against forecast across the selected period',
    Icon: IconSummary,
    Component: ForecastSummary,
    slicers: ['location', 'product', 'date'],
  },
  {
    id: 'product',
    label: 'Products',
    kicker: 'Performance by product',
    blurb: 'What sold against what was forecast, product by product',
    Icon: IconProduct,
    Component: ProductLevel,
    // Product PLU sits beside Product: the same demand is counted at both
    // levels, and one product name covers several PLUs — Regular is four of
    // them — so narrowing to a single code is a question the table's own
    // search cannot answer. Listed by product name with the code beside it,
    // because a bare 83001108300117 is not something anybody recognises.
    slicers: ['location', 'product', 'articleName', 'date'],
  },
  {
    id: 'component',
    label: 'Ingredients',
    kicker: 'Prep and raw materials',
    blurb: 'Product articles, prep items and raw materials the forecast implies you need',
    Icon: IconComponent,
    Component: ComponentLevel,
    slicers: ['location', 'product', 'article', 'date', 'item', 'recipeGroup', 'nodeType'],
  },
  {
    id: 'production',
    label: "Tomorrow's Prep",
    kicker: 'Production plan',
    blurb: 'What each branch should prepare tomorrow',
    Icon: IconPlan,
    Component: ProductionPlan,
    // No article slicer: the plan table searches and sorts by article already,
    // and a branch reads this by product.
    slicers: ['location', 'product', 'date', 'prepStatus'],
  },
  {
    id: 'guide',
    label: 'Guide',
    kicker: 'How to use this app',
    blurb: 'What each page answers, how the daily email works, and what to check when a number looks wrong',
    Icon: IconSummary,
    Component: Guide,
    // Off the rail on purpose: it is one click from the Overview button, and a
    // permanent entry would sit above the reports competing with them.
    hidden: true,
    slicers: [],
  },
  {
    id: 'admin',
    label: 'Admin',
    kicker: 'Users and access',
    blurb: 'Accounts, alerts, the morning digest and the daily reports',
    Icon: IconUsers,
    Component: Admin,
    // Not a report page: no brand, no slicers, and only admins ever see the tab.
    slicers: [],
    adminOnly: true,
  },
]

const EMPTY_OPTIONS = {
  brands: [],
  locations: [],
  products: [],
  articles: [],
  articleNames: [],
  items: [],
  recipeGroups: [],
  nodeTypes: [],
  prepStatus: ['Extra Prep Needed', 'Normal', 'Reduced Prep Needed'],
  dateRange: {},
}

const DAY = 86_400_000
const iso = (d) => new Date(d).toISOString().slice(0, 10)

export default function App({ session, onSignedOut }) {
  const [tab, setTab] = useState('summary')
  const [mailboxResult, setMailboxResult] = useState(null)

  /*
   * What happened to the mailbox consent.
   *
   * Microsoft sends the browser back to the app with the outcome in the query
   * string. Nothing read it, so a consent that failed and one that worked both
   * looked identical — the Overview, as if the button had done nothing. It now
   * says which, and lands on the page where the mailbox lives.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('mailbox')
    if (!outcome) return
    setMailboxResult(
      outcome === 'connected'
        ? { tone: 'ok', text: `Connected. Reports will be sent as ${params.get('email') || 'that mailbox'}.` }
        : { tone: 'warn', text: `The mailbox was not connected. ${params.get('reason') || ''}`.trim() }
    )
    setTab('admin')
    window.history.replaceState({}, '', window.location.pathname)
  }, [])
  const [health, setHealth] = useState(null)
  const [brands, setBrands] = useState([])
  const [brandCodes, setBrandCodes] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('df-brands') || 'null')
      if (Array.isArray(saved) && saved.length) return saved
    } catch {
      /* a corrupt entry is not worth failing a page load over */
    }
    const legacy = localStorage.getItem('bbt-brand')
    return legacy ? [legacy] : []
  })
  const [updatedAt, setUpdatedAt] = useState(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [, forceTick] = useState(0)
  const pageRef = useRef(null)

  const [filters, setFilters] = useState({
    brands: [],
    locations: [],
    products: [],
    articles: [],
    items: [],
    recipeGroups: [],
    nodeTypes: [],
    prepStatus: [],
    dateFrom: undefined,
    dateTo: undefined,
    defaultFrom: undefined,
    defaultTo: undefined,
  })

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  // Brands come from the session, already narrowed to what this user may see.
  useEffect(() => {
    const list = session?.brands ?? []
    setBrands(list)
    setBrandCodes((codes) => {
      const kept = codes.filter((c) => list.some((b) => b.code === c))
      return kept.length ? kept : list[0] ? [list[0].code] : []
    })
  }, [session])

  useEffect(() => {
    if (brandCodes.length) localStorage.setItem('df-brands', JSON.stringify(brandCodes))
  }, [brandCodes])

  // The admin tab is not merely hidden — a non-admin has no route to it, and
  // the server would refuse its requests anyway.
  const pages = useMemo(
    () => PAGES.filter((p) => !p.adminOnly || session?.user?.role === 'admin'),
    [session]
  )
  const page = useMemo(() => pages.find((p) => p.id === tab) ?? pages[0], [tab, pages])
  // The rail shows the reports; the guide is reachable from the Overview.
  const navPages = useMemo(() => pages.filter((p) => !p.hidden), [pages])

  /**
   * Brand selects the semantic model rather than filtering a column, so it
   * travels with every request; several brands means several models queried and
   * their results added together.
   */
  const scoped = useMemo(() => ({ ...filters, brands: brandCodes }), [filters, brandCodes])

  /**
   * Which option list belongs to which slicer, and to which filter key.
   *
   * A list is fetched when the reader opens that slicer, or when a filter is
   * already set on it — a pill reading "3 selected" has to be able to name them.
   */
  const SLICER_LISTS = {
    location: { list: 'locations', filter: 'locations' },
    product: { list: 'products', filter: 'products' },
    article: { list: 'articles', filter: 'articles' },
    articleName: { list: 'articleNames', filter: 'articles' },
    item: { list: 'items', filter: 'items' },
    recipeGroup: { list: 'recipeGroups', filter: 'recipeGroups' },
    nodeType: { list: 'nodeTypes', filter: 'nodeTypes' },
    prepStatus: { list: 'prepStatus', filter: 'prepStatus' },
  }

  /**
   * Option lists are fetched on demand rather than on page load.
   *
   * Each list is its own DAX query against every selected model. The Ingredients
   * page carries six of them and the component list alone is ~2,700 values per
   * brand, so fetching all six up front cost about 4.6 seconds while the page's
   * own data took 1.1 — almost all of it for dropdowns nobody had opened.
   *
   * The set only grows. A list that has been fetched stays in the request, so
   * opening a second slicer does not drop the first one's values.
   */
  const [openedLists, setOpenedLists] = useState(() => new Set())
  const noteListOpened = useCallback((list) => {
    if (!list) return
    setOpenedLists((prev) => (prev.has(list) ? prev : new Set(prev).add(list)))
  }, [])

  // A filter set from elsewhere — a drill-through, a restored selection —
  // pulls its list in too, so the pill can show names instead of raw codes.
  useEffect(() => {
    const active = Object.values(SLICER_LISTS)
      .filter(({ filter }) => (filters[filter] ?? []).length > 0)
      .map(({ list }) => list)
    if (!active.length) return
    setOpenedLists((prev) => {
      const missing = active.filter((l) => !prev.has(l))
      if (!missing.length) return prev
      const next = new Set(prev)
      missing.forEach((l) => next.add(l))
      return next
    })
  }, [filters])

  const slicerNeed = useMemo(
    () =>
      (page?.slicers ?? [])
        .map((id) => SLICER_LISTS[id]?.list)
        .filter((list) => list && openedLists.has(list)),
    [page, openedLists]
  )

  const slicerRequest = useMemo(() => ({ ...scoped, need: slicerNeed }), [scoped, slicerNeed])
  const slicers = useData(api.slicers, slicerRequest, { enabled: brandCodes.length > 0 })
  const options = slicers.data ?? EMPTY_OPTIONS

  /**
   * Default the window to the last 30 days once the model's calendar is known.
   *
   * Ends yesterday, not today, and must stay in step with the "Last 30 days"
   * preset in the date slicer — today has only part of its sales recorded, and
   * a default that disagreed with the preset would show a raw date range
   * instead of the preset's name.
   */
  useEffect(() => {
    const range = slicers.data?.dateRange
    if (!range?.max || filters.defaultTo) return
    const today = range.today && range.today <= range.max ? range.today : range.max
    const end = iso(Math.max(new Date(today).getTime() - DAY, new Date(range.min).getTime()))
    const from = iso(Math.max(new Date(end).getTime() - 29 * DAY, new Date(range.min).getTime()))
    setFilters((f) => ({ ...f, dateFrom: from, dateTo: end, defaultFrom: from, defaultTo: end }))
  }, [slicers.data, filters.defaultTo])

  /**
   * Keep the user's selections when the brand changes.
   *
   * Clearing them was easier but wrong: picking a date, switching brand and
   * finding the date gone is the kind of small betrayal that makes a tool feel
   * unreliable. Instead the window is clamped into the new model's calendar,
   * and any location or product that does not exist in the new brand is
   * dropped — keeping a value the new model has never heard of would silently
   * filter the page down to nothing.
   */
  useEffect(() => {
    const range = slicers.data?.dateRange
    if (!range?.min || !range?.max) return

    setFilters((f) => {
      const clamp = (v) => (!v ? v : v < range.min ? range.min : v > range.max ? range.max : v)
      const trim = (values, allowed) => {
        if (!values?.length || !allowed?.length) return values ?? []
        const ok = new Set(
          allowed.map((o) => String(o !== null && typeof o === 'object' ? o.value : o))
        )
        const kept = values.filter((v) => ok.has(String(v)))
        return kept.length === values.length ? values : kept
      }

      const next = {
        ...f,
        dateFrom: clamp(f.dateFrom),
        dateTo: clamp(f.dateTo),
        defaultFrom: clamp(f.defaultFrom),
        defaultTo: clamp(f.defaultTo),
        locations: trim(f.locations, slicers.data.locations),
        products: trim(f.products, slicers.data.products),
        articles: trim(f.articles, slicers.data.articleNames?.length ? slicers.data.articleNames : slicers.data.articles),
        items: trim(f.items, slicers.data.items),
        recipeGroups: trim(f.recipeGroups, slicers.data.recipeGroups),
        nodeTypes: trim(f.nodeTypes, slicers.data.nodeTypes),
      }

      // Only commit when something actually moved, or this fires on every load.
      const same = Object.keys(next).every((k) =>
        Array.isArray(next[k]) ? next[k].length === (f[k]?.length ?? 0) : next[k] === f[k]
      )
      return same ? f : next
    })
  }, [slicers.data])

  const ready = Boolean(filters.defaultTo) || page.id === 'production'

  const markUpdated = useCallback(() => setUpdatedAt(Date.now()), [])

  // Re-render once a minute so "updated N mins ago" stays honest.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  /**
   * Drill-through: jump to another page with the clicked dimension applied, so
   * the user does not have to re-navigate and re-filter by hand.
   */
  const drill = useCallback((pageId, patch) => {
    setFilters((f) => ({ ...f, ...patch }))
    setTab(pageId)
  }, [])

  const refresh = async () => {
    await api.clearCache().catch(() => {})
    slicers.reload()
    setRefreshNonce((n) => n + 1)
  }

  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 })
  }, [tab])

  const today = options.dateRange?.today

  return (
    <div className="shell">
      <SideNav
        pages={navPages}
        active={tab}
        onSelect={setTab}
        health={health}
        lastUpdated={relativeTime(updatedAt)}
        onRefresh={refresh}
        user={session?.user}
        onSignOut={onSignedOut}
      />

      <div className="main">
        {/* Two fixed rows: what this page is, then what it is filtered to.
            Both stay put while the content scrolls, so the slicers are always
            reachable and the page never loses its name. */}
        <header className="pagehead">
          <div className="topbar__titles">
            <h1>{page.label}</h1>
            <p>{page.blurb}</p>
          </div>

          <div className="topbar__actions">
            {today && <span className="topbar__date">{longDate(today)}</span>}
          </div>
        </header>

        {page.slicers.length > 0 && (
          <div className="topbar">
            <FilterBar
              show={page.slicers}
              options={options}
              filters={scoped}
              setFilters={setFilters}
              loading={slicers.loading}
              brands={brands}
              selectedBrands={brandCodes}
              onBrandChange={setBrandCodes}
              onNeedOptions={noteListOpened}
            />
          </div>
        )}

        <div className="scroll" ref={pageRef}>
          {mailboxResult && (
            <InfoBanner tone={mailboxResult.tone === 'ok' ? 'info' : 'warn'}>
              {mailboxResult.text}
            </InfoBanner>
          )}
          {page.adminOnly ? (
            <Admin session={session} />
          ) : (
            <>
          {health && health.mode !== 'demo' && health.missingSettings?.length > 0 && (
            <InfoBanner tone="warn">
              Power BI mode is on but <code>{health.missingSettings.join(', ')}</code>{' '}
              {health.missingSettings.length === 1 ? 'is' : 'are'} not set in <code>.env</code>.
            </InfoBanner>
          )}

          {slicers.error ? (
            <ErrorBanner error={slicers.error} onRetry={slicers.reload} />
          ) : (
            <page.Component
              key={page.id + brandCodes.join(',')}
              filters={scoped}
              options={options}
              ready={ready}
              refreshNonce={refreshNonce}
              onLoaded={markUpdated}
              onDrill={drill}
            />
          )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function longDate(iso8601) {
  const d = new Date(`${String(iso8601).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' })
}

function relativeTime(ts) {
  if (!ts) return null
  const mins = Math.floor((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins === 1) return '1 min ago'
  if (mins < 60) return `${mins} mins ago`
  const hrs = Math.floor(mins / 60)
  return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`
}
