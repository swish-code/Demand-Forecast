import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { useData } from './useData.js'
import { SideNav } from './components/SideNav.jsx'
import { FilterBar, SLICERS } from './components/FilterBar.jsx'
import { ErrorBanner, InfoBanner } from './components/ui.jsx'
import { CalcInspector } from './components/CalcInspector.jsx'
import { GuideProduction } from './components/GuideProduction.jsx'
import {
  IconSummary,
  IconProduct,
  IconComponent,
  IconPlan,
  IconUsers,
  IconWarehouse,
  IconInsight,
  IconInfo,
} from './components/Icons.jsx'
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
const WarehouseInsights = lazyPage(
  () => import('./pages/WarehouseInsights.jsx'),
  'WarehouseInsights'
)
const WarehouseAnalysis = lazyPage(
  () => import('./pages/WarehouseAnalysis.jsx'),
  'WarehouseAnalysis'
)
const ProductionPlan = lazyPage(() => import('./pages/ProductionPlan.jsx'), 'ProductionPlan')
const Admin = lazyPage(() => import('./pages/Admin.jsx'), 'Admin')
const SalesPlan = lazyPage(() => import('./pages/SalesPlan.jsx'), 'SalesPlan')
const Guide = lazyPage(() => import('./pages/Guide.jsx'), 'Guide')

/** One entry per report page: rail label, rail kicker, blurb and slicers. */
/*
 * The production-source pages.
 *
 * Kept behind a flag rather than added and removed: they were switched off once
 * already while the classification was being validated, and two questions
 * behind them are still open - the CK/CPU split is unconfirmed by the business,
 * and the Unclassified articles have no agreed route yet. One line turns them
 * off again without touching anything they depend on.
 */
const PRODUCTION_SOURCE_PAGES_ON = true

/*
 * May the per-site pages show RAW articles? - 30 Sep 2026.
 *
 * A FLAG because this was switched on, off and on again within a few minutes,
 * and each round trip meant editing four page configs and three blurbs by hand.
 * One word changes it now.
 *
 * WHAT IT ACTUALLY CONTROLS
 *
 * Only whether the recipe explosion may return RAW rows for these pages. It is
 * not what defines them: `lockProdSource` is, and `withProductionSource`
 * filters every row to the site on the server, so the population stays correct
 * either way.
 *
 * ON  - a raw article the site handles carries its Product mix forecast.
 *       `TOMATO FRESH` 103000122 is the case that prompted it: measured over
 *       1-30 Sep 2026, nothing with the lock in place and 11,326.9 units
 *       without it, because the explosion never returned a RAW row and the
 *       article arrived only through the site-outbound path with nothing to put
 *       in PM Forecast.
 * OFF - PREP and PA only. The made-in-house half, and raw articles the site
 *       issues do not appear at all. Set this to false and also reword the
 *       three blurbs below, which say "Articles ... produces and issues".
 *
 * The Prod. type slicer is untouched either way, so a reader can always narrow
 * to the made-in-house half themselves.
 */
const RAW_ON_SITE_PAGES = true

/*
 * The Yelo Factory page - kept ON.
 *
 * Switched off and straight back on on 30 Sep 2026. The flag is left in place
 * because it is now the cheap way to do it: the id `src-factory` is what page
 * grants, saved column choices and the department rules are keyed on, so the
 * entry has to survive either way, and flipping one word beats editing the
 * entry twice.
 *
 * WORTH KNOWING BEFORE IT IS EVER TURNED OFF
 *
 * The `YELO Factory` DEPARTMENT is granted exactly this page and nothing else
 * (see DEPARTMENT_PAGES). With the page off, an account in that department
 * signs in to an EMPTY RAIL - the same failure `adminOnly` caused before these
 * pages were opened up. Grant those accounts another page first, or leave this
 * on.
 *
 * The page's all-destination Outbound rule lives in the API - see
 * `withSiteOutbound` - and is what makes this page's figures correct: every
 * Yelo Factory article sends 100% of its output to non-brand destinations, so a
 * brand-scoped total shows nothing at all.
 */
