/**
 * WHY PM AND MC THEORETICAL DIFFER - read live from MC.
 *
 * Added 24 Nov 2026, on request, as a tab of Variance Analysis > PM Historical
 * Reconciliation, after an investigation into why PM-vs-MC accuracy was
 * falling for SS, PAT and MM. This puts that investigation's method on the
 * page so it can be re-run for any brand and month, instead of living in a
 * one-off report.
 *
 * THE METHOD
 *
 * MC's theoretical is its own recipe explosion over its own till sales, booked
 * DAY BY DAY with the recipe in force that day. PM's is our Recipe File over
 * Power BI sales, with TODAY's recipe applied to every month. So the gap has
 * three possible sources, and they can be separated by rebuilding MC's figure
 * from MC's own parts:
 *
 *   MC actual      -SUM(DAILYTOTALS.DAY_QTYSOLD)    what MC booked
 *   MC rebuild     HIS_BONIER sales x PRODUKT x     MC's sales through MC's
 *                  REC_EXPLOSION (REX_MIS = 1)       CURRENT recipes
 *   PM             the page's own Stop-at-PA figure (`recipeLevel.js`)
 *
 *   rebuild vs actual   the recipe CHANGED between the sale and today. MC used
 *                       the old recipe that day; today's recipe says otherwise.
 *                       Nothing in PM can fix this - only dated recipes can.
 *   PM vs rebuild       the Recipe File, the Stop-at-PA rule or Power BI's
 *                       sales disagree with MC's current recipes and sales.
 *   water               MC never books its water articles (WATER below); PM
 *                       does, so they are reported on their own.
 *
 * Validated 24 Nov 2026 against the investigation's offline rebuild: November
 * reproduced at 97.5% (SS) and 97.0% (MM); October fell to 85% and 89%, the
 * difference being recipe edits since - e.g. Straw Transparent 107000007,
 * booked 136,139 by MC in October and in no current recipe.
 *
 * REX_MIS = 1 is the explosion line MC posts. Inferred from the fit, not from
 * MC documentation: with it the rebuild matches MC's own booking; without it,
 * sub-recipe lines are counted twice.
 *
 * Accuracy is the page's rule throughout: 1 - sum|other - MC| / sum MC over
 * the article-brands of the month. Catering (CAT) is left out of MC's side, as
 * on the rest of the page.
 */
import { executeQuery } from '../powerbi/client.js'
import { config, missingMcOracle } from '../config.js'
import { cached } from '../cache.js'
import { mcSelect, chunks, intList, mcOracleConfigured } from '../mc/oracle.js'
import { CATERING_BRANCHES, canonArticle } from '../powerbi/consumption.js'
import { level1ByArticleMonth } from './recipeLevel.js'

/** Closed months do not move; the open one does, so it is held for less. */
const TTL_CLOSED = 3600
const TTL_OPEN = 900

/** At most this many months per request. Each is a till read per brand. */
const MAX_MONTHS = 6

/** Articles listed per brand per month. */
const TOP = 30

/**
 * MC's water articles. MC books neither, every week, at every outlet -
 * confirmed 24 Nov 2026 from DAILYTOTALS - while recipes and PM carry both.
 */
export const WATER = new Map([
  ['104800018', 'Water for Recipe'],
  ['106401272', 'Water'],
])

const val = (r, name) => {
  const want = String(name).toLowerCase()
  for (const key of Object.keys(r)) {
    const bare = key.replace(/^.*\[/, '').replace(/\]$/, '').toLowerCase()
    if (bare === want) return r[key]
  }
  return undefined
}

/** Cost-centre names are matched on letters and digits: MC's text encoding mangles the rest. */
export const kstKey = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** "YYYY-MM-01" for every valid month asked for, deduplicated, sorted, capped. */
export function cleanMonths(months) {
  const out = new Set()
  for (const m of months ?? []) {
    const s = String(m ?? '').slice(0, 7)
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) out.add(`${s}-01`)
  }
  return [...out].sort().slice(-MAX_MONTHS)
}

