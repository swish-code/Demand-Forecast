import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { useData } from './useData.js'
import { SideNav } from './components/SideNav.jsx'
import { FilterBar } from './components/FilterBar.jsx'
import { ErrorBanner, InfoBanner } from './components/ui.jsx'
import { IconSummary, IconProduct, IconComponent, IconPlan, IconUsers } from './components/Icons.jsx'
/*
 * The pages are fetched when they are opened, not when the app starts.
 *
 * Everything was in one file: 743 kB of JavaScript, most of it the charting
 * library, which every visitor downloaded and parsed before the Overview could
 * paint — including the charts on four pages they had not opened and the admin
 * screens most of them cannot see at all.
 *
 * Named exports, so each import is mapped to the default shape lazy() expects.
 */
const lazyPage = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })))

const ForecastSummary = lazyPage(() => import('./pages/ForecastSummary.jsx'), 'ForecastSummary')
const ProductLevel = lazyPage(() => import('./pages/ProductLevel.jsx'), 'ProductLevel')
const ComponentLevel = lazyPage(() => import('./pages/ComponentLevel.jsx'), 'ComponentLevel')
const ProductionPlan = lazyPage(() => import('./pages/ProductionPlan.jsx'), 'ProductionPlan')
const Admin = lazyPage(() => import('./pages/Admin.jsx'), 'Admin')
const Guide = lazyPage(() => import('./pages/Guide.jsx'), 'Guide')

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
    // The Product PLU slicer is out at the moment, alongside its column —
    // asked for on 25 Aug 2026. Put 'articleName' back after 'product' to
    // restore it; the options are still built and returned by the server.
    slicers: ['location', 'product', 'date'],
  },
  {
    id: 'component',
    label: 'Ingredients',
    kicker: 'Prep and raw materials',
    blurb: 'Product articles, prep items and raw materials the forecast implies you need',
    Icon: IconComponent,
    Component: ComponentLevel,
    // 'article' is out with the rest of the PLU slicers — see Products above.
    // Recipe group came out on 1 Sep 2026 — asked for. The column is still in
    // the table; only the slicer is gone. Put 'recipeGroup' back in this list
    // and its row back in FilterBar's SLICERS to restore it.
    slicers: ['location', 'product', 'date', 'item', 'nodeType'],
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

  /*
   * The slicer selections, kept.
   *
   * They already lived above the pages, so switching tab never cleared them —
   * but a reload did, and every page rebuilt its own idea of the window. A
   * selection is a question somebody has asked, and it should still be the
   * question after they have gone to look at something else and come back.
   *
   * The defaults are deliberately not stored. They are what Reset goes back to
   * and what the date slicer names its preset from, and both are derived from
   * the model's calendar each time it loads — a stored copy would go stale the
   * day the calendar moved.
   */
  const FILTER_STORE = 'df-filters'
  const EMPTY_FILTERS = {
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
  }

  const [filters, setFilters] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_STORE) || 'null')
      if (saved && typeof saved === 'object') {
        // Only the keys this version knows about, so an older stored shape
        // cannot introduce a filter the server would refuse.
        const kept = {}
        for (const k of Object.keys(EMPTY_FILTERS)) {
          if (k === 'defaultFrom' || k === 'defaultTo') continue
          if (saved[k] !== undefined) kept[k] = saved[k]
        }
        return { ...EMPTY_FILTERS, ...kept }
      }
    } catch {
      /* a corrupt entry is not worth failing a page load over */
    }
    return EMPTY_FILTERS
  })

  useEffect(() => {
    try {
      const { defaultFrom, defaultTo, ...keep } = filters
      localStorage.setItem(FILTER_STORE, JSON.stringify(keep))
    } catch {
      /* a browser refusing storage should not break the page */
    }
  }, [filters])

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  // Brands come from the session, already narrowed to what this user may see.
  useEffect(() => {
    const list = session?.brands ?? []
    setBrands(list)
    setBrandCodes((codes) => {
      const kept = codes.filter((c) => list.some((b) => b.code === c))
      // Everything this account may see, not just the first brand — asked for
      // on 2 Sep 2026. Somebody who wants one brand picks one; somebody who
      // wants the whole business should not have to tick nine boxes to get it.
      return kept.length ? kept : list.map((b) => b.code)
    })
  }, [session])

  useEffect(() => {
    if (brandCodes.length) localStorage.setItem('df-brands', JSON.stringify(brandCodes))
  }, [brandCodes])

  // The admin tab is not merely hidden — a non-admin has no route to it, and
  // the server would refuse its requests anyway.
  /*
   * A department restricted to part of the recipe gets the pages that can
   * honour the restriction, and no others.
   *
   * Production type is a recipe-side attribute with no meaning against a
   * product total, so the Overview, Products and the prep plan would answer
   * with everything — the server refuses them for these accounts, and the rail
   * should not offer a tab that answers 403.
   */
  const pages = useMemo(() => {
    const allowed = session?.scope?.pages ?? null
    return PAGES.filter(
      (p) =>
        (!p.adminOnly || session?.user?.role === 'admin') &&
        (!allowed || allowed.includes(p.id) || (p.adminOnly && session?.user?.role === 'admin'))
    )
  }, [session])
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
    // A window restored from a previous visit is the reader's choice; the
    // default only fills in the defaults it is compared against.
    const restored = Boolean(filters.dateFrom && filters.dateTo)
    const end = iso(Math.max(new Date(today).getTime() - DAY, new Date(range.min).getTime()))
    /*
     * Month to date, not the last thirty days — asked for on 2 Sep 2026.
     *
     * Built exactly as the "Month to date" preset builds it, so the slicer opens
     * showing that name rather than a raw pair of dates. The month is the one
     * yesterday falls in, which on the first of a month is the month just gone —
     * the same day the rest of the page is measuring.
     */
    const from = iso(Math.max(new Date(`${end.slice(0, 7)}-01`).getTime(), new Date(range.min).getTime()))
    setFilters((f) => ({
      ...f,
      dateFrom: restored ? f.dateFrom : from,
      dateTo: restored ? f.dateTo : end,
      defaultFrom: from,
      defaultTo: end,
    }))
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
          <Suspense fallback={<div className="skel" style={{ height: 320, margin: 'var(--s4) 0' }} aria-hidden="true" />}>
          {page.adminOnly ? (
            <Admin session={session} />
          ) : (
            <>
          {/* Named on screen, because "the calculated columns are blank" is what
              an unset warehouse variable looks like from the outside. */}
          {health && health.mode !== 'demo' && health.missingWarehouse?.length > 0 && (
            <InfoBanner tone="warn">
              <strong>Outbound, Outbound MTD, Accuracy and WH forecast will be blank.</strong>{' '}
              <code>{health.missingWarehouse.join(', ')}</code>{' '}
              {health.missingWarehouse.length === 1 ? 'is' : 'are'} not set on this deployment, so
              Warehouse Analytics cannot be read.
            </InfoBanner>
          )}

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
              /*
               * Keyed on the page alone, not on the brand selection.
               *
               * With the brands in the key, every tick of a brand box threw the
               * whole page away and built it again: every memo discarded, every
               * chart's SVG destroyed and redrawn, every table re-sorted from
               * nothing — on a page that had only had two props change. It is
               * the single most expensive thing a brand click did, and it did
               * it before any data had even arrived. Filters flow in as props;
               * the data hook reacts to them; nothing needs remounting.
               */
              key={page.id}
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
          </Suspense>
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
