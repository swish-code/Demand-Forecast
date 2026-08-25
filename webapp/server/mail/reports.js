import { config } from '../config.js'
import { data } from '../data/index.js'
import { buildContext, trustNote } from '../insights/context.js'
import { planSheet, productSheet, digestSheet, preparedSheet } from './csv.js'
import { workbook, XLSX_TYPE } from './xlsx.js'
import { branchesOf } from './recipients.js'

/**
 * Building the daily reports, and deciding who gets which.
 *
 * Two audiences, two different documents:
 *
 *   store        one branch's production plan for tomorrow, and nothing else.
 *                A branch manager needs a prep list, not a group KPI.
 *
 *   stakeholder  tomorrow across every brand and store they can see, broken
 *                down by store, so head office can tell which branches are
 *                about to have an unusual day.
 *
 * Both are built from exactly the same queries the dashboard uses, so the email
 * and the screen can never disagree.
 */

const DAY = 86_400_000
/** Only the calendar is needed here — an empty list skips every option query. */
const DATE_ONLY = []

const int = (v) => Math.round(Number(v) || 0).toLocaleString('en-US')
const pct = (v, d = 1) => `${(Number(v) * 100).toFixed(d)}%`

/** HTML-escape everything interpolated: product names carry quotes and & signs. */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function tomorrowFrom(today) {
  if (!today) return null
  return new Date(Date.parse(`${today}T00:00:00Z`) + DAY).toISOString().slice(0, 10)
}

function longDate(day) {
  if (!day) return ''
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/* ------------------------------------------------------------- styling ---
 * Inline styles only, and a table layout. Outlook ignores <style> blocks and
 * most of flexbox, so anything cleverer would arrive broken for exactly the
 * audience this is written for.
 * ------------------------------------------------------------------------ */

const INK = '#111827'
const MUTED = '#6b7280'
const LINE = '#e2e8e4'
const BRAND = '#0f3a22'
const AMBER = '#b45309'
const GREEN = '#0f7a4f'

const shell = (title, subtitle, body) => `
<div style="margin:0;padding:24px;background:#f2f5f3;font-family:'Segoe UI',Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid ${LINE};border-radius:10px;">
    <tr>
      <td style="padding:20px 24px;background:${BRAND};border-radius:10px 10px 0 0;">
        <div style="font-size:17px;font-weight:600;color:#ffffff;">${esc(title)}</div>
        <div style="font-size:13px;color:#a8c9b5;margin-top:2px;">${esc(subtitle)}</div>
      </td>
    </tr>
    <tr><td style="padding:24px;">${body}</td></tr>
    <tr>
      <td style="padding:14px 24px;border-top:1px solid ${LINE};font-size:11px;color:${MUTED};">
        Sent automatically by Demand Forecast. Figures come from the same Power BI models as the dashboard.
      </td>
    </tr>
  </table>
</div>`

/**
 * Cells carry only their alignment; colour, size and the row rule live on the
 * <tr>. Repeating the full declaration on every cell pushed a 300-line branch
 * plan past 60kB, and Gmail clips a message at around 102kB — which would cut
 * the prep list off mid-table for exactly the people who need all of it.
 */
const td = (value, align = 'left', extra = '') =>
  `<td style="padding:7px 10px${align === 'right' ? ';text-align:right' : ''}${extra}">${value}</td>`

const TR = `style="font-size:13px;color:${INK};border-bottom:1px solid #f1f4f2;"`

const change = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return `<span style="color:${MUTED};">—</span>`
  const up = n > 0
  return `<span style="color:${up ? GREEN : AMBER};font-weight:600;">${up ? '▲' : '▼'} ${Math.abs(n * 100).toFixed(1)}%</span>`
}

/**
 * How far to trust the plan, said in the terms a kitchen works in.
 *
 * A share of the plan rather than a variance percentage: "about 95% of this
 * has been selling" can be acted on; "the forecast runs 4.7% above actual"
 * cannot.
 */
const trustBlock = (t) => `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;background:#f7faf8;border:1px solid ${LINE};border-radius:8px;">
    <tr><td style="padding:16px 18px;">
      <div style="font-size:15px;font-weight:600;color:${INK};">${esc(t.question)}</div>
      <div style="font-size:14px;color:${INK};margin-top:6px;line-height:1.5;">${esc(t.headline)}</div>
      <div style="font-size:11px;color:${MUTED};margin-top:8px;">${esc(t.basis)}</div>
    </td></tr>
  </table>`