const nextMonth = (m) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)
}

const thisMonth = () => `${new Date().toISOString().slice(0, 7)}-01`

const add = (m, k, x) => m.set(k, (m.get(k) ?? 0) + x)

/* ------------------------------------------------------------ the reads -- */

/** KST MAP from the FM Sales model: the same map the rest of the page uses. */
export function kstMap() {
  return cached(
    'mcdrivers:kstmap',
    async () => {
      const fm = config.salesOnly?.find((b) => b.code === 'FM')
      if (!fm?.datasetId) throw new Error('The FM Sales model is not configured, so cost centres cannot be placed')
      const rows = await executeQuery(`EVALUATE 'KST MAP'`, fm.datasetId, {
        workspace: fm.workspaceId || undefined,
      })
      const out = new Map()
      for (const r of rows) {
        const name = kstKey(val(r, 'KST_NAME'))
        const brand = String(val(r, 'CHAINID') ?? '').trim().toUpperCase()
        const branch = String(val(r, 'LocationID') ?? '').trim().toUpperCase()
        if (name && brand) out.set(name, { brand, branch })
      }
      return out
    },
    { seconds: TTL_CLOSED }
  )
}

/**
 * MC's cost centres placed on brands: brand -> [kst_id], catering left out.
 * Every brand in the KST MAP, not only those asked for, so that the monthly
 * reads below are one per month for the whole company and shared by brands.
 */
function costCentres() {
  return cached(
    'mcdrivers:kst',
    async () => {
      const [map, rows] = await Promise.all([kstMap(), mcSelect('SELECT kst_id, kst_name FROM kostst')])
      const noTheo = new Set(CATERING_BRANCHES.map((b) => String(b).toUpperCase()))
      const byBrand = new Map()
      for (const r of rows) {
        const placed = map.get(kstKey(r.KST_NAME))
        if (!placed || noTheo.has(placed.branch)) continue
        const list = byBrand.get(placed.brand) ?? []
        list.push(String(r.KST_ID))
        byBrand.set(placed.brand, list)
      }
      return byBrand
    },
    { seconds: TTL_CLOSED }
  )
}

/*
 * HOW MC IS READ - measured 24 Nov 2026, and the reason for the shape below.
 *
 * DAILYTOTALS holds 138 million rows, indexed (KST_ID, ART_ID, DAY_DATE). With
 * the outlet fixed the index still walks every article's whole history, so an
 * outlet costs the same for one month as for four: SS's eleven outlets over
 * October took 2 min 39 s, and the same read with no outlet filter was still
 * running after 15 minutes when MC reset the connection. So: ONE read per
 * BRAND, covering every month asked for at once.
 *
 * HIS_BONIER holds 17 million rows and has no outlet index, so every read is a
 * full scan - about 2 minutes cold, whatever the outlets. So: ONE read for
 * every mapped outlet and every month at once, shared by all brands.
 *
 * Each is split into the closed months, held six hours (they rarely move, but
 * can: MC rewrote every September day on 24 Nov 2026), and the month in
 * progress, held one hour.
 */
const TTL_CLOSED_MONTHS = 6 * 3600
const TTL_OPEN_MONTH = 3600

/** The months as at most two contiguous spans: closed, then the open one. */
export function spans(months) {
  const now = thisMonth()
  return [months.filter((m) => m < now), months.filter((m) => m >= now)].filter((l) => l.length)
}

const ttlSpan = (span) => (span[span.length - 1] >= thisMonth() ? TTL_OPEN_MONTH : TTL_CLOSED_MONTHS)

/** Every mapped outlet, as one IN list. */
const allKsts = (centres) => intList([...centres.values()].flat())

