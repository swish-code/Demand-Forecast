/**
 * PM theoretical against MC theoretical, per BRANCH, month by month.
 *
 * Added 18 Nov 2026, on request, for the Variance Analysis page's "PM vs MC
 * theoretical, month by month" table:
 *
 *   "I want to see branch level variance, so add a tab in the table showing
 *    branch level monthly variance between MC theoretical and PM theoretical."
 *
 * WHY THIS IS ITS OWN READ
 *
 * Neither side of the existing table carries a branch. MC's monthly trend is
 * summed per article per brand, and the Level 1 PM figure (`recipeLevel.js`) is
 * one DAX query per brand per month grouped by article only. Adding the branch
 * to that query would make Power BI evaluate the recipe measure once per
 * article per branch - ten times the work of a query that is already the
 * slowest on the page.
 *
 * So the PM side is assembled here from its two ingredients instead:
 *
 *   Level 1 recipe lines   'RECIPE TABLE' rows with Level = 1 and an article
 *                          number: Product PLU, Item No., QTY BU.
 *   Sales                  Forecast_Product_Table Actual_Qty per Clean_ItemID
 *                          per LocationID, one query per brand per month.
 *
 *   PM(article, branch, month) = sum over lines of QTY BU x units sold of the
 *                                line's PLU at that branch in that month.
 *
 * That is exactly what `[Component_Actual_Qty]` computes - a SUMX over the
 * recipe rows of QTY BU times the sales whose Clean_ItemID equals the row's
 * Product PLU - only grouped by branch as well. Validated on 17 Nov 2026: the
 * same assembly reproduced the page's Level 1 figure for CHP, PAT and SS over
 * October to the gram (48,844.55 / 141,418.82 / 1,515,320.80, every article
 * within 0.0000).
 *
 * The MC side is `'Consumption Qty'` grouped by branch and month, read by the
 * same rules as `powerbi/consumption.js`: the theoretical is booked negative
 * and negated once; a branch is identified by brand AND code, because codes
 * repeat across brands; and the catering branches' THEORETICAL is dropped, as
 * the page's MC figures are.
 *
 * Branch codes are the same on both sides - `[Branch]` is the KST MAP code and
 * PM slices on `Forecast_Product_Table[LocationID]`, which `consumption.js`
 * validated code for code on 10 Nov 2026.
 *
 * COST: one MC query, plus per brand one recipe-line query and one sales query
 * per month. Asked for only when somebody opens the branch tab, and cached.
 */
import { executeQuery } from '../powerbi/client.js'
import { config } from '../config.js'
import { cached } from '../cache.js'
import { CATERING_BRANCHES, canonArticle, UNMAPPED_BRAND } from '../powerbi/consumption.js'

/** One hour, like the Level 1 reads it sits beside. */
const TTL = 3600

/** At most a year of months per request - the table shows six. */
const MAX_MONTHS = 12

const val = (r, name) => {
  const want = String(name).toLowerCase()
  for (const key of Object.keys(r)) {
    const bare = key.replace(/^.*\[/, '').replace(/\]$/, '').toLowerCase()
    if (bare === want) return r[key]
  }
  return undefined
}

const lit = (v) => `"${String(v).replace(/"/g, '""')}"`

const daxDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}

const lastOfMonth = (iso) => {
  const [y, m] = String(iso).slice(0, 7).split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/** "YYYY-MM-01" for every valid month asked for, deduplicated and sorted. */
export function cleanMonths(months) {
  const out = new Set()
  for (const m of months ?? []) {
    const s = String(m ?? '').slice(0, 7)
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) out.add(`${s}-01`)
  }
  return [...out].sort().slice(-MAX_MONTHS)
}

/** The FM Sales model, which holds `'Consumption Qty'`. */
const fmModel = () => config.salesOnly?.find((b) => b.code === 'FM') ?? null

/**
 * The chain pin for the two models that hold two brands each.
 *
 * SLC shares a dataset with BUR and MM with TBL; without it both brands of a
 * pair read the same sales and every quantity is counted twice.
 */
const chainFilter = (brand) =>
  brand?.chain ? `\n  TREATAS({${lit(brand.chain)}}, Forecast_Product_Table[CHAINID]),` : ''