const YELO_FACTORY_PAGE_ON = true



/*
 * The Production page, off temporarily - 30 Sep 2026, on request.
 *
 * It is the combined view: every production source in one table. The four
 * per-site pages carved out of it stay on, and they cover the same articles
 * between them, so nothing is unreachable while this is off.
 *
 * Off by FLAG rather than by deleting the entry, exactly as the source pages
 * were when they were switched off during validation. The id `madeinhouse` is
 * what page grants, saved column choices and the department rules are keyed on,
 * so the entry has to survive: set this back to true and the page returns with
 * every grant and every saved Build view intact.
 *
 * Nothing on the server was touched. `madeinhouse` stays in COMPONENT_PAGES and
 * in PAGE_IDS, so an account that still carries an explicit grant for it is not
 * quietly broken - it simply has no tab until this comes back.
 */
const PRODUCTION_PAGE_ON = false

/*
 * The pages that carry the production guide panel.
 *
 * Listed by id rather than tested on `noWarehouse`, because that flag is a
 * property of the page component and this is a property of the rail.
 */
const PRODUCTION_PAGES = new Set(['madeinhouse', 'src-ck', 'src-bakery', 'src-factory', 'src-none'])

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
    label: 'Stock Article',
    kicker: 'Prep and raw materials',
    blurb: 'Product articles, prep items and raw materials the forecast implies you need',
    Icon: IconComponent,
    Component: ComponentLevel,
    // 'article' is out with the rest of the PLU slicers — see Products above.
    // Recipe group came out on 1 Sep 2026 — asked for. The column is still in
    // the table; only the slicer is gone. Put 'recipeGroup' back in this list
    // and its row back in FilterBar's SLICERS to restore it.
    /*
     * RAW only, from 27 Sep 2026.
     *
     * The page held all three production types, so a reader asking "what do we
     * need to BUY" was reading prep steps and prepared articles alongside the
     * things a supplier delivers - three different questions in one table. The
     * made-in-house half moved to its own page; `lockNodeTypes` is what keeps
     * this one to the bought half, whatever the slicer is set to.
     *
     * The nodeType slicer goes with them: a slicer that can only pick the one
     * value already forced is a control that does nothing.
     */
    lockNodeTypes: ['RAW'],
    slicers: ['location', 'product', 'date', 'item', 'category', 'supply', 'recipeKind', 'status'],
  },
  ...(PRODUCTION_PAGE_ON
    ? [
  {
    /*
     * The other half of what Stock Article used to hold.
     *
     * PREP is a kitchen step and PA is a prepared article the ERP stocks. They
     * belong together and apart from RAW: these are things the kitchens MAKE,
     * where RAW is what somebody BUYS. The same table and the same figures -
     * only the population differs - so it reuses the page rather than forking
     * it, and any fix to one lands on both.
     *
     * The nodeType slicer stays, narrowed to these two by `lockNodeTypes`, so
     * a reader can still look at PREP alone or PA alone.
     */
    /*
     * The id stays `madeinhouse` while the label reads "Production".
     *
     * Renamed on 27 Sep 2026. The id is what page grants, saved column choices
     * and the department rules are keyed on, so changing it would silently
     * revoke access and reset everyone's Build view. A label is what the
     * reader sees; an id is what the system remembers, and only one of them is
     * free to change.
     *
     * Worth knowing there is already a page with the ID `production` -
     * Tomorrow's Prep, whose kicker is "Production plan". Different page,
     * different id, no clash; just do not read the two as the same thing.
     */
    id: 'madeinhouse',
    label: 'Production',
    kicker: 'Prep steps and prepared articles',
    /*
     * Two words, on request.
     *
     * Two longer versions were tried on 27 Sep 2026 and both were wrong in the
     * same way: the first described the POPULATION ("what the kitchens make
     * rather than buy"), the second described the MEASURE ("how much of each
     * prep step the forecast calls for"), and the strip truncates at around
     * seventy characters anyway, so neither finished its own sentence. The page
     * is a production plan. The kicker underneath already names the rows.
     */
    blurb: 'Production plan',
    Icon: IconComponent,
    Component: ComponentLevel,
    lockNodeTypes: ['PREP', 'PA'],
    /*
     * The warehouse half of the page does not apply here.
     *
     * Outbound measures what the CENTRAL WAREHOUSE issued to the shops. A prep
     * step is not a stocked article at all and a prepared article reaches the
     * shops inside something else, so the warehouse columns are blank or
     * misleading on almost every row - and the cards built on them were being
     * read as a performance figure for a process the warehouse never touches.
     *
     * Stock Article keeps all of it: that page is the bought half, which is
     * exactly what the warehouse ships.
     */
    noWarehouse: true,
    /*
     * Admin only for now - asked for on 28 Sep 2026.
     *
     * The page is new and the figures behind it are still moving: the article
     * path was rebuilt to derive from the planned products this week, and the
     * component copy still has a stale-future-months defect open against it.
     * Keeping it to the people maintaining those numbers until they settle.
     *
     * Same mechanism as Forecast Insights and Sales plan, so a per-account
     * grant still opens it without changing this - see the page filter in App.
     */
    adminOnly: true,
    /*
     * Three slicers fewer than Stock Article, dropped on 27 Sep 2026.
     *
     * Status is worked out from how long ago the CENTRAL WAREHOUSE last issued
     * an article, and Category is the warehouse's own grouping - both describe
     * the shipping side this page has just stopped showing, so they filtered on
     * evidence the reader could no longer see. Product is the menu item the
     * forecast came from, which narrows by something the table does not have a
     * column for: it is a recipe-line table, and Item and Recipe Group are the
     * two handles on it that do.
     */
    slicers: ['location', 'date', 'item', 'nodeType', 'supply', 'recipeKind'],
  },
      ]
    : []),
  ...(PRODUCTION_SOURCE_PAGES_ON
    ? [
    {
      id: 'src-ck',
      /*
       * "Production", renamed 30 Sep 2026. Previously "CK/CPU", and "Central
       * Kitchen" before that.
       *
       * The page covers both cost centres - the classification groups them,
       * because the 28 Sep audit found them to be one centre renamed in early
       * 2026 - so neither "Central Kitchen" nor "CPU" alone described it. It is
       * now simply the production plan for the articles this site makes.
       *
       * The id stays `src-ck` through all three names: page grants, saved column
       * choices and the department rules are keyed on it, so changing it would
       * silently revoke access and reset everyone's Build view. The Production
       * DEPARTMENT is granted `src-ck`, so its name and this page's now agree,
       * which is what the rename was for.
       *
       * Worth knowing: the combined page with id `madeinhouse` also carries the
       * label "Production". It is switched off - see PRODUCTION_PAGE_ON - so
       * there is no clash today, but turning it back on would put two tabs
       * called Production in the rail. Rename one of them at that point.
       */
      label: 'Production',
      kicker: 'By production source',
      blurb: 'Articles the central kitchen produces and issues',
      Icon: IconComponent,
      Component: ComponentLevel,
      /*
       * The same page as Production, pinned to one production source.
       *
       * Classified from the movement facts - where an article has actually been
       * issued from - rather than from anything on the recipe, which does not
       * say where a thing is made. See `productionSource.js` for the audit
       * behind the rules and what is still unconfirmed.
       */
      lockProdSource: 'Central Kitchen / CPU',
      ...(RAW_ON_SITE_PAGES ? {} : { lockNodeTypes: ['PREP', 'PA'] }),
      noWarehouse: true,
      /*
       * Opened to its own department on 29 Sep 2026.
       *
       * It was admin-only while the classification was being validated. The
       * department that works at this site now holds this page and nothing
       * else, and `adminOnly` would have hidden the only tab those accounts
       * have - the flag is not overridden by a department default, only by the
       * Sales Plan's explicit scope. The narrowing still holds: the server
       * derives the production sources an account may see from the same grant.
       *
       * Unclassified keeps the flag. Nobody has been given it, and its
       * population is the articles no rule could place - which is a question
       * for whoever maintains the classification, not a site's work list.
       */
      slicers: ['location', 'date', 'item', 'nodeType', 'supply', 'recipeKind'],
    },
    {
      id: 'src-bakery',
      // "Swish Bakery", renamed 29 Sep 2026 - the cost centre's own name, which
      // is what the classification matches on. The id stays `src-bakery`, for
      // the reason given on CK/CPU above.
      label: 'Swish Bakery',
      kicker: 'By production source',
      blurb: 'Articles Swish Bakery produces and issues',
      Icon: IconComponent,
      Component: ComponentLevel,
      /*
       * The same page as Production, pinned to one production source.
       *
       * Classified from the movement facts - where an article has actually been
       * issued from - rather than from anything on the recipe, which does not
       * say where a thing is made. See `productionSource.js` for the audit
       * behind the rules and what is still unconfirmed.
       */
      lockProdSource: 'Bakery',
      ...(RAW_ON_SITE_PAGES ? {} : { lockNodeTypes: ['PREP', 'PA'] }),
      noWarehouse: true,
      /*
       * Opened to its own department on 29 Sep 2026.
       *
       * It was admin-only while the classification was being validated. The
       * department that works at this site now holds this page and nothing
       * else, and `adminOnly` would have hidden the only tab those accounts
       * have - the flag is not overridden by a department default, only by the
       * Sales Plan's explicit scope. The narrowing still holds: the server
       * derives the production sources an account may see from the same grant.
       *
       * Unclassified keeps the flag. Nobody has been given it, and its
       * population is the articles no rule could place - which is a question
       * for whoever maintains the classification, not a site's work list.
       */
      slicers: ['location', 'date', 'item', 'nodeType', 'supply', 'recipeKind'],
    },
    ...(YELO_FACTORY_PAGE_ON
      ? [
    {
      id: 'src-factory',
      label: 'YELO Factory',
      kicker: 'By production source',
      blurb: 'Articles the Yelo Factory produces and issues',
      Icon: IconComponent,
      Component: ComponentLevel,
      /*
       * The same page as Production, pinned to one production source.
       *
       * Classified from the movement facts - where an article has actually been
       * issued from - rather than from anything on the recipe, which does not
       * say where a thing is made. See `productionSource.js` for the audit
       * behind the rules and what is still unconfirmed.
       */
      lockProdSource: 'YELO Factory',
      ...(RAW_ON_SITE_PAGES ? {} : { lockNodeTypes: ['PREP', 'PA'] }),
      noWarehouse: true,
      /*
       * Opened to its own department on 29 Sep 2026.
       *
       * It was admin-only while the classification was being validated. The
       * department that works at this site now holds this page and nothing
       * else, and `adminOnly` would have hidden the only tab those accounts
       * have - the flag is not overridden by a department default, only by the
       * Sales Plan's explicit scope. The narrowing still holds: the server
       * derives the production sources an account may see from the same grant.
       *
       * Unclassified keeps the flag. Nobody has been given it, and its
       * population is the articles no rule could place - which is a question
       * for whoever maintains the classification, not a site's work list.
       */
      slicers: ['location', 'date', 'item', 'nodeType', 'supply', 'recipeKind'],
    },
        ]
      : []),
    {
      id: 'src-none',
      label: 'Unclassified',
      kicker: 'By production source',
      blurb: 'Articles with no production-site movement to classify them by',
      Icon: IconComponent,
      Component: ComponentLevel,
      /*
       * The same page as Production, pinned to one production source.
       *
       * Classified from the movement facts - where an article has actually been
       * issued from - rather than from anything on the recipe, which does not
       * say where a thing is made. See `productionSource.js` for the audit
       * behind the rules and what is still unconfirmed.
       */
      lockProdSource: 'Unclassified',
      ...(RAW_ON_SITE_PAGES ? {} : { lockNodeTypes: ['PREP', 'PA'] }),
      noWarehouse: true,
      // Admin only while the classification is still being validated, exactly
      // as the Production page it is carved out of.
      adminOnly: true,
      slicers: ['location', 'date', 'item', 'nodeType', 'supply', 'recipeKind'],
    },
      ]
    : []),
  {
    id: 'warehouse',
    label: 'Warehouse Insights',
    kicker: 'Forecast against outbound',
    blurb: 'How well the warehouse forecast matched what actually left it, article by article',
    Icon: IconWarehouse,
    Component: WarehouseInsights,
    /*
     * The same slicers as Stock Article, and for the same reason: this page
     * reads the same endpoint. Product type is here as `nodeType`, and supply
     * is the two fixed values the outbound copy decides between — there is no
     * second supply field anywhere.
     */
    slicers: ['location', 'product', 'date', 'item', 'nodeType', 'supply'],
  },
  {
    id: 'wh-analysis',
    label: 'Forecast Insights',
    kicker: 'Findings and recommendations',
    blurb: 'Why the warehouse forecast misses, which articles are responsible, and what to change',
    Icon: IconInsight,
    Component: WarehouseAnalysis,
    // Not a report anybody orders from — it explains the method, so it is for
    // the people who maintain it.
    adminOnly: true,
    slicers: ['location', 'product', 'date', 'item', 'nodeType', 'supply'],
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
    kicker: 'How to use this page',
    blurb: 'A step-by-step walkthrough of Stock Article',
    Icon: IconSummary,
    Component: Guide,
    // Off the rail on purpose: it is one click from the Overview button, and a
    // permanent entry would sit above the reports competing with them.
    hidden: true,
    slicers: [],
  },
  {
    id: 'sales-plan',
    label: 'Sales plan',
    kicker: 'Next year, by hand',
    blurb: 'Brand sales for a year the forecast models do not reach',
    Icon: IconUsers,
    Component: SalesPlan,
    // Not a report page: the figures are per brand for a whole year, so no
    // brand picker and no slicers. Admin only, like the other page that writes.
    slicers: [],
    adminOnly: true,
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
  categories: [],
  // Fixed, not fetched: the two answers are computed from the outbound copy.
  supply: ['Warehouse', 'Direct Supply'],
  // Fixed too: a row either has a recipe behind it or it does not.
  recipeKinds: ['Recipe', 'Non-recipe'],
  /*
   * The five statuses from Swish SPS V3 2026, in ladder order.
   *
   * Fixed rather than fetched: they are worked out from how long ago the
   * warehouse last issued each article, so there is nothing to look up and the
   * order is the ladder rather than the alphabet.
   */
  statuses: [
    'Active',
    'Slow-Moving',
    'Super Slow-Moving',
    'Non-Moving',
    'To Be Deactivated',
    'Never shipped',
  ],
  prepStatus: ['Extra Prep Needed', 'Normal', 'Reduced Prep Needed'],
  dateRange: {},
}