/** What MC booked for one brand over one span: month -> article -> qty, plus names. */
function mcActualSpan(brand, ksts, span) {
  const first = span[0]
  const last = span[span.length - 1]
  return cached(
    `mcdrivers:actual:${brand}:${first}:${last}`,
    async () => {
      const byMonth = new Map()
      const names = new Map()
      for (const part of chunks(intList(ksts))) {
        const rows = await mcSelect(
          `SELECT TO_CHAR(TRUNC(d.day_date, 'MM'), 'YYYY-MM-DD') AS m, a.art_nummer,
                  MAX(a.art_name) AS art_name, -SUM(d.day_qtysold) AS theo
             FROM dailytotals d JOIN artikel a ON a.art_id = d.art_id
            WHERE d.kst_id IN (${part.join(',')})
              AND d.day_date >= TO_DATE(:f, 'YYYY-MM-DD') AND d.day_date < TO_DATE(:t, 'YYYY-MM-DD')
              AND d.day_qtysold <> 0
            GROUP BY TRUNC(d.day_date, 'MM'), a.art_nummer`,
          { f: first, t: nextMonth(last) }
        )
        for (const r of rows) {
          const art = canonArticle(r.ART_NUMMER)
          if (!art) continue
          const m = byMonth.get(r.M) ?? new Map()
          add(m, art, Number(r.THEO) || 0)
          byMonth.set(r.M, m)
          if (r.ART_NAME && !names.has(art)) names.set(art, String(r.ART_NAME).trim())
        }
      }
      return { byMonth, names }
    },
    { seconds: ttlSpan(span) }
  )
}

/** One brand's bookings over all the months asked for. */
async function mcActual(brand, ksts, months) {
  const parts = await Promise.all(spans(months).map((s) => mcActualSpan(brand, ksts, s)))
  const byMonth = new Map()
  const names = new Map()
  for (const p of parts) {
    for (const [m, v] of p.byMonth) byMonth.set(m, v)
    for (const [a, n] of p.names) if (!names.has(a)) names.set(a, n)
  }
  return { byMonth, names }
}

/** MC's till sales over one span: month -> kst -> [{ pro, plu, q }]. Errored receipts left out. */
function mcSalesSpan(centres, span) {
  const first = span[0]
  const last = span[span.length - 1]
  return cached(
    `mcdrivers:sales:${first}:${last}`,
    async () => {
      const byMonth = new Map()
      for (const part of chunks(allKsts(centres))) {
        const rows = await mcSelect(
          `SELECT TO_CHAR(TRUNC(b.bon_dat, 'MM'), 'YYYY-MM-DD') AS m, b.kst_nr, b.pro_nr, b.bon_plu,
                  SUM(b.bon_menge) AS qty
             FROM his_bonier b
            WHERE b.kst_nr IN (${part.join(',')})
              AND b.bon_dat >= TO_DATE(:f, 'YYYY-MM-DD') AND b.bon_dat < TO_DATE(:t, 'YYYY-MM-DD')
              AND NVL(b.bon_errcode, 0) = 0
            GROUP BY TRUNC(b.bon_dat, 'MM'), b.kst_nr, b.pro_nr, b.bon_plu`,
          { f: first, t: nextMonth(last) }
        )
        for (const r of rows) {
          const q = Number(r.QTY) || 0
          if (!q) continue
          const byKst = byMonth.get(r.M) ?? new Map()
          const k = String(r.KST_NR)
          const list = byKst.get(k) ?? []
          list.push({ pro: String(r.PRO_NR), plu: String(r.BON_PLU ?? '').trim(), q })
          byKst.set(k, list)
          byMonth.set(r.M, byKst)
        }
      }
      return byMonth
    },
    { seconds: ttlSpan(span) }
  )
}

/** The company's till sales over all the months asked for. */
async function mcSales(centres, months) {
  const parts = await Promise.all(spans(months).map((s) => mcSalesSpan(centres, s)))
  const out = new Map()
  for (const p of parts) for (const [m, v] of p) out.set(m, v)
  return out
}