const statCard = (label, value, foot) => `
  <td style="padding:0 6px;" width="25%">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7faf8;border:1px solid ${LINE};border-radius:8px;">
      <tr><td style="padding:12px 14px;">
        <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};">${esc(label)}</div>
        <div style="font-size:22px;font-weight:600;color:${INK};margin-top:2px;">${esc(value)}</div>
        <div style="font-size:11px;color:${MUTED};margin-top:2px;">${esc(foot ?? '')}</div>
      </td></tr>
    </table>
  </td>`

/**
 * What came with the message.
 *
 * The figures a branch works from are in the attached spreadsheets, where they
 * can be sorted, filtered and printed. Repeating them as an HTML table made the
 * message long enough for Gmail to clip it, and a clipped list is worse than no
 * list — so the body says what was sent and what each file holds, and the
 * numbers live in the files.
 */
const fileCard = (files) =>
  !files.length
    ? ''
    : `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 0;background:#f7faf8;border:1px solid ${LINE};border-radius:8px;">
        <tr><td style="padding:16px 18px;">
          <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};margin-bottom:10px;">
            Attached &middot; ${files.length} file${files.length === 1 ? '' : 's'}
          </div>
          ${files
            .map(
              (f) => `<div style="padding:6px 0;">
                <span style="display:inline-block;padding:2px 7px;margin-right:8px;border-radius:4px;background:#e8efe9;color:${BRAND};font-size:10px;font-weight:700;letter-spacing:0.04em;">XLSX</span>
                <span style="font-size:13px;font-weight:600;color:${INK};">${esc(f.filename)}</span>
                <div style="font-size:12px;color:${MUTED};margin:2px 0 0 40px;">${esc(f.note)}</div>
              </div>`
            )
            .join('')}
          <div style="font-size:11px;color:${MUTED};margin-top:10px;">
            Opens in Excel. Every row the dashboard has is in the workbook, not only what would fit here.
          </div>
        </td></tr>
      </table>`

/** The one-line lead that says what this message is. */
const lead = (text) =>
  `<div style="font-size:13.5px;line-height:1.55;color:${INK};margin:0 0 18px;">${text}</div>`

/* ------------------------------------------------------------ fetching --- */

const CONTEXT_DAYS = 30

/**
 * Tomorrow's plan for one brand, optionally narrowed to a set of locations,
 * together with how far the plan has been worth trusting lately.
 *
 * The trust figure is computed from the same code the dashboard uses, so the
 * sentence in the email and the panel on the screen cannot say different
 * things — which is the whole point of sending it.
 */
async function planFor(brand, locations = null) {
  const filters = {
    brand: brand.code,
    ...(brand.chain ? { brands: [brand.chain] } : {}),
    ...(locations?.length ? { locations } : {}),
  }
  const [rows, kpis, slicers] = await Promise.all([
    data.productionPlan(filters, brand.datasetId),
    data.productionPlanKpis(filters, brand.datasetId).catch(() => ({})),
    data.slicers({ brand: brand.code, ...(brand.chain ? { brands: [brand.chain] } : {}) }, brand.datasetId, DATE_ONLY),
  ])

  const today = slicers?.dateRange?.today ?? null
  const last = slicers?.dateRange?.lastActual ?? slicers?.dateRange?.max ?? null

  let trust = null
  if (last) {
    const from = new Date(Date.parse(`${last}T00:00:00Z`) - (CONTEXT_DAYS - 1) * DAY)
      .toISOString()
      .slice(0, 10)
    const window = { ...filters, dateFrom: from, dateTo: last }
    const [trend, byLocation] = await Promise.all([
      data.trend(window, brand.datasetId).catch(() => []),
      data.byLocation(window, brand.datasetId).catch(() => []),
    ])
    trust = trustNote(buildContext({ trend, byLocation, today }))
  }

  return { brand, rows: rows ?? [], kpis: kpis ?? {}, today, trust }
}

const sumQty = (rows) => rows.reduce((n, r) => n + (Number(r.Tomorrow_Forecast_Qty) || 0), 0)
const countExtra = (rows) => rows.filter((r) => r.Prep_Status === 'Extra Prep Needed').length
const countReduced = (rows) => rows.filter((r) => r.Prep_Status === 'Reduced Prep Needed').length

/* ------------------------------------------------------- store report ---- */

/**
 * One branch's prep list. Ordered by volume, because that is the order a
 * kitchen works in, and capped so the message stays readable on a phone —
 * the tail is genuinely single units.
 */