const DAY = 86_400_000
const iso = (d) => new Date(d).toISOString().slice(0, 10)

export default function App({ session, onSignedOut }) {
  const [tab, setTab] = useState('summary')

  /*
   * Whether the rail is collapsed, remembered per person.
   *
   * A table fourteen columns wide wants the width more than the reader wants
   * the page names, and which of those matters is not something to decide for
   * them. A reader granted a single page still starts collapsed, because a rail
   * of one is a label rather than a navigation.
   */
  /*
   * Whether the calculations inspector is open.
   *
   * Reset whenever the page changes: the panel describes what is on screen, and
   * a selection made on the Overview means nothing on Stock Article.
   */
  const [inspecting, setInspecting] = useState(false)

  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem('df-nav-collapsed') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('df-nav-collapsed', navCollapsed ? '1' : '0')
    } catch {
      /* a browser refusing storage should not break the page */
    }
  }, [navCollapsed])
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
    categories: [],
    supply: [],
    recipeKinds: [],
    statuses: [],
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
    const isAdmin = session?.user?.role === 'admin'
    /*
     * An admin-only page can still be reached by an explicit grant, from
     * 24 Sep 2026 — Finance holds the Sales Plan and nothing else.
     *
     * `adminOnly` used to mean two things at once: "this page writes" and "only
     * administrators may open it". Those came apart when a department was
     * granted a writing page, and the flag alone would have hidden the only tab
     * that account has, leaving it signed in with an empty rail.
     *
     * The grant is what opens it, not the flag, and the server's own guard on
     * that router names the same page — so the rail cannot offer a tab the API
     * would refuse, which is the failure this check exists to prevent.
     */
    /*
     * The Sales Plan is asked by its own flag, not read off `pages`.
     *
     * `pages` falls through to every report page for an unrestricted account,
     * so testing it here would show the tab to Marketing and to anyone with no
     * department — and the router behind it would refuse them. The server
     * decides with the same function its guard uses and sends the answer.
     */
    const granted = (p) => (p.id === 'sales-plan' ? Boolean(session?.scope?.salesPlan) : false)
    return PAGES.filter(
      (p) => (!p.adminOnly || isAdmin || granted(p)) && (!allowed || allowed.includes(p.id) || isAdmin)
    )
  }, [session])
  const page = useMemo(() => pages.find((p) => p.id === tab) ?? pages[0], [tab, pages])
  // Which page's guide panel is open, or null. Holds the LABEL, so the panel
  // can name the page it is describing.
  const [guideFor, setGuideFor] = useState(null)

  /*
   * A tab the account may not open does not stay selected.
   *
   * `page` already falls back to the first allowed one, so nothing forbidden
   * ever rendered — but `tab` kept the old id, so the rail highlighted nothing
   * and the next render resolved the fallback again. Correcting the state means
   * the rail agrees with the page, and a grant taken away while somebody is
   * looking at that page moves them somewhere they can actually be.
   */
  useEffect(() => {
    if (pages.length && !pages.some((p) => p.id === tab)) setTab(pages[0].id)
  }, [pages, tab])

  useEffect(() => setInspecting(false), [tab])
  // The rail shows the reports; the guide is reachable from the Overview.
  const navPages = useMemo(() => pages.filter((p) => !p.hidden), [pages])

  /**
   * Brand selects the semantic model rather than filtering a column, so it
   * travels with every request; several brands means several models queried and
   * their results added together.
   */
  /*
   * A page may pin the production types it is about.
   *
   * Stock Article is the bought half, Made In-House the made half. The lock is
   * INTERSECTED with whatever the reader picked rather than replacing it, so a
   * slicer still narrows within the page and can never widen past it - picking
   * PA on Made In-House gives PA, and there is no selection that reaches RAW.
   *
   * Applied here, on the filters every page and every request reads, so the
   * table, the cards, the slicer lists and the CSV are all the same population
   * without any of them knowing a lock exists.
   */

  const scoped = useMemo(() => {
    /*
     * Only the filters this page actually offers a control for.
     *
     * Filter state is shared across every page and saved in the browser, so a
     * Category or Status chosen on Stock Article kept narrowing Production -
     * which shows neither slicer, so there was no way to see it or clear it.
     * The page simply looked short, and it differed between browsers because
     * the saved state did. Chased for several rounds as an access problem on
     * 30 Sep 2026: two accounts, same filters on screen, 691 articles against
     * 187, and the request logging only covered the five fields that matched.
     *
     * A page that does not show a control must not be filtered by it. The
     * `supply` special case below predates this and is the same bug, fixed one
     * page at a time; this is the general rule.
     *
     * Dates, brands and anything the PAGE pins are untouched - those are not
     * slicers the reader chose.
     */
    const offered = new Set(
      SLICERS.filter((sl) => page?.slicers?.includes(sl.id)).map((sl) => sl.key)
    )
    const droppable = new Set(SLICERS.map((sl) => sl.key))
    const chosen = {}
    for (const [k, v] of Object.entries(filters)) {
      if (droppable.has(k) && !offered.has(k)) continue
      chosen[k] = v
    }

    const base = { ...chosen, brands: brandCodes }
    /*
     * A Warehouse supply selection does not follow the reader onto Production.
     *
     * Filter state is shared across pages - that is why the node-type lock below
     * has to intersect rather than assume. Pick Warehouse on Stock Article, walk
     * to Production, and the page would apply a filter its own slicer no longer
     * offers and empty itself. Dropped here, on the same page that hides the
     * option, so the two cannot disagree.
     */
    if (base.supply?.length) {
      const barred = page?.noWarehouse ? 'Warehouse' : 'Made In-House'
      base.supply = base.supply.filter((s) => String(s) !== barred)
    }
    /*
     * The production-source pages pin their own category.
     *
     * Same idea as `lockNodeTypes`: the page decides the population and the
     * slicers narrow within it, so the table, the cards, the CSV and the
     * option lists all see one set without any of them knowing a lock exists.
     */
    if (page?.lockProdSource) base.prodSources = [page.lockProdSource]
    const lock = page?.lockNodeTypes
    if (!lock?.length) return base
    const picked = base.nodeTypes ?? []
    const within = picked.filter((t) => lock.includes(String(t)))
    return { ...base, nodeTypes: within.length ? within : lock }
  }, [filters, brandCodes, page])

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
    category: { list: 'categories', filter: 'categories' },
    supply: { list: 'supply', filter: 'supply' },
    recipeKind: { list: 'recipeKinds', filter: 'recipeKinds' },
    status: { list: 'statuses', filter: 'statuses' },
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
  /*
   * The server's lists, over the defaults — not instead of them.
   *
   * `slicers.data ?? EMPTY_OPTIONS` looked equivalent and was not: the moment
   * the fetch resolved, the whole defaults object was replaced by a response
   * that has no `supply` key, because supply is not a column anything queries —
   * it is derived from whether the warehouse has shipped the article. So the
   * slicer read `undefined` and said "No values available", but only after the
   * data arrived, which is the window nobody looks at it in.
   *
   * Merging keeps the fixed lists present and still lets every fetched list
   * win. Supply is reasserted afterwards so a future response carrying an empty
   * one cannot blank it again.
   */
  const options = useMemo(
    () => ({
      ...EMPTY_OPTIONS,
      ...(slicers.data ?? {}),
      supply: EMPTY_OPTIONS.supply,
      statuses: EMPTY_OPTIONS.statuses,
      recipeKinds: EMPTY_OPTIONS.recipeKinds,
    }),
    [slicers.data]
  )

  /*
   * The production-type slicer offers only what the page admits.
   *
   * Without this, Made In-House would still list RAW. Picking it is harmless -
   * `scoped` intersects the choice with the lock and falls back to the lock -
   * but an option that cannot change anything is a control that lies about
   * what it does.
   */
  /*
   * ...and the supply slicer drops Warehouse for the same reason.
   *
   * Warehouse supply means RAW. A warehouse issues the chicken, not the brined
   * chicken breast, so on a page locked to PREP and PA the option can only ever
   * return nothing - and the server enforces exactly that, narrowing a Warehouse
   * selection to RAW rows. Offering it there is a control that empties the
   * table, which is how it was first reported.
   *
   * Keyed on the page's own `noWarehouse` flag, which only Production carries,
   * so no other page's Supply slicer can change because of this.
   */
  const shownOptions = useMemo(() => {
    const lock = page?.lockNodeTypes
    const next = { ...options }
    if (lock?.length && options?.nodeTypes?.length) {
      next.nodeTypes = options.nodeTypes.filter((t) => lock.includes(String(t)))
    }
    /*
     * Warehouse out, Made In-House in - a swap, not a removal.
     *
     * Taking Warehouse away left the slicer with a single value, so there was
     * no way to ask for anything other than Direct Supply. Made In-House is
     * that other side: the server reads it as "not Direct Supply", which on
     * this page means the prep steps and prepared articles made on site,
     * including the ones carrying no supply label at all.
     */
    if (page?.noWarehouse && next.supply?.length) {
      next.supply = [...next.supply.filter((s) => String(s) !== 'Warehouse'), 'Made In-House']
    }
    return next
  }, [options, page])

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
        categories: trim(f.categories, slicers.data.categories),
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
      {/*
        * One granted page is still a rail, not a strip.
        *
        * This used to force the collapsed state whenever the account had a
        * single tab, and withhold the toggle with it — the reasoning being that
        * one icon needs no label. What it produced was a 60px column of rail
        * colour holding one unlabelled icon, with nothing to click to widen it:
        * the page had no name, the status line and the sign-out label were both
        * hidden with the rest of the collapsed chrome, and the reader could not
        * undo any of it. An account with one page now gets the same rail as
        * everybody else and the same toggle, so narrow is a choice they make
        * rather than a state they are put in.
        *
        * The "Reports" heading is still held back for a single page — see
        * SideNav. A divider separating one item from nothing is a different
        * question from how wide the rail is.
        */}
      <SideNav
        collapsed={navCollapsed}
        onToggle={() => setNavCollapsed((v) => !v)}
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
            {/*
              * Administrators only, because it is a troubleshooting tool rather
              * than part of reading the page — and because the catalogue it
              * opens is served from an admin route, so offering it to anybody
              * else would be a button that answers 403.
              */}
            {session?.user?.role === 'admin' && page.slicers.length > 0 && (
              <button
                type="button"
                className={`btn btn--ghost${inspecting ? ' btn--on' : ''}`}
                onClick={() => setInspecting((v) => !v)}
                title="Show the measures behind each visual on this page"
                aria-pressed={inspecting}
              >
                {inspecting ? 'Done' : 'Calculations'}
              </button>
            )}
          </div>
        </header>

        {page.slicers.length > 0 && (
          <div className="topbar">
            <FilterBar
              show={page.slicers}
              options={shownOptions}
              filters={scoped}
              setFilters={setFilters}
              loading={slicers.loading}
              brands={brands}
              selectedBrands={brandCodes}
              onBrandChange={setBrandCodes}
              onNeedOptions={noteListOpened}
              tools={
                page.id === 'component' ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => drill('guide', {})}
                    title="A step-by-step walkthrough of this page"
                  >
                    <IconInfo size={13} />
                    How to use this page
                  </button>
                ) : PRODUCTION_PAGES.has(page.id) ? (
                  /*
                    * The production pages open a PANEL rather than navigating.
                    *
                    * Stock Article's walkthrough is its own page, `guide`, and
                    * these pages cannot use it: from 29 Sep 2026 the three
                    * making departments hold one page each and nothing else, so
                    * `drill('guide')` would send them to a page they may not
                    * open - the app falls back to the first page it can and the
                    * button looks broken rather than forbidden. A panel is part
                    * of the page and needs no grant.
                    */
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setGuideFor(page.label)}
                    title="What every number on this page means"
                  >
                    <IconInfo size={13} />
                    How to use this page
                  </button>
                ) : null
              }
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
          {/*
            * The Admin page, by name — not "whichever page is admin-only".
            *
            * This branched on `adminOnly`, which was the same thing for as long
            * as Admin was the only such page. The moment a second one existed,
            * Forecast Insights rendered the user-management screen under its
            * own header: the rail, the title and the slicers were all correct
            * and the body belonged to something else entirely.
            */}
          {page.id === 'admin' ? (
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
              // Some detail is for the people who maintain the numbers rather
              // than the people who read them.
              isAdmin={session?.user?.role === 'admin'}
              // And the warehouse, whose job this page is: the server decides
              // which departments count, so the two sides cannot drift.
              fullDetail={Boolean(session?.user?.fullDetail)}
              /*
               * Who sees the stock columns and the Replenishment Planning
               * table: administrators, Warehouse and Supply Chain.
               *
               * Also the server's answer, from the same function that gates the
               * data itself - so a column can never appear without the figures
               * behind it, nor the reverse.
               */
              stockDetail={Boolean(session?.user?.stockDetail)}
              // Page-scoped: see `noWarehouse` on the Production page.
              noWarehouse={Boolean(page.noWarehouse)}
            />
          )}
            </>
          )}
          </Suspense>
        </div>
        {guideFor && <GuideProduction label={guideFor} onClose={() => setGuideFor(null)} />}
        <CalcInspector open={inspecting} onClose={() => setInspecting(false)} />
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
