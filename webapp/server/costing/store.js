/**
 * Persistence for the Monthly MC Analysis page, in Snowflake - 19 Nov 2026.
 *
 * Three tables in SNOWFLAKE_DATABASE.SNOWFLAKE_SCHEMA:
 *
 *   COSTING_ARTICLE_CLASSIFICATION   one row per article that has been
 *       manually classified: its initial (Recipe File SWiSH) classification
 *       at the time, the current one, and who changed it last. An article with
 *       NO row has never been touched and follows the Recipe File live - so a
 *       refresh can never overwrite a manual choice, because refreshes never
 *       write here at all.
 *
 *   COSTING_CLASSIFICATION_AUDIT     APPEND-ONLY. One row per change, never
 *       updated or deleted by the application.
 *
 *   COSTING_VARIANCE_ALERT           one row per article + brand + month +
 *       threshold that crossed the threshold, with its delivery status.
 *       ALERT_KEY makes each alert unique; rows are only ever inserted by
 *       MERGE ... WHEN NOT MATCHED, so a re-run cannot create a duplicate.
 *
 * Snowflake records PRIMARY KEY / UNIQUE but does not enforce them, so the
 * guarantees above are enforced here: MERGE for inserts, and a VERSION column
 * checked on every update so two people editing the same article at once get
 * a conflict instead of one silently losing the other's change.
 */
import * as snowflake from './snowflake.js'
import * as localStore from './localStore.js'

const { table } = snowflake

/*
 * The statements go through `db`, so the tests can run every rule in this file
 * - the version check, the no-op, the audit row, the duplicate-proof MERGE -
 * against an in-memory stand-in rather than a live warehouse.
 */
const LIVE = { query: snowflake.query, transaction: snowflake.transaction }
let db = LIVE
const query = (...a) => db.query(...a)
const transaction = (...a) => db.transaction(...a)

/*
 * Where classifications live RIGHT NOW - 19 Nov 2026.
 *
 * Snowflake when it is configured (or a test has injected a driver), and the
 * app's own database until then, so the page can be edited before IT has set
 * the Snowflake account up. The first Snowflake run copies the local rows
 * across - see `carryOverLocal`. Alerts are NOT stored locally: they stay off
 * until Snowflake is connected, as agreed.
 */
let local = {
  load: localStore.loadLocalClassifications,
  set: localStore.setLocalClassification,
  history: localStore.localAuditHistory,
  rows: localStore.localRowsForCarryOver,
}
const onSnowflake = () => db !== LIVE || snowflake.snowflakeConfigured()

/** 'snowflake' or 'local' - which store classification edits go to. */
export const storageMode = () => (onSnowflake() ? 'snowflake' : 'local')

/** Tests only: swap the Snowflake driver for a fake (null restores it). */
export function useDriverForTests(fake, fakeLocal = null) {
  db = fake ?? LIVE
  if (fakeLocal) local = { ...local, ...fakeLocal }
  ensured = null
}

export const CLASSIFICATIONS = ['Recipe', 'Non-Recipe']
export const isClassification = (v) => CLASSIFICATIONS.includes(v)

export const T = {
  classification: () => table('COSTING_ARTICLE_CLASSIFICATION'),
  audit: () => table('COSTING_CLASSIFICATION_AUDIT'),
  alert: () => table('COSTING_VARIANCE_ALERT'),
}

let ensured = null