/** Units sold per PLU per branch for one brand and one month. */
function salesFor(brand, month) {
  const from = month
  const to = lastOfMonth(month)
  return cached(
    `branchsales:${brand.code}:${from}`,
    async () => {
      const rows = await executeQuery(
        `EVALUATE
SUMMARIZECOLUMNS(
  Forecast_Product_Table[Clean_ItemID],
  Forecast_Product_Table[LocationID],${chainFilter(brand)}
  TREATAS(CALENDAR(${daxDate(from)}, ${daxDate(to)}), DateTable[Date]),
  "q", SUM(Forecast_Product_Table[Actual_Qty])
)`,
        brand.datasetId,
        { bulk: true, workspace: brand.workspaceId || undefined }
      )
      assertComplete(rows, `sales ${brand.code} ${from}`)
      const out = []
      for (const r of rows) {
        const plu = String(val(r, 'Clean_ItemID') ?? '').trim()
        const branch = String(val(r, 'LocationID') ?? '').trim().toUpperCase()
        const q = Number(val(r, 'q')) || 0
        if (!plu || !q) continue
        out.push({ plu, branch, q })
      }
      return out
    },
    { seconds: TTL }
  )
}

/**
 * The Level 1 article lines of the PLUs that sold.
 *
 * Narrowed to the PLUs in the sales, because the recipe table is company-wide
 * (~300,000 rows) and a brand sells a few hundred of its PLUs. PREP lines have
 * no article number and are left out, exactly as the page's Level 1 figure
 * leaves them out.
 */
/** A short, stable fingerprint of a list, for a cache key. */
function fingerprint(list) {
  let h = 5381
  const s = list.join(',')
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return `${list.length}-${h.toString(36)}`
}

function level1LinesFor(brand, plus) {
  const list = [...plus].sort()
  return cached(
    `branchl1:${brand.code}:${fingerprint(list)}`,
    async () => {
      if (!list.length) return []
      const rows = await executeQuery(
        `EVALUATE
SELECTCOLUMNS(
  FILTER('RECIPE TABLE',
    'RECIPE TABLE'[Level] = 1
      && 'RECIPE TABLE'[Product PLU] IN {${list.map(lit).join(', ')}}),
  "plu", 'RECIPE TABLE'[Product PLU],
  "art", 'RECIPE TABLE'[Item No.],
  "item", 'RECIPE TABLE'[Item],
  "bu", 'RECIPE TABLE'[BU],
  "qty", 'RECIPE TABLE'[QTY BU]
)`,
        brand.datasetId,
        { bulk: true, workspace: brand.workspaceId || undefined }
      )
      assertComplete(rows, `Level 1 lines ${brand.code}`)
      const out = []
      for (const r of rows) {
        const article = canonArticle(val(r, 'art'))
        const qty = Number(val(r, 'qty')) || 0
        if (!article || !qty) continue
        out.push({
          plu: String(val(r, 'plu') ?? '').trim(),
          article,
          item: String(val(r, 'item') ?? '').trim(),
          bu: String(val(r, 'bu') ?? '').trim(),
          qty,
        })
      }
      return out
    },
    { seconds: TTL }
  )
}

/*
 * POWER BI RETURNS AT MOST 100,000 ROWS PER QUERY, AND DROPS THE REST SILENTLY.
 *
 * Found 18 Nov 2026: the first version read MC for every brand in one query.
 * With nine brands over six months that is several hundred thousand
 * brand x branch x article x month rows; Power BI handed back the first
 * 100,000 with no error, so most branches showed a dash where MC plainly had a
 * figure (TBL's plastic cup: MC 59 at QTB in October, shown as nothing).
 *
 * So every read here is sized to stay under the cap, and any answer that comes
 * back at or near it is treated as truncated rather than trusted.
 */
const ROW_CAP = 100_000
const NEAR_CAP = 95_000

function assertComplete(rows, what) {
  if (rows.length >= NEAR_CAP) {
    throw new Error(
      `${what} returned ${rows.length} rows - at Power BI's ${ROW_CAP.toLocaleString()}-row limit, so it may be cut short`
    )
  }
  return rows
}

