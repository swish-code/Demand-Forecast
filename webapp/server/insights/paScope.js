/**
 * Which recipe lines count towards PM theoretical on the Variance Analysis
 * page: STOP AT PA - 22 Nov 2026, on request.
 *
 *   "include sub-recipe ingredients, but stop at prepared (PA) articles ...
 *    instead of adding new columns in recipe file, could you do it somehow
 *    here itself in the filter"
 *
 * Replaces the 15 Nov "Level 1 lines only" rule on that page. A line counts
 * when it is
 *
 *   - a Level 1 line of the menu item's recipe, or
 *   - inside a PREP sub-recipe, at any depth, with no PA above it.
 *
 * A line INSIDE A PA's OWN RECIPE does not count: the PA article itself is
 * already counted as a line of its own, so adding its ingredients as well
 * counts the same food twice.
 *
 * WHY THIS RULE - measured 22 Nov 2026, read-only, against MC's Potential COS
 * for CHP, PAT, SS, SLC, BUR, MM and TBL, August-October 2026, with the page's
 * own formula (1 - sum|PM - MC| / sum MC):
 *
 *                             October    Aug-Oct
 *   Level 1 lines only        73.6%      72.8%     (the rule this replaces)
 *   every level               78.2%      75.2%     (worse in PAT, SS, BUR, SLC)
 *   stop at PA                88.4%      85.1%     best in every brand, every month
 *
 * and MC's own figures show it is MC's rule: all 42 articles that occur ONLY
 * inside PREP sub-recipes carry an MC theoretical (34 within 5% of ours),
 * while MC books 2,115 units against our 1.19 million for the 504 articles
 * that occur only inside a PA's recipe.
 *
 * HOW A LINE IS PLACED WITHOUT A NEW COLUMN
 *
 * `'RECIPE TABLE'[Recipe Path]` names every recipe from the menu item down to
 * the line's own ("Root > Sub > Sub-sub"), and a line's Level is always the
 * number of names in it - 0 exceptions in 88,403 lines checked. The recipe at
 * depth k+1 was opened by a node at depth k (a row with Has Children = "Y")
 * whose path is the first k names. That node's Node Type says whether the
 * recipe was a PREP or a PA. A PREP node's Item is the sub-recipe's name; a PA
 * node's Item is the article's name, which is the recipe's name with "(PA)"
 * on the end.
 *
 * Matched on the PATH, not on the product: a recipe tree is the same whichever
 * PLU sells it. Checked against the per-PLU reconstruction the investigation
 * used: MM October, 222,410.23 units of sub-recipe quantity either way.
 *
 * A step that cannot be told apart - a PREP and a PA of the same name opening
 * from the same node - is AMBIGUOUS and left out, and logged. There were none
 * in the seven brands on 22 Nov 2026.
 */
import { executeQuery } from '../powerbi/client.js'
import { cached } from '../cache.js'

/** One hour, like the reads that use it. The tree moves when the model is republished. */
const TTL = 3600

/** Power BI drops rows past 100,000 without an error; an answer near it is not trusted. */
const NEAR_CAP = 95_000

const val = (r, name) => {
  const want = String(name).toLowerCase()
  for (const key of Object.keys(r)) {
    const bare = key.replace(/^.*\[/, '').replace(/\]$/, '').toLowerCase()
    if (bare === want) return r[key]
  }
  return undefined
}

/** One recipe name written one way: trimmed, single-spaced, upper case. */
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase()

/** A PA article's name without its "(PA)" tag, so it compares with its recipe's name. */
const paName = (s) => norm(s).replace(/\s*\(PA\)\s*$/, '').trim()

/** "Root > Sub" -> ["ROOT", "SUB"]. */
export const pathNames = (path) => String(path ?? '').split('>').map(norm)

/**
 * The nodes of a recipe tree, keyed by the path they sit at.
 *
 * `rows` are `{ path, type, item }` for the rows with children. Kept as a
 * function of plain rows so the rule can be tested without Power BI.
 */
export function indexNodes(rows) {
  const nodes = new Map()
  for (const r of rows ?? []) {
    const type = String(r.type ?? '').trim().toUpperCase()
    if (type !== 'PA' && type !== 'PREP') continue
    const key = pathNames(r.path).join('>')
    const list = nodes.get(key)
    const node = { type, item: r.item }
    if (list) list.push(node)
    else nodes.set(key, [node])
  }
  return nodes
}

/**
 * Where a recipe line sits: 'L1', 'PREP' (inside PREP sub-recipes only),
 * 'PA' (somewhere inside a PA's own recipe) or 'AMBIGUOUS'.
 */
export function placeLine(nodes, path) {
  const names = pathNames(path)
  if (names.length <= 1) return 'L1'
  for (let k = 1; k < names.length; k++) {
    const openers = nodes.get(names.slice(0, k).join('>')) ?? []
    const want = names[k]
    const prep = openers.filter((n) => n.type === 'PREP' && norm(n.item) === want)
    const paByName = openers.filter((n) => n.type === 'PA' && paName(n.item) === paName(want))
    if (paByName.length && !prep.length) return 'PA'
    if (prep.length && !paByName.length) continue
    // No name matched: when the only thing that can open a recipe here is one
    // PA, it is that PA (its recipe is named differently from its article).
    if (!prep.length && openers.filter((n) => n.type === 'PA').length === 1) return 'PA'
    return 'AMBIGUOUS'
  }
  return 'PREP'
}

/** True when a line at this path counts towards PM theoretical on the page. */
export const countsTowardPm = (place) => place === 'L1' || place === 'PREP'

function guard(rows, what) {
  if (rows.length >= NEAR_CAP) {
    throw new Error(`${what} returned ${rows.length} rows - at Power BI's row limit, so it may be cut short`)
  }
  return rows
}

/**
 * The node index for one model, cached per dataset.
 *
 * Read as two queries, one per node type, so each stays well under the row
 * limit: 46,424 PREP and 25,332 PA nodes on 22 Nov 2026 - one query would
 * already be at 72% of it.
 */
export function nodesFor(brand) {
  return cached(
    `panodes:${brand.datasetId}`,
    async () => {
      const read = (type) =>
        executeQuery(
          `EVALUATE
CALCULATETABLE(
  SUMMARIZE('RECIPE TABLE', 'RECIPE TABLE'[Recipe Path], 'RECIPE TABLE'[Item]),
  'RECIPE TABLE'[Has Children] = "Y",
  'RECIPE TABLE'[Node Type] = "${type}"
)`,
          brand.datasetId,
          { bulk: true, workspace: brand.workspaceId || undefined }
        ).then((rows) =>
          guard(rows, `${type} nodes ${brand.code}`).map((r) => ({
            path: val(r, 'Recipe Path'),
            item: val(r, 'Item'),
            type,
          }))
        )
      const [prep, pa] = await Promise.all([read('PREP'), read('PA')])
      const nodes = indexNodes([...prep, ...pa])
      console.log(`  [pa-scope] ${brand.code}: ${prep.length} PREP and ${pa.length} PA nodes`)
      return nodes
    },
    { seconds: TTL }
  )
}

/**
 * A placer for one model: `path -> place`, remembered per path because the
 * same path repeats across articles, PLUs and months.
 */
export async function placerFor(brand) {
  const nodes = await nodesFor(brand)
  const seen = new Map()
  return (path) => {
    const key = String(path ?? '')
    let place = seen.get(key)
    if (!place) {
      place = placeLine(nodes, key)
      seen.set(key, place)
    }
    return place
  }
}