/** Create the tables if they are not there. Safe to call repeatedly. */
export function ensureSchema() {
  if (!ensured) {
    ensured = (async () => {
      await query(`CREATE TABLE IF NOT EXISTS ${T.classification()} (
        ARTICLE_ID VARCHAR(64) NOT NULL,
        ARTICLE_NAME VARCHAR(500),
        INITIAL_CLASSIFICATION VARCHAR(20) NOT NULL,
        CURRENT_CLASSIFICATION VARCHAR(20) NOT NULL,
        IS_MANUAL_OVERRIDE BOOLEAN NOT NULL,
        VERSION NUMBER(38,0) NOT NULL,
        UPDATED_BY VARCHAR(320),
        UPDATED_BY_NAME VARCHAR(320),
        UPDATED_BY_USER_ID NUMBER(38,0),
        UPDATED_AT TIMESTAMP_TZ,
        CREATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP(),
        CONSTRAINT PK_COSTING_ARTICLE_CLASSIFICATION PRIMARY KEY (ARTICLE_ID)
      )`)
      await query(`CREATE TABLE IF NOT EXISTS ${T.audit()} (
        AUDIT_ID NUMBER(38,0) AUTOINCREMENT START 1 INCREMENT 1,
        ARTICLE_ID VARCHAR(64) NOT NULL,
        ARTICLE_NAME VARCHAR(500),
        FIELD_NAME VARCHAR(100) NOT NULL,
        PREVIOUS_VALUE VARCHAR(500),
        NEW_VALUE VARCHAR(500),
        UPDATED_BY VARCHAR(320) NOT NULL,
        UPDATED_BY_NAME VARCHAR(320),
        UPDATED_BY_USER_ID NUMBER(38,0),
        UPDATED_AT TIMESTAMP_TZ NOT NULL,
        CONSTRAINT PK_COSTING_CLASSIFICATION_AUDIT PRIMARY KEY (AUDIT_ID)
      )`)
      await query(`CREATE TABLE IF NOT EXISTS ${T.alert()} (
        ALERT_ID NUMBER(38,0) AUTOINCREMENT START 1 INCREMENT 1,
        ALERT_KEY VARCHAR(200) NOT NULL,
        ARTICLE_ID VARCHAR(64) NOT NULL,
        ARTICLE_NAME VARCHAR(500),
        BRAND VARCHAR(20) NOT NULL,
        ALERT_MONTH DATE NOT NULL,
        MC_THEORETICAL FLOAT,
        ACTUAL_CONSUMPTION FLOAT,
        VARIANCE_PCT FLOAT,
        ALERT_THRESHOLD FLOAT NOT NULL,
        STATUS VARCHAR(20) NOT NULL,
        ATTEMPTS NUMBER(38,0) DEFAULT 0 NOT NULL,
        LAST_ERROR VARCHAR(2000),
        EMAIL_SENT_AT TIMESTAMP_TZ,
        RECIPIENTS VARCHAR(4000),
        CREATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
        UPDATED_AT TIMESTAMP_TZ,
        CONSTRAINT PK_COSTING_VARIANCE_ALERT PRIMARY KEY (ALERT_ID),
        CONSTRAINT UQ_COSTING_VARIANCE_ALERT_KEY UNIQUE (ALERT_KEY)
      )`)
      await carryOverLocal()
    })().catch((err) => {
      ensured = null // let the next call try again
      throw err
    })
  }
  return ensured
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null)

/**
 * The one-time copy of classifications made in the app's database before
 * Snowflake was connected. Only into an EMPTY Snowflake table, so it can never
 * run twice or mix with edits already made there; the audit rows go with
 * their classifications, original users and times intact. One transaction:
 * all of it arrives or none of it does.
 */
async function carryOverLocal() {
  let held
  try {
    held = await local.rows()
  } catch (err) {
    console.warn(`  [costing] local classifications could not be read for the copy (${err.message})`)
    return
  }
  if (!held.classifications.length) return
  const [{ N } = {}] = await query(`SELECT COUNT(*) AS N FROM ${T.classification()}`)
  if (Number(N) > 0) {
    console.warn(
      `  [costing] ${held.classifications.length} local classification(s) NOT copied: Snowflake already holds classifications`
    )
    return
  }
  await transaction(async (run) => {
    for (const r of held.classifications) {
      await run(
        `INSERT INTO ${T.classification()}
           (ARTICLE_ID, ARTICLE_NAME, INITIAL_CLASSIFICATION, CURRENT_CLASSIFICATION, IS_MANUAL_OVERRIDE,
            VERSION, UPDATED_BY, UPDATED_BY_NAME, UPDATED_BY_USER_ID, UPDATED_AT, CREATED_AT)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TO_TIMESTAMP_TZ(?), TO_TIMESTAMP_TZ(?))`,
        [
          r.article_id, r.article_name, r.initial_classification, r.current_classification,
          Boolean(r.is_manual_override), Number(r.version), r.updated_by, r.updated_by_name,
          r.updated_by_user_id, iso(r.updated_at), iso(r.created_at) ?? iso(r.updated_at),
        ]
      )
    }
    for (const a of held.audit) {
      await run(
        `INSERT INTO ${T.audit()}
           (ARTICLE_ID, ARTICLE_NAME, FIELD_NAME, PREVIOUS_VALUE, NEW_VALUE, UPDATED_BY, UPDATED_BY_NAME,
            UPDATED_BY_USER_ID, UPDATED_AT)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, TO_TIMESTAMP_TZ(?))`,
        [a.article_id, a.article_name, a.field_name, a.previous_value, a.new_value, a.updated_by,
          a.updated_by_name, a.updated_by_user_id, iso(a.updated_at)]
      )
    }
  })
  console.log(
    `  [costing] copied ${held.classifications.length} classification(s) and ${held.audit.length} history row(s) from the app database into Snowflake`
  )
}