/** One brand's sales in one month: its outlets' lists, joined. */
export function brandSales(ksts, byKst) {
  const list = []
  for (const k of ksts) for (const s of byKst?.get(k) ?? []) list.push(s)
  return list
}

/** A short, stable fingerprint of a list, for a cache key. */
function fingerprint(list) {
  let h = 5381
  const s = list.join(',')
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return `${list.length}-${h.toString(36)}`
}

/**
 * MC's CURRENT recipe per product: pro_id -> { name, per: Map(article -> qty) }.
 *
 * Read by the product ids actually sold, not by cost centre: on 24 Nov 2026,
 * 96 sale rows (1,386 units) sold a product defined under another cost centre.
 */
function currentRecipes(proIds) {
  const ids = intList(proIds).sort()
  return cached(
    `mcdrivers:recipes:${fingerprint(ids)}`,
    async () => {
      const products = new Map()
      for (const part of chunks(ids)) {
        const rows = await mcSelect(
          `SELECT p.pro_id, p.rez_nr, a.art_nummer, p.pro_menge, p.pro_name
             FROM produkt p LEFT JOIN artikel a ON a.art_id = p.art_nr
            WHERE p.pro_id IN (${part.join(',')})`
        )
        for (const r of rows) products.set(String(r.PRO_ID), r)
      }
      const rezIds = intList([...products.values()].map((p) => p.REZ_NR).filter((x) => x && String(x) !== '0'))
      const explosion = new Map() // rez -> Map(article -> qty)
      for (const part of chunks(rezIds)) {
        const rows = await mcSelect(
          `SELECT x.rez_id, a.art_nummer, MAX(a.art_name) AS art_name, SUM(x.rex_pot_qty_bu) AS qty
             FROM rec_explosion x JOIN artikel a ON a.art_id = x.art_id
            WHERE x.rex_mis = 1 AND x.rez_id IN (${part.join(',')})
            GROUP BY x.rez_id, a.art_nummer`
        )
        for (const r of rows) {
          const art = canonArticle(r.ART_NUMMER)
          if (!art) continue
          const m = explosion.get(String(r.REZ_ID)) ?? new Map()
          add(m, art, Number(r.QTY) || 0)
          explosion.set(String(r.REZ_ID), m)
        }
      }
      const out = new Map()
      for (const [id, p] of products) {
        let per = null
        if (p.REZ_NR && String(p.REZ_NR) !== '0') per = explosion.get(String(p.REZ_NR)) ?? new Map()
        else if (p.ART_NUMMER) per = new Map([[canonArticle(p.ART_NUMMER), Number(p.PRO_MENGE) || 1]])
        out.set(id, { name: String(p.PRO_NAME ?? '').trim(), per: per ?? new Map() })
      }
      return out
    },
    { seconds: TTL_OPEN }
  )
}

/**
 * When each article's ACTIVE recipe lines were last created or changed:
 * article -> { lines, created, changed }. About 72,000 lines grouped, so read
 * whole rather than by IN list.
 */
function lineDates() {
  return cached(
    'mcdrivers:linedates',
    async () => {
      const rows = await mcSelect(
        `SELECT a.art_nummer, COUNT(*) AS n,
                TO_CHAR(MAX(ri.new_zeit), 'YYYY-MM-DD') AS created,
                TO_CHAR(MAX(ri.chg_zeit), 'YYYY-MM-DD') AS changed
           FROM rezepturitem ri
           JOIN artikel a ON a.art_id = ri.art_nr
           JOIN rezeptur r ON r.rez_id = ri.rez_id
          WHERE NVL(r.aktiv, ' ') <> 'S'
          GROUP BY a.art_nummer`
      )
      const out = new Map()
      for (const r of rows) {
        const art = canonArticle(r.ART_NUMMER)
        if (art) out.set(art, { lines: Number(r.N) || 0, created: r.CREATED || null, changed: r.CHANGED || null })
      }
      return out
    },
    { seconds: TTL_OPEN }
  )
}

/* ---------------------------------------------------------- the arithmetic -- */

