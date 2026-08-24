import { db } from '../db/index.js'
import { config } from '../config.js'
export { DEPARTMENTS } from '../departments.js'

/**
 * Who receives what, chosen explicitly by an administrator.
 *
 * This used to be inferred from user accounts — every active store user got a
 * prep list, every stakeholder got a summary. That was tidy and wrong: the
 * people who need a branch's prep list at 7am are not always the people with a
 * dashboard login. A distribution list, an area manager, a kitchen tablet's
 * shared mailbox — none of those have accounts, and all of them are legitimate.
 *
 * So a recipient is just an address, a report, and a scope. It may be linked to
 * an account, and is when one was the source, but it does not need to be.
 */

export const REPORTS = {
  store_plan: {
    label: "Tomorrow's prep list",
    detail: 'One branch, what to prepare. Needs at least one store.',
    needsLocation: true,
  },
  branch_forecast: {
    label: 'Branch forecast',
    detail: "Tomorrow for one branch, by product and by article code. Needs at least one store.",
    needsLocation: true,
  },
  brand_summary: {
    label: 'Tomorrow across stores',
    detail: 'Every store in the chosen brands, ranked by how far from a normal day.',
    needsLocation: false,
  },
  daily_digest: {
    label: 'Morning digest',
    detail: "Yesterday's accuracy for every brand, and anything that needs attention.",
    needsLocation: false,
  },
}

const parse = (json) => {
  if (!json) return null
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) && v.length ? v : null
  } catch {
    return null
  }
}

/** Brand objects for a recipient; null scope means every brand. */
function brandsFor(codes) {
  if (!codes) return config.brands
  const wanted = codes.map((c) => String(c).toLowerCase())
  return config.brands.filter((b) => wanted.includes(b.code.toLowerCase()))
}

/**
 * Which of a recipient's branches belong to one brand.
 *
 * The same three letters can name a branch in two chains — ADL is a BBT store
 * and a Shawarma Shakir store — so a branch is written down as BBT:ADL, and the
 * form lists them under the brand they belong to. Somebody who wants BBT's ADL
 * and not Shakir's can now say so.
 *
 * A bare "ADL" is the older way of writing it and still means "in every brand
 * this recipient covers", which is what those rows have always done.
 */
export function branchesOf(locations = [], brandCode) {
  const out = []
  for (const entry of locations) {
    const text = String(entry)
    const at = text.indexOf(':')
    if (at < 0) out.push(text)
    else if (text.slice(0, at).toLowerCase() === String(brandCode).toLowerCase()) out.push(text.slice(at + 1))
  }
  return [...new Set(out)]
}

/** How a branch reads in the admin list: BBT-ADL rather than a bare ADL. */
const readable = (entry) => String(entry).replace(':', '-')

function shape(row) {
  const brands = parse(row.brands)
  const locations = parse(row.locations)
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    report: row.report,
    reportLabel: REPORTS[row.report]?.label ?? row.report,
    department: row.department ?? null,
    brands,
    locations,
    active: Boolean(row.active),
    userId: row.user_id ?? null,
    createdAt: row.created_at,
    // Spelled out so the admin list can be read without decoding two JSON
    // columns in your head.
    summary:
      row.report === 'store_plan'
        ? locations?.length
          ? `Prep list for ${locations.map(readable).join(', ')}`
          : 'No store chosen — nothing will be sent'
        : row.report === 'daily_digest'
          ? 'Every brand, yesterday'
          : `Tomorrow across ${brands?.length ? brands.join(', ') : 'every brand'}`,
  }
}

export function listRecipients() {
  return db
    .prepare('SELECT * FROM email_recipients ORDER BY report, email')
    .all()
    .map(shape)
}

/** Active recipients, resolved to the brands and stores each one covers. */
export function dueRecipients() {
  return db
    .prepare('SELECT * FROM email_recipients WHERE active = 1 ORDER BY report, email')
    .all()
    .map((row) => {
      const r = shape(row)
      return { ...r, brandObjects: brandsFor(r.brands) }
    })
    .map((r) => {
      if (REPORTS[r.report]?.needsLocation && !r.locations?.length) {
        return { ...r, skip: 'no store chosen — a prep list needs one branch' }
      }
      if (!r.brandObjects.length) return { ...r, skip: 'none of the chosen brands exist any more' }
      return r
    })
}

export function createRecipient(
  { email, name, report, department = null, brands, locations, active = true, userId = null },
  actorId
) {
  const info = db
    .prepare(
      `INSERT INTO email_recipients (email, name, report, department, brands, locations, active, user_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(email).trim(),
      name ? String(name).trim() : null,
      report,
      department,
      brands?.length ? JSON.stringify(brands) : null,
      locations?.length ? JSON.stringify(locations) : null,
      active ? 1 : 0,
      userId,
      actorId
    )
  return Number(info.lastInsertRowid)
}

export function updateRecipient(id, patch) {
  const row = db.prepare('SELECT * FROM email_recipients WHERE id = ?').get(id)
  if (!row) return null

  const next = {
    name: patch.name !== undefined ? (patch.name ? String(patch.name).trim() : null) : row.name,
    report: patch.report ?? row.report,
    department:
      patch.department !== undefined
        ? patch.department
          ? String(patch.department)
          : null
        : row.department,
    brands:
      patch.brands !== undefined
        ? patch.brands?.length
          ? JSON.stringify(patch.brands)
          : null
        : row.brands,
    locations:
      patch.locations !== undefined
        ? patch.locations?.length
          ? JSON.stringify(patch.locations)
          : null
        : row.locations,
    active: patch.active !== undefined ? (patch.active ? 1 : 0) : row.active,
  }

  db.prepare(
    `UPDATE email_recipients
        SET name = ?, report = ?, department = ?, brands = ?, locations = ?, active = ?
      WHERE id = ?`
  ).run(next.name, next.report, next.department, next.brands, next.locations, next.active, id)

  return shape(db.prepare('SELECT * FROM email_recipients WHERE id = ?').get(id))
}

export function deleteRecipient(id) {
  return db.prepare('DELETE FROM email_recipients WHERE id = ?').run(id).changes
}