export function storeReportHtml({ brand, location, rows, day, trust, attached = [] }) {
  const ordered = [...rows].sort(
    (a, b) => (Number(b.Tomorrow_Forecast_Qty) || 0) - (Number(a.Tomorrow_Forecast_Qty) || 0)
  )
  const extra = countExtra(ordered)
  const top = ordered[0]

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:-6px -6px 18px;">
      <tr>
        ${statCard('Products to prep', int(ordered.length), 'On tomorrow’s plan')}
        ${statCard('Total units', int(sumQty(ordered)), 'Forecast for the day')}
        ${statCard('Extra prep', int(extra), 'Demand up sharply')}
        ${statCard('Reduced prep', int(countReduced(ordered)), 'Demand down sharply')}
      </tr>
    </table>

    ${lead(
      `Tomorrow’s prep list for <strong>${esc(location)}</strong>${
        attached.length ? ' is attached as a spreadsheet' : ' is on the dashboard'
      }.` +
        (top
          ? ` The largest single line is <strong>${esc(top.ProductName_Fixed_Option)}</strong> at ${int(
              top.Tomorrow_Forecast_Qty
            )} units.`
          : '')
    )}

    ${trust ? trustBlock(trust) : ''}

    ${
      extra > 0
        ? `<div style="padding:10px 14px;background:#fef3e2;border-radius:8px;font-size:13px;color:${INK};">
             <strong>${int(extra)} product${extra === 1 ? '' : 's'} need more than usual tomorrow.</strong>
             They are flagged in the attached file &mdash; worth checking stock tonight.
           </div>`
        : ''
    }

    ${fileCard(attached)}`

  return shell(`${location} — prep for tomorrow`, `${brand.label} · ${longDate(day)}`, body)
}

/* ------------------------------------------------- stakeholder report ---- */

/**
 * Tomorrow across everything the reader can see, per store.
 *
 * Store level was the explicit ask, so the store table is the body of the
 * report and the brand totals are only there to give it a denominator.
 */
export function stakeholderReportHtml({ brands, day, trust, attached = [] }) {
  const stores = []
  for (const b of brands) {
    const byLocation = new Map()
    for (const r of b.rows) {
      const key = r.LocationID || '—'
      const prev = byLocation.get(key) ?? {
        brand: b.brand.label,
        brandCode: b.brand.code,
        location: key,
        qty: 0,
        products: 0,
        extra: 0,
        reduced: 0,
        recent: 0,
      }
      prev.qty += Number(r.Tomorrow_Forecast_Qty) || 0
      prev.recent += Number(r.Last_Avg_Actual) || 0
      prev.products += 1
      if (r.Prep_Status === 'Extra Prep Needed') prev.extra += 1
      if (r.Prep_Status === 'Reduced Prep Needed') prev.reduced += 1
      byLocation.set(key, prev)
    }
    stores.push(...byLocation.values())
  }

  // Sorted by how far tomorrow departs from the recent norm, not by size. The
  // biggest branch is the biggest every day; the one about to do 40% more than
  // usual is the news.
  const withShift = stores.map((s) => ({
    ...s,
    shift: s.recent > 0 ? (s.qty - s.recent) / s.recent : 0,
  }))
  const ranked = [...withShift].sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift))

  const totalQty = stores.reduce((n, s) => n + s.qty, 0)
  const totalExtra = stores.reduce((n, s) => n + s.extra, 0)
  const totalProducts = stores.reduce((n, s) => n + s.products, 0)
  const movers = ranked.filter((s) => Math.abs(s.shift) >= 0.2).slice(0, 6)

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:-6px -6px 18px;">
      <tr>
        ${statCard('Stores', int(stores.length), `Across ${brands.length} brand${brands.length === 1 ? '' : 's'}`)}
        ${statCard('Units forecast', int(totalQty), 'Total for tomorrow')}
        ${statCard('Products', int(totalProducts), 'Lines on the plans')}
        ${statCard('Extra prep', int(totalExtra), 'Lines with demand up')}
      </tr>
    </table>

    ${lead(
      `Tomorrow across <strong>${int(stores.length)}</strong> store${stores.length === 1 ? '' : 's'}. ` +
        (attached.length
          ? 'Every store and every line is in the attached workbook; the few worth a second look are below.'
          : 'The few worth a second look are below; the rest are on the dashboard.')
    )}

    ${trust ? trustBlock(trust) : ''}

    ${
      movers.length
        ? `<div style="padding:14px 16px;background:#f7faf8;border:1px solid ${LINE};border-radius:8px;">
             <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};margin-bottom:8px;">Furthest from a normal day</div>
             ${movers
               .map(
                 (s) =>
                   `<div style="font-size:13px;color:${INK};padding:3px 0;">
                      <strong>${esc(s.location)}</strong>
                      <span style="color:${MUTED};font-size:12px;"> · ${esc(s.brand)}</span>
                      &nbsp;${change(s.shift)}
                      <span style="color:${MUTED};font-size:12px;"> (${int(s.qty)} vs ${int(s.recent)} usual)</span>
                    </div>`
               )
               .join('')}
           </div>`
        : ''
    }

    ${fileCard(attached)}`

  return shell('Tomorrow across your stores', longDate(day), body)
}