/** Every manually classified article. Map(articleId -> row). */
export async function loadClassifications() {
  if (!onSnowflake()) return local.load()
  await ensureSchema()
  const rows = await query(
    `SELECT ARTICLE_ID, ARTICLE_NAME, INITIAL_CLASSIFICATION, CURRENT_CLASSIFICATION,
            IS_MANUAL_OVERRIDE, VERSION, UPDATED_BY, UPDATED_BY_NAME, UPDATED_AT
       FROM ${T.classification()}`
  )
  const out = new Map()
  for (const r of rows) {
    out.set(String(r.ARTICLE_ID), {
      articleId: String(r.ARTICLE_ID),
      articleName: r.ARTICLE_NAME,
      initial: r.INITIAL_CLASSIFICATION,
      current: r.CURRENT_CLASSIFICATION,
      overridden: Boolean(r.IS_MANUAL_OVERRIDE),
      version: Number(r.VERSION),
      updatedBy: r.UPDATED_BY,
      updatedByName: r.UPDATED_BY_NAME,
      updatedAt: iso(r.UPDATED_AT),
    })
  }
  return out
}

/** A refusal the route turns into a 409. */
export class ConflictError extends Error {
  constructor(message) {
    super(message)
    this.status = 409
  }
}

/**
 * Change one article's classification.
 *
 *   articleId, articleName
 *   initial          the Recipe File classification RIGHT NOW (from the server,
 *                    never from the browser)
 *   next             'Recipe' | 'Non-Recipe'
 *   expectedVersion  the VERSION the editor saw; 0 = never classified
 *   user             { id, email, name } of the signed-in account
 *
 * The update and its audit row are one transaction. A version mismatch - the
 * article was changed by somebody else since this editor loaded it - is a
 * ConflictError and changes nothing.
 */
export async function setClassification({ articleId, articleName, initial, next, expectedVersion, user }) {
  if (!isClassification(next)) throw Object.assign(new Error('Classification must be Recipe or Non-Recipe'), { status: 400 })
  if (!isClassification(initial)) throw new Error('Initial classification is not known')
  const who = String(user?.email || user?.name || '').trim()
  if (!who) throw Object.assign(new Error('No signed-in user to record'), { status: 401 })
  // The account's display name, shown beside the date; the email stays the identity.
  const whoName = String(user?.name || '').trim() || who

  if (!onSnowflake()) {
    return local.set({
      articleId,
      articleName,
      initial,
      next,
      expectedVersion,
      who,
      whoName,
      userId: user?.id ?? null,
      conflict: (message) => new ConflictError(message),
    })
  }
  await ensureSchema()

  return transaction(async (run) => {
    const { rows } = await run(
      `SELECT CURRENT_CLASSIFICATION, VERSION FROM ${T.classification()} WHERE ARTICLE_ID = ?`,
      [articleId]
    )
    const held = rows[0]
    const currentVersion = held ? Number(held.VERSION) : 0
    if (Number(expectedVersion ?? 0) !== currentVersion) {
      throw new ConflictError(
        'This article was changed by someone else since you opened the page. Reload to see the latest classification.'
      )
    }
    const previous = held ? held.CURRENT_CLASSIFICATION : initial
    if (previous === next) return { changed: false, version: currentVersion, current: previous }

    if (held) {
      const { affected } = await run(
        `UPDATE ${T.classification()}
            SET CURRENT_CLASSIFICATION = ?, IS_MANUAL_OVERRIDE = TRUE, VERSION = VERSION + 1,
                ARTICLE_NAME = COALESCE(?, ARTICLE_NAME),
                UPDATED_BY = ?, UPDATED_BY_NAME = ?, UPDATED_BY_USER_ID = ?, UPDATED_AT = CURRENT_TIMESTAMP()
          WHERE ARTICLE_ID = ? AND VERSION = ?`,
        [next, articleName ?? null, who, whoName, user?.id ?? null, articleId, currentVersion]
      )
      if (affected === 0) throw new ConflictError('This article was changed by someone else just now. Reload and try again.')
    } else {
      const { affected } = await run(
        `MERGE INTO ${T.classification()} t
         USING (SELECT ? AS ARTICLE_ID) s ON t.ARTICLE_ID = s.ARTICLE_ID
         WHEN NOT MATCHED THEN INSERT
           (ARTICLE_ID, ARTICLE_NAME, INITIAL_CLASSIFICATION, CURRENT_CLASSIFICATION, IS_MANUAL_OVERRIDE,
            VERSION, UPDATED_BY, UPDATED_BY_NAME, UPDATED_BY_USER_ID, UPDATED_AT)
         VALUES (?, ?, ?, ?, TRUE, 1, ?, ?, ?, CURRENT_TIMESTAMP())`,
        [articleId, articleId, articleName ?? null, initial, next, who, whoName, user?.id ?? null]
      )
      if (affected === 0) throw new ConflictError('This article was classified by someone else just now. Reload and try again.')
    }

    await run(
      `INSERT INTO ${T.audit()}
         (ARTICLE_ID, ARTICLE_NAME, FIELD_NAME, PREVIOUS_VALUE, NEW_VALUE, UPDATED_BY, UPDATED_BY_NAME,
          UPDATED_BY_USER_ID, UPDATED_AT)
       VALUES (?, ?, 'Classification', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP())`,
      [articleId, articleName ?? null, previous, next, who, whoName, user?.id ?? null]
    )

    const after = await run(
      `SELECT VERSION, UPDATED_BY, UPDATED_BY_NAME, UPDATED_AT FROM ${T.classification()} WHERE ARTICLE_ID = ?`,
      [articleId]
    )
    const r = after.rows[0] ?? {}
    return {
      changed: true,
      previous,
      current: next,
      version: Number(r.VERSION),
      updatedBy: r.UPDATED_BY,
      updatedByName: r.UPDATED_BY_NAME,
      updatedAt: iso(r.UPDATED_AT),
    }
  })
}