/** Accuracy over a set of articles: 1 - sum|x - mc| / sum mc. Null when MC has nothing. */
export function accuracy(mc, other, { drop = null } = {}) {
  let mt = 0
  let gap = 0
  for (const art of new Set([...mc.keys(), ...other.keys()])) {
    const c = mc.get(art) ?? 0
    const x = drop?.has(art) ? 0 : other.get(art) ?? 0
    if (!c && !x) continue
    mt += c
    gap += Math.abs(x - c)
  }
  return mt > 0 ? 1 - gap / mt : null
}

/** MC's sales through MC's current recipes: article -> qty, and article -> PLU -> qty. */
export function rebuild(sales, recipes) {
  const qty = new Map()
  const byPlu = new Map()
  for (const s of sales) {
    const p = recipes.get(s.pro)
    if (!p) continue
    for (const [art, x] of p.per) {
      add(qty, art, s.q * x)
      const m = byPlu.get(art) ?? new Map()
      add(m, `${s.plu}\u0000${p.name}`, s.q * x)
      byPlu.set(art, m)
    }
  }
  return { qty, byPlu }
}

/**
 * Why one article differs, in the reader's terms.
 *
 *   notposted  a water article MC never books
 *   removed    in MC's booking, in no current MC recipe
 *   changed    MC's current recipe disagrees with what MC booked, and the
 *              article's recipe lines were created or changed on or after
 *              the month started - the recipe moved after the sale
 *   booking    the same disagreement with no line change to show for it:
 *              unexplained from MC's data (a deleted line leaves no date)
 *   file       PM disagrees with MC's current recipes more than those
 *              recipes disagree with MC's booking: Recipe File, Stop-at-PA
 *              or Power BI sales
 */
export function classify({ art, mc, pm, rb, month, dates }) {
  if (WATER.has(art) && Math.abs(mc) < 0.5) return { kind: 'notposted', since: null }
  const timing = rb - mc
  const file = pm === null ? 0 : pm - rb
  if (Math.abs(timing) >= Math.abs(file)) {
    if (Math.abs(rb) < 0.5 && Math.abs(mc) >= 0.5) return { kind: 'removed', since: null }
    const last = [dates?.created, dates?.changed].filter(Boolean).sort().pop() ?? null
    if (last && last >= month) return { kind: 'changed', since: last }
    return { kind: 'booking', since: last }
  }
  return { kind: 'file', since: null }
}

/**
 * One brand's month, folded: totals, the three accuracies, the units of gap
 * by cause, and the articles furthest apart.
 */
export function foldMonth({ month, actual, names, rb, rbByPlu, pm, dates }) {
  const pmMap = pm ?? new Map()
  const sum = (m) => [...m.values()].reduce((s, x) => s + x, 0)
  const acc = {
    pm: pm ? accuracy(actual, pmMap) : null,
    pmNoWater: pm ? accuracy(actual, pmMap, { drop: WATER }) : null,
    rebuild: accuracy(actual, rb),
    rebuildNoWater: accuracy(actual, rb, { drop: WATER }),
  }
  const byCause = { changed: 0, removed: 0, booking: 0, notposted: 0, file: 0 }
  const rows = []
  for (const art of new Set([...actual.keys(), ...rb.keys(), ...pmMap.keys()])) {
    const mc = actual.get(art) ?? 0
    const r = rb.get(art) ?? 0
    const p = pm ? pmMap.get(art) ?? 0 : null
    const gap = Math.abs((p ?? r) - mc)
    if (gap < 0.5) continue
    const c = classify({ art, mc, pm: p, rb: r, month, dates: dates?.get(art) })
    byCause[c.kind] += gap
    rows.push({ art, mc, pm: p, rb: r, gap, ...c })
  }
  rows.sort((a, b) => b.gap - a.gap)
  const articles = rows.slice(0, TOP).map((x) => {
    const d = dates?.get(x.art)
    const plus = [...(rbByPlu.get(x.art) ?? new Map())]
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3)
      .map(([k, q]) => {
        const [plu, name] = k.split('\u0000')
        return { plu, name, qty: q }
      })
    return {
      article: x.art,
      name: names.get(x.art) ?? WATER.get(x.art) ?? '',
      mc: x.mc,
      pm: x.pm,
      rebuild: x.rb,
      timing: x.rb - x.mc,
      file: x.pm === null ? null : x.pm - x.rb,
      kind: x.kind,
      since: x.since,
      lines: d?.lines ?? 0,
      lastChange: [d?.created, d?.changed].filter(Boolean).sort().pop() ?? null,
      plus,
    }
  })
  const mcTotal = sum(actual)
  const rbTotal = sum(rb)
  return {
    month,
    open: month >= thisMonth(),
    mcTotal,
    rebuildTotal: rbTotal,
    pmTotal: pm ? sum(pmMap) : null,
    /*
     * MC's booking over what its own sales and recipes explain. Near 1 is
     * normal; far from it is MC's posting, not a recipe. September 2026 read
     * about 2: every day's DAILYTOTALS was rewritten on 24 Nov at double.
     */
    postingRatio: rbTotal > 0 ? mcTotal / rbTotal : null,
    acc,
    gapByCause: byCause,
    gapTotal: Object.values(byCause).reduce((s, x) => s + x, 0),
    articles,
  }
}

