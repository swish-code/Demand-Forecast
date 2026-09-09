/**
 * The five statuses, and the one place that decides which one an article has.
 *
 * These are not our categories. They are the business's own, taken from the
 * Status/Criteria legend in Swish SPS V3 2026 (sheet "LeadTime, Sub, Group"):
 *
 *     Active                  Active
 *     Slow-Moving             Current + 2 Months
 *     Super Slow-Moving       Current + 3 Months
 *     Non-Moving              Current + 4 Months
 *     To Be Deactivated       No Longer uses
 *
 * "Current + N Months" means no movement for the current month plus the N
 * before it — confirmed as movement rather than stock cover. So the whole
 * ladder is one question asked five ways: how long since the warehouse last
 * issued this article?
 *
 * Two deliberate differences from the sheet's wording, both to stop the status
 * changing for reasons that have nothing to do with the article:
 *
 * Rolling days, not calendar months. Read literally, "current + 2 months"
 * re-cuts every article at midnight on the 1st, and a third of the catalogue
 * would change status because the calendar did. Sixty days either side of that
 * boundary is the same intent without the cliff edge.
 *
 * Measured to the end of the window on screen, not to today. The accuracy card
 * is scored over whatever the date slicer shows, so a March window must show
 * the statuses that applied in March. Otherwise the page argues with itself the
 * moment anybody looks backwards.
 *
 * And one deliberate limit: "No Longer uses" is a judgement, not a duration.
 * Nothing here deactivates anything. Past the last threshold the article is
 * *proposed* for deactivation and a person decides — which is why the status
 * carries `proposal: true` rather than an instruction.
 */
import * as cube from '../cube/query.js'

/**
 * Where each rung starts, in days since the last shipment.
 *
 * Read as: up to 60 days is Active, 61-90 is Slow-Moving, and so on, one month
 * per rung exactly as the sheet spaces them. Named rather than written into the
 * comparisons, because these are the numbers most likely to be argued about.
 */
export const THRESHOLDS = {
  active: 60,
  slowMoving: 90,
  superSlowMoving: 120,
  nonMoving: 150,
}

/** How far back "has it moved lately" looks, for the thin-evidence flag. */
export const RECENT_WINDOW_DAYS = 60

/**
 * The statuses themselves, in ladder order.
 *
 * `plan` is what the forecast *should* do with each one. It is a recommendation
 * for a reader, not a rule the code follows: classifying an article and changing
 * what is forecast for it are separate decisions, and only the first has been
 * taken. Nothing here suppresses anything.
 */
export const STATUSES = [
  {
    key: 'active',
    label: 'Active',
    criteria: 'Active',
    plain: 'Shipped within the last 60 days',
    tone: 'green',
    plan: 'Forecast normally',
  },
  {
    key: 'slow-moving',
    label: 'Slow-Moving',
    criteria: 'Current + 2 Months',
    plain: 'Nothing shipped for 2 months and the current one',
    tone: 'amber',
    plan: 'Forecast as occasional demand — how often, and how much each time',
  },
  {
    key: 'super-slow-moving',
    label: 'Super Slow-Moving',
    criteria: 'Current + 3 Months',
    plain: 'Nothing shipped for 3 months and the current one',
    tone: 'amber',
    plan: 'Forecast nothing, and flag for review',
  },
  {
    key: 'non-moving',
    label: 'Non-Moving',
    criteria: 'Current + 4 Months',
    plain: 'Nothing shipped for 4 months and the current one',
    tone: 'red',
    plan: 'Forecast nothing, and flag for review',
  },
  {
    key: 'to-be-deactivated',
    label: 'To Be Deactivated',
    criteria: 'No Longer uses',
    plain: 'Nothing shipped for more than 5 months',
    tone: 'slate',
    plan: 'Forecast nothing, and propose deactivation for somebody to decide',
    proposal: true,
  },
  {
    /*
     * Not on the sheet, and it has to exist.
     *
     * An article the warehouse has never issued is not "not moving any more" —
     * there is nothing to have stopped. Calling it Non-Moving would put items
     * that were only ever direct-supplied into a queue for deactivation.
     */
    key: 'never-shipped',
    label: 'Never shipped',
    criteria: 'No warehouse history',
    plain: 'The warehouse has never issued this article',
    tone: 'slate',
    plan: 'Outside the warehouse forecast entirely',
  },
]