/** One article's complete history, oldest first. */
export async function auditHistory(articleId) {
  if (!onSnowflake()) return local.history(articleId)
  await ensureSchema()
  const rows = await query(
    `SELECT AUDIT_ID, ARTICLE_ID, ARTICLE_NAME, FIELD_NAME, PREVIOUS_VALUE, NEW_VALUE, UPDATED_BY,
            UPDATED_BY_NAME, UPDATED_AT
       FROM ${T.audit()} WHERE ARTICLE_ID = ? ORDER BY UPDATED_AT ASC, AUDIT_ID ASC`,
    [articleId]
  )
  return rows.map((r) => ({
    id: Number(r.AUDIT_ID),
    articleId: String(r.ARTICLE_ID),
    articleName: r.ARTICLE_NAME,
    field: r.FIELD_NAME,
    previous: r.PREVIOUS_VALUE,
    next: r.NEW_VALUE,
    updatedBy: r.UPDATED_BY,
    updatedByName: r.UPDATED_BY_NAME,
    updatedAt: iso(r.UPDATED_AT),
  }))
}

/* ------------------------------------------------------------- alerts -- */

export const alertKey = ({ articleId, brand, month, threshold }) =>
  `${articleId}|${brand}|${String(month).slice(0, 7)}|${threshold}`

/** Has an alert ever been recorded? False on the very first run. */
export async function anyAlerts() {
  await ensureSchema()
  const rows = await query(`SELECT 1 AS X FROM ${T.alert()} LIMIT 1`)
  return rows.length > 0
}

/**
 * Record alerts that are not yet recorded. Existing keys are left exactly as
 * they are - an alert already sent is never re-opened by a later run.
 * Returns how many were new.
 */
