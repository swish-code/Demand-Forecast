/**
 * The parts of the business, used in two places.
 *
 * A person has one (it appears on their account and in the usage figures) and
 * so does an email recipient (it says who a report is going to). They share
 * this list deliberately: two lists would drift, and then "Warehouse" on the
 * users page and "Warehouse " on the recipients page would count as two
 * different things in every report that groups on them.
 *
 * A fixed list rather than free text for the same reason — one typo becomes a
 * permanent extra row in the analytics.
 */
export const DEPARTMENTS = [
  'Production',
  'Bakery',
  'Branches',
  // An area manager covers several branches rather than one. Which branches is
  // set per account under the locations they are granted — this only says what
  // part of the business they belong to.
  'Area Managers',
  'Warehouse',
  'Operations',
  'Analytics',
  'Supply Chain',
  'Procurement',
  'Finance',
  'Marketing',
  'IT',
  'Management',
]

export const isDepartment = (value) => DEPARTMENTS.includes(value)

/*
 * Departments are matched on their normalised name.
 *
 * The list is fixed and the account form only offers these values, but a
 * department can also arrive from a directory sync or an older row, and
 * "warehouse " or "Warehouse" then matched nothing — which fails open: no
 * restriction found means no restriction applied, and the account sees
 * everything. A lookup that decides who can see what should not turn on a
 * trailing space.
 */
const norm = (v) => String(v ?? '').trim().toLowerCase()

const byNormalisedName = (map) =>
  new Map(Object.entries(map).map(([name, value]) => [norm(name), value]))



/**
 * Departments that belong on the Ingredients page and nowhere else.
 *
 * Separate from the production-type restriction above, and it has to be: these
 * two buy and move the stock, so they need every production type — raw
 * materials, prep steps and the items the kitchens produce — but they have no
 * use for product-level sales figures. "All three types, one page" could not be
 * expressed while the page list was derived from the type list, because having
 * no type restriction meant having no page restriction either.
 *
 * A department named here is confined to these pages whatever its production
 * types are. Anything not named falls through to the rule below it.
 */
/**
 * Which pages a department may open, where its access is narrower than the app.
 *
 * This is now the whole department rule. There used to be a second one beside
 * it that restricted these accounts to particular production types as well —
 * Warehouse to RAW, Production to PA and PREP — and it was removed on 6 Sep
 * 2026 because it answered a question nobody was asking: these departments need
 * the Ingredients page, and they need all of it. Splitting the page by
 * production type hid rows from the people who order them.
 *
 * A department not named here is unrestricted, which is why this is a list of
 * exceptions rather than a permission table. An account needing something
 * different from its department gets an explicit grant instead — see
 * `allowedPages`.
 */
export const DEPARTMENT_PAGES = {
  // These four work from the stock list and nothing else.
  /*
   * The guide goes with the page, not with seniority.
   *
   * These three hold Stock Article and nothing else, and the guide is now that
   * page's own walkthrough — so withholding it kept the instructions from the
   * only people who need them. The "How to use this page" button in the filter
   * bar would have navigated to a page they were not granted.
   */
  Production: ['component', 'guide'],
  Bakery: ['component', 'guide'],
  Warehouse: ['component', 'guide'],
  // Warehouse Insights is the same data as Stock Article, read from the
  // warehouse's side, so anybody trusted with one is trusted with the other.
  Procurement: ['component', 'warehouse', 'guide'],
  'Supply Chain': ['component', 'warehouse', 'guide'],
}

/**
 * A department restricted to part of the recipe is not shown the pages that are
 * about products rather than components.
 *
 * Node Type is a recipe-side attribute: it has no meaning against a product
 * total, so the Overview, the Products table and the prep plan cannot honour
 * the restriction — they would answer with everything and look like a leak,
 * because they would be one. Ingredients is the page these accounts are for.
 */