const BY_KEY = new Map(STATUSES.map((s) => [s.key, s]))

/** One status by key, for anything that needs the label or the tone. */
export const statusOf = (key) => BY_KEY.get(key) ?? null

const DAY = 86_400_000
const iso = (d) => new Date(d).toISOString().slice(0, 10)
const daysBetween = (from, to) =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY)

/**
 * One article's status from its shipping record.
 *
 * Split out from the query so it can be reasoned about, and tested, without a
 * database: give it a last-shipped date and a date to measure to, and it is
 * pure arithmetic from there.
 */
export function classifyOne(record, asAt) {
  if (!record?.lastShipped) {
    return {
      status: 'never-shipped',
      daysIdle: null,
      lastShipped: null,
      firstShipped: null,
      recentDays: 0,
      thinEvidence: false,
    }
  }

  const daysIdle = Math.max(0, daysBetween(record.lastShipped, asAt))
  const t = THRESHOLDS
  const status =
    daysIdle <= t.active
      ? 'active'
      : daysIdle <= t.slowMoving
        ? 'slow-moving'
        : daysIdle <= t.superSlowMoving
          ? 'super-slow-moving'
          : daysIdle <= t.nonMoving
            ? 'non-moving'
            : 'to-be-deactivated'

  return {
    status,
    daysIdle,
    lastShipped: record.lastShipped,
    firstShipped: record.firstShipped,
    recentDays: record.recentDays ?? 0,
    /*
     * Active on the strength of a single delivery.
     *
     * One shipment after a long quiet spell reads as Active and is thin
     * evidence for it — a returned order or a one-off top-up looks exactly the
     * same. Not a different status, because the sheet does not have one; a flag
     * on the row instead, so that when the forecast starts trusting Active it
     * can decline to trust this one.
     */
    thinEvidence: status === 'active' && (record.recentDays ?? 0) <= 1,
  }
}

/**
 * Every article the warehouse has ever shipped, with its status.
 *
 * Returns a Map of article number to the shape `classifyOne` produces. Callers
 * that have articles of their own look them up; an article missing from the map
 * has never been shipped and takes the `never-shipped` status.
 */
export async function classifyArticles({ asAt = new Date() } = {}) {
  const at = typeof asAt === 'string' ? asAt.slice(0, 10) : iso(asAt)
  const recentFrom = iso(Date.parse(`${at}T00:00:00Z`) - RECENT_WINDOW_DAYS * DAY)

  const history = await cube.shipHistory({ asAt: at, recentFrom }).catch(() => new Map())
  const out = new Map()
  for (const [article, record] of history) {
    out.set(article, classifyOne(record, at))
  }
  return out
}

/**
 * How many articles sit in each status, in ladder order.
 *
 * Statuses with nothing in them are kept rather than dropped: a reader needs to
 * see that Super Slow-Moving is empty, not be left wondering whether it was
 * omitted or never computed.
 */
export function summarise(rows) {
  const counts = new Map(STATUSES.map((s) => [s.key, 0]))
  for (const r of rows) {
    const k = r?.status ?? r?.classification?.status
    if (counts.has(k)) counts.set(k, counts.get(k) + 1)
  }
  const total = [...counts.values()].reduce((s, v) => s + v, 0)
  return STATUSES.map((s) => ({
    ...s,
    count: counts.get(s.key) ?? 0,
    share: total ? (counts.get(s.key) ?? 0) / total : 0,
  }))
}