export async function recordAlerts(alerts, status) {
  if (!alerts.length) return 0
  await ensureSchema()
  let inserted = 0
  // Batched so one statement never carries thousands of binds.
  for (let i = 0; i < alerts.length; i += 200) {
    const batch = alerts.slice(i, i + 200)
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const binds = batch.flatMap((a) => [
      alertKey(a),
      a.articleId,
      a.articleName ?? null,
      a.brand,
      String(a.month).slice(0, 10),
      a.theoretical,
      a.actual,
      a.variancePct,
      a.threshold,
    ])
    const { affected } = await transaction((run) =>
      run(
        `MERGE INTO ${T.alert()} t
         USING (SELECT column1 AS ALERT_KEY, column2 AS ARTICLE_ID, column3 AS ARTICLE_NAME, column4 AS BRAND,
                       TO_DATE(column5) AS ALERT_MONTH, column6::FLOAT AS MC_THEORETICAL,
                       column7::FLOAT AS ACTUAL_CONSUMPTION, column8::FLOAT AS VARIANCE_PCT,
                       column9::FLOAT AS ALERT_THRESHOLD
                  FROM VALUES ${values}) s
            ON t.ALERT_KEY = s.ALERT_KEY
         WHEN NOT MATCHED THEN INSERT
           (ALERT_KEY, ARTICLE_ID, ARTICLE_NAME, BRAND, ALERT_MONTH, MC_THEORETICAL, ACTUAL_CONSUMPTION,
            VARIANCE_PCT, ALERT_THRESHOLD, STATUS, ATTEMPTS, CREATED_AT, UPDATED_AT)
         VALUES (s.ALERT_KEY, s.ARTICLE_ID, s.ARTICLE_NAME, s.BRAND, s.ALERT_MONTH, s.MC_THEORETICAL,
                 s.ACTUAL_CONSUMPTION, s.VARIANCE_PCT, s.ALERT_THRESHOLD, ?, 0, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        [...binds, status]
      )
    )
    inserted += Number(affected) || 0
  }
  return inserted
}

const alertRow = (r) => ({
  id: Number(r.ALERT_ID),
  key: r.ALERT_KEY,
  articleId: String(r.ARTICLE_ID),
  articleName: r.ARTICLE_NAME,
  brand: r.BRAND,
  month: iso(r.ALERT_MONTH)?.slice(0, 10) ?? null,
  theoretical: r.MC_THEORETICAL === null ? null : Number(r.MC_THEORETICAL),
  actual: r.ACTUAL_CONSUMPTION === null ? null : Number(r.ACTUAL_CONSUMPTION),
  variancePct: r.VARIANCE_PCT === null ? null : Number(r.VARIANCE_PCT),
  threshold: Number(r.ALERT_THRESHOLD),
  status: r.STATUS,
  attempts: Number(r.ATTEMPTS),
  lastError: r.LAST_ERROR,
  sentAt: iso(r.EMAIL_SENT_AT),
  recipients: r.RECIPIENTS,
  createdAt: iso(r.CREATED_AT),
  updatedAt: iso(r.UPDATED_AT),
})

/** Alerts waiting to be emailed: new ones, and failures still under the retry cap. */
export async function alertsToSend(maxAttempts) {
  await ensureSchema()
  const rows = await query(
    `SELECT * FROM ${T.alert()}
      WHERE STATUS = 'pending' OR (STATUS = 'failed' AND ATTEMPTS < ?)
      ORDER BY ALERT_MONTH DESC, ABS(VARIANCE_PCT) DESC`,
    [maxAttempts]
  )
  return rows.map(alertRow)
}

/** Mark a set of alerts sent or failed after one delivery attempt. */
export async function markAlerts(ids, { status, error = null, recipients = null }) {
  if (!ids.length) return
  await ensureSchema()
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500)
    await query(
      `UPDATE ${T.alert()}
          SET STATUS = ?, ATTEMPTS = ATTEMPTS + 1, LAST_ERROR = ?,
              EMAIL_SENT_AT = ${status === 'sent' ? 'CURRENT_TIMESTAMP()' : 'EMAIL_SENT_AT'},
              RECIPIENTS = COALESCE(?, RECIPIENTS), UPDATED_AT = CURRENT_TIMESTAMP()
        WHERE ALERT_ID IN (${batch.map(() => '?').join(', ')})`,
      [status, error ? String(error).slice(0, 2000) : null, recipients, ...batch]
    )
  }
}

/** The alert history for some months (YYYY-MM-01), newest first. */
export async function listAlerts(months, limit = 5000) {
  await ensureSchema()
  if (!months?.length) return []
  const rows = await query(
    `SELECT * FROM ${T.alert()}
      WHERE ALERT_MONTH IN (${months.map(() => 'TO_DATE(?)').join(', ')})
      ORDER BY CREATED_AT DESC, ALERT_ID DESC LIMIT ${Math.max(1, Math.min(20000, Number(limit) || 5000))}`,
    months.map((m) => String(m).slice(0, 10))
  )
  return rows.map(alertRow)
}