/* --------------------------------------------------------- recipients --- */

export async function buildForRecipient(r, digest = null) {
  if (r.skip) return []

  if (r.report === 'daily_digest') {
    const html = digestReportHtml(digest)
    if (!html) return []
    return [
      {
        subject: `Yesterday, every brand · ${longDate(digest.measuredTo)}`,
        html,
        attachments: [
          {
            filename: `accuracy-${digest.measuredTo ?? digest.day}.xlsx`,
            contentType: XLSX_TYPE,
            content: workbook([digestSheet(digest.daily)]),
          },
        ],
        meta: { report: 'daily_digest', day: digest.day },
      },
    ]
  }

  if (r.report === 'store_plan') {
    const messages = []
    for (const brand of r.brandObjects) {
      // This brand's branches, not every branch on the recipient: BBT:ADL is a
      // different store from SS:ADL, and only one of them was asked for.
      const branches = branchesOf(r.locations, brand.code)
      if (!branches.length) continue
      const plan = await planFor(brand, branches)
      for (const location of branches) {
        const rows = plan.rows.filter((x) => String(x.LocationID) === String(location))
        if (!rows.length) continue
        const day = tomorrowFrom(plan.today)
        const attached = [
          {
            filename: `${brand.code}-${location}-prep-${day}.xlsx`,
            note: 'Every product on tomorrow’s plan, with the quantity to prepare, the recent daily average and its prep status.',
          },
        ]
        messages.push({
          subject: `${location} · prep for tomorrow, ${longDate(day)}`,
          html: storeReportHtml({ brand, location, rows, day, trust: plan.trust, attached }),
          attachments: [
            {
              filename: attached[0].filename,
              contentType: XLSX_TYPE,
              content: workbook([planSheet(rows)]),
            },
          ],
          meta: { report: 'store_plan', brand: brand.code, location, rows: rows.length, units: sumQty(rows) },
        })
      }
    }
    return messages
  }

  if (r.report === 'branch_forecast') {
    const messages = []
    for (const brand of r.brandObjects) {
      const branches = branchesOf(r.locations, brand.code)
      if (!branches.length) continue
      const plan = await planFor(brand, branches)
      for (const location of branches) {
        const rows = plan.rows.filter((x) => String(x.LocationID) === String(location))
        if (!rows.length) continue
        const day = tomorrowFrom(plan.today)

        // The prepared items for this branch, from the recipe side. Its own
        // query per branch, and its own failure: a recipe model that will not
        // answer should cost this section, not the whole forecast.
        const prepared = await data
          .componentLevel(
            {
              brand: brand.code,
              ...(brand.chain ? { brands: [brand.chain] } : {}),
              locations: [location],
              dateFrom: day,
              dateTo: day,
            },
            brand.datasetId
          )
          .then((all) => all.filter((r) => r['Node Type'] === 'PA'))
          .catch(() => [])

        // Three files: the forecast summed to product level for planning a
        // shift, the article detail somebody books stock against, and what the
        // kitchen has to make itself.
        const sheets = [
          productSheet(rows),
          planSheet(rows),
          ...(prepared.length ? [preparedSheet(prepared)] : []),
        ]
        const attached = [
          {
            filename: `${brand.code}-${location}-forecast-${day}.xlsx`,
            note: `${sheets.length} tabs — Products (what to plan the shift around), Product PLU (the codes stock and production are booked on)${
              prepared.length ? ', To prepare (what the kitchen makes itself)' : ''
            }.`,
          },
        ]

        messages.push({
          subject: `${brand.code}-${location} · forecast for tomorrow, ${longDate(day)}`,
          html: branchForecastHtml({ brand, location, rows, day, trust: plan.trust, prepared, attached }),
          attachments: [
            { filename: attached[0].filename, contentType: XLSX_TYPE, content: workbook(sheets) },
          ],
          meta: {
            report: 'branch_forecast',
            brand: brand.code,
            location,
            articles: rows.length,
            units: sumQty(rows),
          },
        })
      }
    }
    return messages
  }

  // brand_summary
  const brands = []
  let day = null
  for (const brand of r.brandObjects) {
    // A summary with no branches chosen covers the whole brand, as it always has.
    const branches = r.locations?.length ? branchesOf(r.locations, brand.code) : null
    if (branches && !branches.length) continue
    const plan = await planFor(brand, branches)
    if (!plan.rows.length) continue
    brands.push(plan)
    day = day ?? tomorrowFrom(plan.today)
  }
  if (!brands.length) return []

  return [
    {
      subject: `Tomorrow across your stores · ${longDate(day)}`,
      attachments: [
        {
          filename: `tomorrow-${day}.xlsx`,
          contentType: XLSX_TYPE,
          content: workbook([
            productSheet(brands.flatMap((b) => b.rows)),
            planSheet(brands.flatMap((b) => b.rows)),
          ]),
        },
      ],
      html: stakeholderReportHtml({
        brands,
        day,
        trust: [...brands].sort((a, b) => sumQty(b.rows) - sumQty(a.rows))[0]?.trust ?? null,
        attached: [
          {
            filename: `tomorrow-${day}.xlsx`,
            note: 'Two tabs — every store by product, and the same plan by PLU, with the recent average and prep status.',
          },
        ],
      }),
      meta: {
        report: 'brand_summary',
        brands: brands.map((b) => b.brand.code),
        stores: new Set(brands.flatMap((b) => b.rows.map((x) => x.LocationID))).size,
      },
    },
  ]
}

