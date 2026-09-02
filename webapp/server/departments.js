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

/**
 * Which production types a department is allowed to see, and nothing else.
 *
 * A component's Node Type says who handles it: RAW is bought in and lives in
 * the warehouse, PREP is worked on, PA is something a kitchen produces itself.
 * The people who do one of those jobs have no business reading the others'
 * numbers, and were being shown all three.
 *
 * A department not listed here is unrestricted — Management, Analytics and the
 * rest still see everything. This is a restriction to apply, not a permission
 * to grant, so an unknown or missing department can only ever mean "no
 * restriction", never "no access".
 *
 * The values are the model's own, and it is worth saying why they are written
 * out rather than discovered: the whole point is that this list does not change
 * when the model gains a fourth type. A new production type nobody has decided
 * about should be visible to the unrestricted departments and to nobody else,
 * which is what naming the allowed values gives you and what an exclusion list
 * would not.
 */
export const DEPARTMENT_NODE_TYPES = {
  Production: ['PA', 'PREP'],
  Bakery: ['PA', 'PREP'],
  Warehouse: ['RAW'],
}

/** The production types this department may see, or null for all of them. */
export const nodeTypesFor = (department) => DEPARTMENT_NODE_TYPES[department] ?? null

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
export const DEPARTMENT_PAGES = {
  Procurement: ['component', 'guide'],
  'Supply Chain': ['component', 'guide'],
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
export const pagesFor = (department) =>
  DEPARTMENT_PAGES[department] ?? (nodeTypesFor(department) ? ['component', 'guide'] : null)