/**
 * Departments whose work is the whole brand, not one shop in it.
 *
 * A warehouse ships to every branch, so restricting a warehouse account to a
 * few of them is not a narrower view of their job — it is a narrower view of
 * somebody else's. And it broke the page they are given: both warehouse figures
 * refuse a branch filter, because outbound names a brand and not a branch, so
 * an account carrying branch grants saw the WH forecast blank, Outbound blank,
 * and the four hundred non-recipe rows that only exist because the forecast
 * puts them there missing entirely. "Location: All" in the picker still sent
 * the granted list as a filter, so it did not look like a restriction.
 *
 * Naming the department here removes the *branch* narrowing and nothing else.
 * Brand grants still apply, page grants still apply, and a branch the reader
 * chooses in the slicer is still honoured — it is their question rather than a
 * restriction imposed on them.
 *
 * Five departments are named, confirmed one at a time rather than inferred.
 * Warehouse came first, in September 2026, when a warehouse account was found
 * to be missing half the article list. The other four were confirmed by the
 * business afterwards, for the same reason: each of them orders, buys or
 * produces for the whole brand, so a branch grant narrows somebody else's job
 * rather than their own.
 *
 *   Warehouse      ships to every branch
 *   Supply Chain   plans across every branch
 *   Procurement    buys for every branch
 *   Production     produces for every branch
 *   Bakery         produces for every branch
 *
 * Everything else keeps its branch narrowing. A department belongs here only
 * when somebody has confirmed that its work spans every shop - the failure it
 * causes is silent, so guessing is worse than leaving a department out.
 */
export const BRAND_LEVEL_DEPARTMENTS = [
  'Warehouse',
  'Supply Chain',
  'Procurement',
  'Production',
  'Bakery',
]

const BRAND_LEVEL = new Set(BRAND_LEVEL_DEPARTMENTS.map(norm))

/** Does this department work across every branch of the brands it holds? */
export const worksAtBrandLevel = (department) => BRAND_LEVEL.has(norm(department))

/**
 * Departments that see the Stock Article page in full, including the
 * Replenishment Planning table.
 *
 * Asked for on 16 Sep 2026. The warehouse stock columns and the planning table
 * were gated on `role === 'admin'`, which was the safe default for a new
 * feature and the wrong rule for this one: the two departments that place the
 * orders could open the page and not see the figures they place them from.
 * `DEPARTMENT_PAGES` above already grants both of them this page - it said they
 * belong here and then the columns said otherwise.
 *
 * NOT the same list as BRAND_LEVEL_DEPARTMENTS, deliberately. That list answers
 * "does this department's work span every branch", and Production and Bakery
 * belong to it because they produce for every branch. This list answers "should
 * this department see supplier names, pending purchase orders and order
 * deadlines", and only the two named were asked for. Widening it is a decision
 * for somebody who can say yes - the same rule the brand-level list states
 * about itself.
 */
/**
 * Departments that see the recipe breakdown behind an article, not just a count.
 *
 * Its own list from 16 Sep 2026. Until then this was read off
 * BRAND_LEVEL_DEPARTMENTS, which exists to answer an unrelated question - "does
 * this department's work span every branch" - and was never chosen for this
 * one. Five departments were in it for the branch rule, and all five silently
 * got the recipe popup as a consequence.
 *
 * Warehouse, Production and Supply Chain are deliberately NOT here, asked for
 * on 16 Sep 2026: they get the COUNT of menu items using an article, which is
 * what they need to know it is used and how widely, without the recipe tree
 * behind it. Each of them keeps everything else it holds - notably Warehouse
 * and Supply Chain keep the Stock group and Replenishment Planning, which are
 * on STOCK_DETAIL_DEPARTMENTS above and untouched by this list.
 *
 * What is left is the two departments whose work is the recipe itself.
 *
 * Splitting the list changes nothing about branch narrowing: all five remain on
 * BRAND_LEVEL_DEPARTMENTS, which is the list that governs it.
 */
/*
 * Management added 21 Sep 2026, asked for directly: Management sees every page
 * and everything on it, bar the administrator pages. It is the one department
 * defined by breadth rather than by a task, so the argument that kept Warehouse
 * and Supply Chain off this list - they need to know an article is used, not
 * what it is used in - does not apply to it.
 */
export const RECIPE_DETAIL_DEPARTMENTS = ['Procurement', 'Bakery', 'Management']

const RECIPE_DETAIL = new Set(RECIPE_DETAIL_DEPARTMENTS.map(norm))

/** May this account see which menu items use an article, and at what rate? */
export const seesRecipeDetail = (user) =>
  user?.role === 'admin' || RECIPE_DETAIL.has(norm(user?.department))