/* ------------------------------------------------------------- the route -- */

/**
 * `parts` is what `guardMany` returns, so only brands the account may see are
 * read. Brands with no outlet in the KST MAP come back in `unplaced`.
 */
export async function theoreticalDrivers(parts, months) {
  const wanted = cleanMonths(months)
  if (!mcOracleConfigured()) return { configured: false, missing: missingMcOracle(), months: wanted, brands: [] }
  if (!wanted.length || !parts?.length) return { configured: true, months: wanted, brands: [] }

  const [centres, dates] = await Promise.all([costCentres(), lineDates()])
  const failed = []
  const unplaced = []

  // The till sales are one company-wide read, shared; started before the brands so it runs beside them.
  const salesPromise = mcSales(centres, wanted)
  salesPromise.catch(() => {})

  const brands = await Promise.all(
    parts.map(async ({ brand }) => {
      const code = String(brand.code).toUpperCase()
      const ksts = centres.get(code)
      if (!ksts?.length) {
        unplaced.push(code)
        return null
      }
      try {
        const [pm, booked, sold] = await Promise.all([
          level1ByArticleMonth(code, wanted).catch(() => null),
          mcActual(code, ksts, wanted),
          salesPromise,
        ])
        const perMonth = wanted.map((m) => ({
          m,
          actual: { qty: booked.byMonth.get(m) ?? new Map(), names: booked.names },
          sales: brandSales(ksts, sold.get(m)),
        }))
        const recipes = await currentRecipes(perMonth.flatMap((x) => x.sales.map((s) => s.pro)))
        const out = perMonth.map(({ m, actual, sales }) => {
          const rb = rebuild(sales, recipes)
          let pmMonth = null
          if (pm) {
            pmMonth = new Map()
            for (const [art, inner] of pm) {
              const q = inner.get(m)
              if (q) pmMonth.set(art, q)
            }
          }
          return foldMonth({
            month: m,
            actual: actual.qty,
            names: actual.names,
            rb: rb.qty,
            rbByPlu: rb.byPlu,
            pm: pmMonth,
            dates,
          })
        })
        return { brand: code, pmAvailable: Boolean(pm), months: out }
      } catch (err) {
        console.warn(`  [mc-drivers] ${code}: ${String(err.message).slice(0, 120)}`)
        failed.push({ brand: code, error: String(err.message).slice(0, 200) })
        return null
      }
    })
  )

  return {
    configured: true,
    months: wanted,
    generatedAt: new Date().toISOString(),
    brands: brands.filter(Boolean),
    unplaced,
    failed,
  }
}