/** One MC read: one brand over a span of months. */
function readMc(code, first, last) {
  const fm = fmModel()
  return executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(
  'Consumption Qty'[ART_NUMMER],
  'Consumption Qty'[ART_NAME],
  'Consumption Qty'[Branch],
  'Consumption Qty'[KST_NAME],
  'Consumption Qty'[Month_Start],
  FILTER(ALL('Consumption Qty'[Brand]), 'Consumption Qty'[Brand] = ${lit(code)}),
  FILTER(
    ALL('Consumption Qty'[Month_Start]),
    'Consumption Qty'[Month_Start] >= ${daxDate(first)}
      && 'Consumption Qty'[Month_Start] <= ${daxDate(last)}
  ),
  "pot", SUM('Consumption Qty'[Potential COS QTY])
)`,
    fm.datasetId,
    { bulk: true, workspace: fm.workspaceId || undefined }
  )
}

/**
 * MC's theoretical for ONE brand, per branch, article and month.
 *
 * One query for the whole span; if that comes back at the row cap, one query
 * per month instead, each of which must then be complete.
 */
function mcForBrand(code, months) {
  const first = months[0]
  const last = months[months.length - 1]
  const noTheo = new Set(CATERING_BRANCHES.map((b) => String(b).toUpperCase()))
  return cached(
    `branchmc:${code}:${first}:${last}`,
    async () => {
      const fm = fmModel()
      if (!fm?.datasetId) return null
      let rows = await readMc(code, first, last)
      if (rows.length >= NEAR_CAP) {
        console.log(`  [branch-variance] MC ${code}: ${rows.length} rows at the cap - reading month by month`)
        const parts = await Promise.all(
          months.map(async (m) => assertComplete(await readMc(code, m, m), `MC ${code} ${m}`))
        )
        rows = parts.flat()
      }
      const values = new Map() // branch|article -> Map(month -> qty)
      const names = new Map() // article -> name
      const branchNames = new Map() // branch -> KST_NAME
      for (const r of rows) {
        const article = canonArticle(val(r, 'ART_NUMMER'))
        const branch = String(val(r, 'Branch') ?? '').trim().toUpperCase()
        if (!article || !branch) continue
        const month = `${String(val(r, 'Month_Start') ?? '').slice(0, 7)}-01`
        // Booked negative; negated, not made absolute, so reversals still net.
        const pot = noTheo.has(branch) ? 0 : -(Number(val(r, 'pot')) || 0)
        const k = `${branch}|${article}`
        let inner = values.get(k)
        if (!inner) {
          inner = new Map()
          values.set(k, inner)
        }
        inner.set(month, (inner.get(month) ?? 0) + pot)
        const name = String(val(r, 'ART_NAME') ?? '').trim()
        if (name && !names.has(article)) names.set(article, name)
        const outlet = String(val(r, 'KST_NAME') ?? '').trim()
        if (outlet && !branchNames.has(branch)) branchNames.set(branch, outlet)
      }
      return { values, names, branchNames }
    },
    { seconds: TTL }
  )
}

/** MC for every brand asked for, merged into brand-keyed maps. */
async function mcFor(brandCodes, months) {
  const values = new Map() // brand|branch|article -> Map(month -> qty)
  const names = new Map()
  const branchNames = new Map() // brand|branch -> KST_NAME
  const failed = []
  await Promise.all(
    [...brandCodes].sort().map(async (code) => {
      const held = await mcForBrand(code, months).catch((err) => {
        console.warn(`  [branch-variance] MC ${code}: ${String(err.message).slice(0, 90)}`)
        failed.push(code)
        return null
      })
      if (!held) return
      for (const [k, v] of held.values) values.set(`${code}|${k}`, v)
      for (const [a, n] of held.names) if (!names.has(a)) names.set(a, n)
      for (const [b, n] of held.branchNames) branchNames.set(`${code}|${b}`, n)
    })
  )
  return { values, names, branchNames, failed }
}

/**
 * The branch table.
 *
 * `parts` is what `guardMany` returns - the brands this account may see, each
 * with its filters already narrowed to the branches it is granted - so no
 * brand or branch outside the grant can reach the answer.
 *
 * Returns rows shaped like the page's own rows, so the client folds them with
 * the same function it uses for the article table:
 *
 *   { 'Item No.', Item, CHAINID, Unit, Branch, BranchName, Engine_Trend }
 *
 * `Engine_Trend` follows `engineTrendFor` in api.js exactly: a month appears
 * when either side has a figure, and `diff` / `pct` only when both do.
 */
export async function branchMonthlyVariance(parts, months) {
  const wanted = cleanMonths(months)
  if (!wanted.length || !parts?.length) return { months: wanted, rows: [], failed: [] }

  const failed = []
  const brandCodes = parts.map((p) => String(p.brand.code).toUpperCase())

  // Branches each brand may show, when the account or the slicer narrows them.
  const allowedBranches = new Map(
    parts.map((p) => [
      String(p.brand.code).toUpperCase(),
      p.f?.locations?.length ? new Set(p.f.locations.map((l) => String(l).trim().toUpperCase())) : null,
    ])
  )

  const [mc, pmByBrand] = await Promise.all([
    mcFor(brandCodes, wanted),
    Promise.all(
      parts.map(async ({ brand }) => {
        const code = String(brand.code).toUpperCase()
        try {
          const sales = await Promise.all(wanted.map((m) => salesFor(brand, m)))
          const plus = new Set()
          for (const month of sales) for (const s of month) plus.add(s.plu)
          const lines = await level1LinesFor(brand, plus)
          const linesByPlu = new Map()
          for (const l of lines) {
            const list = linesByPlu.get(l.plu)
            if (list) list.push(l)
            else linesByPlu.set(l.plu, [l])
          }
          const pm = new Map() // branch|article -> Map(month -> qty)
          const info = new Map() // article -> { item, bu }
          wanted.forEach((month, i) => {
            for (const s of sales[i]) {
              for (const l of linesByPlu.get(s.plu) ?? []) {
                const k = `${s.branch}|${l.article}`
                let inner = pm.get(k)
                if (!inner) {
                  inner = new Map()
                  pm.set(k, inner)
                }
                inner.set(month, (inner.get(month) ?? 0) + l.qty * s.q)
                if (!info.has(l.article)) info.set(l.article, { item: l.item, bu: l.bu })
              }
            }
          })
          return [code, { pm, info }]
        } catch (err) {
          console.warn(`  [branch-variance] ${code}: ${String(err.message).slice(0, 90)}`)
          failed.push(code)
          return [code, null]
        }
      })
    ),
  ])

  // A brand whose MC read failed is reported, and left out below.
  const mcFailed = new Set(mc.failed)
  for (const code of mc.failed) failed.push(`MC ${code}`)

  const pmBrands = new Map(pmByBrand)
  const rows = []
  // Every brand|branch|article either side holds.
  const keys = new Set()
  for (const [code, held] of pmBrands) {
    if (!held) continue
    for (const k of held.pm.keys()) keys.add(`${code}|${k}`)
  }
  for (const k of mc.values.keys()) {
    if (brandCodes.includes(k.slice(0, k.indexOf('|')))) keys.add(k)
  }

  for (const k of keys) {
    const [brand, branch, article] = k.split('|')
    // A brand whose PM or MC read failed is left out entirely: one side alone
    // is not a comparison, and its rows would read as the other side costing
    // nothing.
    const held = pmBrands.get(brand)
    if (!held) continue
    if (mcFailed.has(brand)) continue
    const allowed = allowedBranches.get(brand)
    if (allowed && !allowed.has(branch)) continue

    const mine = held.pm.get(`${branch}|${article}`)
    const theirs = mc.values.get(k)
    const points = []
    for (const month of wanted) {
      const a = mine?.get(month)
      const b = theirs?.get(month)
      const hasPm = Number.isFinite(a) && a !== 0
      const hasMc = Number.isFinite(b)
      if (!hasPm && !hasMc) continue
      const pm = hasPm ? a : null
      const mcv = hasMc ? b : null
      points.push({
        month,
        pm,
        mc: mcv,
        diff: pm === null || mcv === null ? null : pm - mcv,
        pct: pm === null || !(mcv > 0) ? null : (pm - mcv) / mcv,
      })
    }
    if (!points.some((p) => p.diff !== null)) continue

    const meta = held.info.get(article)
    rows.push({
      'Item No.': article,
      Item: meta?.item || mc.names.get(article) || article,
      CHAINID: brand,
      Unit: meta?.bu || 'Unknown',
      Branch: branch,
      BranchName: mc.branchNames.get(`${brand}|${branch}`) ?? branch,
      Engine_Trend: points,
    })
  }

  return { months: wanted, rows, failed }
}