/** Brand objects for a preview, without needing a real account. */
export function brandByCode(code) {
  return config.brands.find((b) => b.code === code) ?? null
}

export { planFor, tomorrowFrom, longDate }

/* ------------------------------------------------------ digest report ---- */

/**
 * Yesterday across every brand, as an email.
 *
 * Built from the stored digest rather than recomputed, so the mail and the
 * admin page cannot disagree about what this morning looked like.
 */
export function digestReportHtml(digest) {
  if (!digest) return null

  const tone = (state) =>
    state === 'bad' ? RED : state === 'warn' ? AMBER : state === 'good' ? GREEN : MUTED

  const findings = (digest.findings ?? [])
    .map(
      (f) => `
      <tr ${TR}>
        ${td(`<strong>${esc(f.title)}</strong><div style="font-size:12px;color:${MUTED};margin-top:2px;">${esc(f.detail ?? '')}</div>`)}
      </tr>`
    )
    .join('')

  const body = `
    <div style="font-size:13px;color:${MUTED};margin-bottom:14px;">
      Accuracy is ${esc(digest.measuredTo ?? '')} alone &mdash; the last day with all its sales in &mdash;
      against a 90% threshold.
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 -5px 8px;">
      ${chunkRows(digest.daily ?? [], tone)}
    </table>

    ${
      findings
        ? `<div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};margin:18px 0 6px;">Needs a look</div>
           <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">${findings}</table>`
        : `<div style="padding:12px 14px;background:#e8f5ee;border-radius:8px;font-size:13px;color:${INK};margin-top:14px;">Nothing needs attention this morning.</div>`
    }`

  return shell('Yesterday, every brand', longDate(digest.measuredTo), body)
}

/** Three tiles to a row, built as real table rows so Outlook lays them out. */
function chunkRows(daily, tone) {
  const out = []
  for (let i = 0; i < daily.length; i += 3) {
    const group = daily.slice(i, i + 3)
    const tds = group
      .map(
        (d) => `
        <td width="33%" style="padding:0 5px 10px;vertical-align:top;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7faf8;border-left:3px solid ${tone(d.state)};border-radius:6px;">
            <tr><td style="padding:10px 12px;">
              <div style="font-size:11px;color:${MUTED};">${esc(d.brandLabel)}</div>
              <div style="font-size:19px;font-weight:600;color:${d.state === 'good' ? INK : tone(d.state)};">${
                d.accuracy === null ? '&mdash;' : `${(d.accuracy * 100).toFixed(1)}%`
              }</div>
              <div style="font-size:11px;color:${MUTED};">${
                d.accuracy === null ? 'no completed day' : `${int(d.actual)} sold vs ${int(d.forecast)}`
              }</div>
            </td></tr>
          </table>
        </td>`
      )
      .join('')
    out.push(`<tr>${tds}</tr>`)
  }
  return out.join('')
}