/*
 * Management added 21 Sep 2026, for the same reason and on the same ask.
 *
 * Worth recording what the symptom was, because the page rule and this one are
 * easy to confuse: a Management account could already OPEN Stock Article -
 * `Management` is absent from DEPARTMENT_PAGES, and that list is a list of
 * exceptions, so absence means unrestricted. What it could not see was the
 * warehouse half of the page: the Stock column group, Store SOH, Pending PO and
 * the whole Replenishment Planning table, all of which hang on this list. The
 * tab was there and most of the page was not, which reads as the page missing.
 */
export const STOCK_DETAIL_DEPARTMENTS = ['Warehouse', 'Supply Chain', 'Management']

const STOCK_DETAIL = new Set(STOCK_DETAIL_DEPARTMENTS.map(norm))

/**
 * May this account see the stock and planning columns?
 *
 * Takes the whole user rather than the department, because the answer is "admin
 * OR one of those departments" and both halves belong in one place. The server
 * enforces it on the data and the client asks the same function's answer
 * through the session, so the columns and the figures behind them can never
 * disagree about who is allowed them.
 */
export const seesStockDetail = (user) =>
  user?.role === 'admin' || STOCK_DETAIL.has(norm(user?.department))

const PAGES_BY_NAME = byNormalisedName(DEPARTMENT_PAGES)

/** The pages this department may see by default, or null for all of them. */
export const pagesFor = (department) => PAGES_BY_NAME.get(norm(department)) ?? null

/**
 * Every page id the app has, so a grant can be checked against something real.
 *
 * Kept here rather than imported from the client, because the server is what
 * enforces this and it cannot depend on the bundle to know what it is
 * enforcing. A page added there and not here simply cannot be granted, which is
 * the safe direction for the mistake to fail in.
 */
export const PAGE_IDS = ['summary', 'product', 'component', 'warehouse', 'production', 'guide', 'admin', 'wh-analysis', 'sales-plan']

/**
 * The guide travels with the page it documents.
 *
 * `DEPARTMENT_PAGES` already pairs the two, but an explicit per-account grant
 * wins over the department default — so an account granted `['component']` and
 * nothing else got the "How to use this page" button in its filter bar with no
 * page behind it. The click resolved to a page the account may not open, the
 * app fell back to the first one it may, and the button looked broken rather
 * than forbidden. Administrators were the only readers it worked for, because
 * they are unrestricted.
 *
 * Applied to both answers below rather than to the grant, so it holds however
 * the access was given: by grant, by department, or by default.
 */
const withGuide = (pages) =>
  pages.includes('component') && !pages.includes('guide') ? [...pages, 'guide'] : pages

/**
 * What one account may open — the whole rule, in one place.
 *
 * An explicit grant on the account wins. It is stored per user so somebody in
 * Production can be given the Overview without every other Production account
 * getting it too, which the department rule alone could never express.
 *
 * With no grant, the department's default applies; with neither, the account is
 * unrestricted. Administrators are never restricted — an admin who could lock
 * themselves out of the admin page would be a support call with no way back.
 */
export function allowedPages(user) {
  if (user?.role === 'admin') return null

  /*
   * Everyone else is measured against the report pages, never Admin.
   *
   * Admin was only ever kept out of the rail by a flag on the client and by
   * `requireRole` on its own routes — so it was never really part of this rule,
   * and a grant naming it would have been honoured. Subtracting it here means
   * one place decides, and the answer is the same whether it is asked by the
   * rail or by the route.
   */
  // Neither of the administrator-only pages is grantable to anybody else.
  const REPORTS = PAGE_IDS.filter((p) => p !== 'admin' && p !== 'wh-analysis')

  const granted = Array.isArray(user?.pages)
    ? user.pages
    : typeof user?.pages === 'string' && user.pages.trim()
      ? JSON.parse(user.pages)
      : null

  if (Array.isArray(granted) && granted.length) {
    const valid = granted.filter((p) => REPORTS.includes(p))
    // A grant of nothing valid is a mistake, not an instruction to lock the
    // account out of every page it has.
    if (valid.length) return withGuide(valid)
  }

  return withGuide(pagesFor(user?.department) ?? REPORTS)
}


