/**
 * Monthly MC Analysis - the Costing Department's page. 19 Nov 2026.
 *
 * Its own router, mounted at /api/costing, because it is the one page that
 * writes (classifications) and it writes to Snowflake rather than the app's
 * database. Reading needs the `costing` page; writing needs the Cost
 * Controller department or the admin role. Every write is done here, on the
 * server, with the signed-in account's identity - the browser never names the
 * user and never sees a Snowflake credential.
 */
import { Router } from 'express'
import { allowedPages } from '../departments.js'
import { allowedBrands, loadScope, requireAuth } from '../auth/middleware.js'
import { snowflakeConfigured, snowflakeStatus } from '../costing/snowflake.js'
import {
  auditHistory,
  isClassification,
  listAlerts,
  loadClassifications,
  setClassification,
  storageMode,
} from '../costing/store.js'
import { loadAnalysis, mcArticleNames, monthPair, recipeArticles } from '../costing/analysis.js'
import { canonArticle } from '../powerbi/consumption.js'
import { COSTING_DEPARTMENT, runVarianceAlerts } from '../costing/alerts.js'

export const costing = Router()

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next)

const norm = (v) => String(v ?? '').trim().toLowerCase()

/** May this account change classifications? */
export const canEditCosting = (user) =>
  user?.role === 'admin' || norm(user?.department) === norm(COSTING_DEPARTMENT)

costing.use(requireAuth, (req, res, next) => {
  const pages = allowedPages(req.user)
  if (pages && !pages.includes('costing')) {
    return res.status(403).json({ error: 'You do not have access to the Monthly MC Analysis page.' })
  }
  loadScope(req.user.id, req.user.role, req.user.department, req.user.pages)
    .then((scope) => {
      req.scope = scope
      next()
    })
    .catch(next)
})

/** The brands this request covers: what was asked for, within what is allowed. */
function brandsFor(req) {
  const allowed = allowedBrands(req.scope).map((b) => b.code.toUpperCase())
  const asked = String(req.query.brands ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  const use = asked.length ? asked.filter((b) => allowed.includes(b)) : allowed
  return new Set(use)
}

/**
 * The stored classifications - from Snowflake, or from the app's database
 * until Snowflake is configured (store.js decides). Only an UNREACHABLE store
 * makes the page read-only.
 */
async function overridesOrReason() {
  const where = storageMode() === 'snowflake' ? 'Snowflake' : 'The app database'
  try {
    return { overrides: await loadClassifications(), storageError: null }
  } catch (err) {
    return { overrides: new Map(), storageError: `${where} could not be read: ${String(err.message).slice(0, 160)}` }
  }
}

costing.get(
  '/analysis',
  handle(async (req, res) => {
    const brands = brandsFor(req)
    if (!brands.size) return res.status(403).json({ error: 'No brands are assigned to your account.' })
    const { overrides, storageError } = await overridesOrReason()
    const out = await loadAnalysis({ month: req.query.month ?? null, brands, overrides })
    res.json({
      ...out,
      // May edit AND can save right now.
      canEdit: canEditCosting(req.user) && !storageError,
      // May edit, whether or not saving is possible - so the page can show the
      // control switched off, with the reason, instead of hiding it.
      editRole: canEditCosting(req.user),
      storageError,
      // 'local' until Snowflake is connected: edits are kept in the app
      // database and copied across then; alert emails are off meanwhile.
      storage: storageMode(),
    })
  })
)

costing.post(
  '/classification',
  handle(async (req, res) => {
    if (!canEditCosting(req.user)) {
      return res.status(403).json({ error: `Only the ${COSTING_DEPARTMENT} department can change classifications.` })
    }
    const articleId = canonArticle(req.body?.articleId)
    const next = req.body?.classification
    if (!articleId) return res.status(400).json({ error: 'articleId is required' })
    if (!isClassification(next)) return res.status(400).json({ error: 'classification must be Recipe or Non-Recipe' })
    const expectedVersion = Number(req.body?.expectedVersion ?? 0)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return res.status(400).json({ error: 'expectedVersion must be a whole number' })
    }

    // The initial classification and the name come from the sources, never
    // from the browser.
    const [recipe, names] = await Promise.all([recipeArticles(), mcArticleNames()])
    const result = await setClassification({
      articleId,
      articleName: names.get(articleId) ?? null,
      initial: recipe.has(articleId) ? 'Recipe' : 'Non-Recipe',
      next,
      expectedVersion,
      user: { id: req.user.id, email: req.user.email, name: req.user.name },
    })
    res.json({ articleId, ...result })
  })
)

costing.get(
  '/history',
  handle(async (req, res) => {
    const articleId = canonArticle(req.query.article)
    if (!articleId) return res.status(400).json({ error: 'article is required' })
    res.json({ articleId, history: await auditHistory(articleId) })
  })
)

costing.get(
  '/alerts',
  handle(async (req, res) => {
    const { current, previous } = monthPair(req.query.month ?? null)
    // Alert records live in Snowflake only; until it is connected there are none.
    if (!snowflakeConfigured()) return res.json({ months: { current, previous }, alerts: [], storage: 'local' })
    const brands = brandsFor(req)
    const alerts = (await listAlerts([current, previous])).filter((a) => brands.has(String(a.brand).toUpperCase()))
    res.json({ months: { current, previous }, alerts })
  })
)

costing.get(
  '/status',
  handle(async (req, res) => {
    res.json({ storage: await snowflakeStatus(), canEdit: canEditCosting(req.user) })
  })
)

/** Run the alert job now - administrators only, for retries and checks. */
costing.post(
  '/alerts/run',
  handle(async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrators only.' })
    res.json(await runVarianceAlerts({ reason: `manual:${req.user.email}` }))
  })
)
