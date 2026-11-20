/**
 * Classifications in the app's own database - until Snowflake is connected.
 * 19 Nov 2026, on request: admins and the Cost Controller department must be
 * able to classify articles now, and the Snowflake account is still with IT.
 *
 * The same rules as the Snowflake store (store.js), the same shape back:
 *
 *   - a row only for an article somebody has changed by hand; everything else
 *     follows Recipe File SWiSH live, so no refresh can overwrite a choice;
 *   - a VERSION on every row, checked by the write itself, so two people
 *     saving at once get a conflict rather than one silently losing;
 *   - the change and its audit row are ONE statement (a data-modifying CTE),
 *     so neither can exist without the other - Postgres runs a statement
 *     atomically on any connection, which `pg.tx` cannot promise on a pool;
 *   - the audit table is only ever inserted into.
 *
 * When Snowflake is configured, store.js copies these rows across the first
 * time it creates its own tables (`localRowsForCarryOver`), and from then on
 * this store is no longer written to. It is kept as it was, as a record.
 */
import { pg } from '../db/accounts.js'

let ready = null

export function ensureLocalSchema(db = pg) {
  if (!ready) {
    ready = db
      .exec(
        `CREATE TABLE IF NOT EXISTS costing_article_classification (
           article_id TEXT PRIMARY KEY,
           article_name TEXT,
           initial_classification TEXT NOT NULL,
           current_classification TEXT NOT NULL,
           is_manual_override BOOLEAN NOT NULL,
           version INTEGER NOT NULL,
           updated_by TEXT,
           updated_by_name TEXT,
           updated_by_user_id INTEGER,
           updated_at TIMESTAMPTZ,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE TABLE IF NOT EXISTS costing_classification_audit (
           audit_id BIGSERIAL PRIMARY KEY,
           article_id TEXT NOT NULL,
           article_name TEXT,
           field_name TEXT NOT NULL,
           previous_value TEXT,
           new_value TEXT,
           updated_by TEXT NOT NULL,
           updated_by_name TEXT,
           updated_by_user_id INTEGER,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE INDEX IF NOT EXISTS costing_classification_audit_article
           ON costing_classification_audit (article_id, audit_id);`
      )
      .catch((err) => {
        ready = null
        throw err
      })
  }
  return ready
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null)

export async function loadLocalClassifications(db = pg) {
  await ensureLocalSchema(db)
  const rows = await db.all(`SELECT * FROM costing_article_classification`)
  const out = new Map()
  for (const r of rows) {
    out.set(String(r.article_id), {
      articleId: String(r.article_id),
      articleName: r.article_name,
      initial: r.initial_classification,
      current: r.current_classification,
      overridden: Boolean(r.is_manual_override),
      version: Number(r.version),
      updatedBy: r.updated_by,
      updatedByName: r.updated_by_name,
      updatedAt: iso(r.updated_at),
    })
  }
  return out
}

/**
 * One change. The caller (store.js) has already validated the inputs and
 * decided who the user is; this only applies the rules above.
 */
export async function setLocalClassification(
  { articleId, articleName, initial, next, expectedVersion, who, whoName, userId, conflict },
  db = pg
) {
  await ensureLocalSchema(db)
  const held = await db.get(
    `SELECT current_classification, version FROM costing_article_classification WHERE article_id = ?`,
    [articleId]
  )
  const currentVersion = held ? Number(held.version) : 0
  if (Number(expectedVersion ?? 0) !== currentVersion) {
    throw conflict('This article was changed by someone else since you opened the page. Reload to see the latest classification.')
  }
  const previous = held ? held.current_classification : initial
  if (previous === next) return { changed: false, version: currentVersion, current: previous }

  const audit = `INSERT INTO costing_classification_audit
                   (article_id, article_name, field_name, previous_value, new_value,
                    updated_by, updated_by_name, updated_by_user_id, updated_at)
                 SELECT article_id, article_name, 'Classification', ?, current_classification,
                        updated_by, updated_by_name, updated_by_user_id, updated_at FROM changed
                 RETURNING audit_id`

  const result = held
    ? await db.all(
        `WITH changed AS (
           UPDATE costing_article_classification
              SET current_classification = ?, is_manual_override = TRUE, version = version + 1,
                  article_name = COALESCE(?, article_name),
                  updated_by = ?, updated_by_name = ?, updated_by_user_id = ?, updated_at = now()
            WHERE article_id = ? AND version = ?
            RETURNING *
         ) ${audit}`,
        [next, articleName ?? null, who, whoName, userId, articleId, currentVersion, previous]
      )
    : await db.all(
        `WITH changed AS (
           INSERT INTO costing_article_classification
             (article_id, article_name, initial_classification, current_classification, is_manual_override,
              version, updated_by, updated_by_name, updated_by_user_id, updated_at)
           VALUES (?, ?, ?, ?, TRUE, 1, ?, ?, ?, now())
           ON CONFLICT (article_id) DO NOTHING
           RETURNING *
         ) ${audit}`,
        [articleId, articleName ?? null, initial, next, who, whoName, userId, previous]
      )

  if (!result.length) {
    throw conflict('This article was changed by someone else just now. Reload and try again.')
  }

  const after = await db.get(
    `SELECT version, updated_by, updated_by_name, updated_at FROM costing_article_classification WHERE article_id = ?`,
    [articleId]
  )
  return {
    changed: true,
    previous,
    current: next,
    version: Number(after.version),
    updatedBy: after.updated_by,
    updatedByName: after.updated_by_name,
    updatedAt: iso(after.updated_at),
  }
}

export async function localAuditHistory(articleId, db = pg) {
  await ensureLocalSchema(db)
  const rows = await db.all(
    `SELECT * FROM costing_classification_audit WHERE article_id = ? ORDER BY audit_id ASC`,
    [articleId]
  )
  return rows.map((r) => ({
    id: Number(r.audit_id),
    articleId: String(r.article_id),
    articleName: r.article_name,
    field: r.field_name,
    previous: r.previous_value,
    next: r.new_value,
    updatedBy: r.updated_by,
    updatedByName: r.updated_by_name,
    updatedAt: iso(r.updated_at),
  }))
}

/** Everything held here, for the one-time copy into Snowflake. */
export async function localRowsForCarryOver(db = pg) {
  await ensureLocalSchema(db)
  const [classifications, audit] = await Promise.all([
    db.all(`SELECT * FROM costing_article_classification ORDER BY article_id`),
    db.all(`SELECT * FROM costing_classification_audit ORDER BY audit_id`),
  ])
  return { classifications, audit }
}
