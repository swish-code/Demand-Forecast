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
 * Production and Bakery work from the same page and have the same problem. They
 * are deliberately not here: widening an account's data is a decision per
 * department, not an inference from one.
 */
export const BRAND_LEVEL_DEPARTMENTS = ['Warehouse']

const BRAND_LEVEL = new Set(BRAND_LEVEL_DEPARTMENTS.map(norm))

/** Does this department work across every branch of the brands it holds? */
export const worksAtBrandLevel = (department) => BRAND_LEVEL.has(norm(department))

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
export const PAGE_IDS = ['summary', 'product', 'component', 'warehouse', 'production', 'guide', 'admin', 'wh-analysis']

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
