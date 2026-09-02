import 'dotenv/config'

const bool = (v) => v === '1' || String(v).toLowerCase() === 'true'

export const config = {
  port: Number(process.env.PORT) || 7005,
  demoMode: bool(process.env.DEMO_MODE),
  cacheTtl: process.env.CACHE_TTL === undefined ? 120 : Number(process.env.CACHE_TTL),

  /** Entra ID app registration. Same app serves the service principal today
   *  and the interactive Microsoft sign-in flow later (redirectUri). */
  ms: {
    tenantId: process.env.MS_TENANT_ID,
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    redirectUri: process.env.MS_REDIRECT_URI,
  },

  /**
   * Where the browser is sent back to after a Microsoft sign-in.
   *
   * In development the app is served by Vite on 7006 while the API answers the
   * callback on 7005, so the two differ and this cannot be inferred.
   */
  appOrigin: process.env.APP_ORIGIN || 'http://localhost:7006',

  /**
   * Outgoing mail. Sent as `from` through Microsoft Graph using the same app
   * registration above, which needs the Mail.Send application permission.
   *
   * `testTo` overrides every recipient when set — the safety catch that stops a
   * test run reaching sixty branches.
   */
  mail: {
    from: process.env.OUTLOOK_EMAIL,
    testTo: process.env.MAIL_TEST_TO || null,
    hour: process.env.MAIL_HOUR === undefined ? 7 : Number(process.env.MAIL_HOUR),
    enabled: bool(process.env.MAIL_ENABLED),
  },

  pbi: {
    workspaceId: process.env.PBI_WORKSPACE_ID,
    datasetId: process.env.PBI_DATASET_ID,
  },

  /*
   * Warehouse Analytics: one model for the whole company, in its own workspace.
   *
   * Everything else here is per-brand — a brand is chosen before a query runs.
   * This one is not: it holds every brand's stock movements in a single
   * semantic model, and the brand is a column on the fact rather than a choice
   * of dataset. So it gets its own two ids rather than joining PBI_DATASETS.
   *
   * Absent means the Ingredients page shows what the recipes imply and nothing
   * about what actually moved, which is what it did before this existed.
   */
  warehouse: {
    workspaceId: process.env.WH_WORKSPACE_ID || null,
    datasetId: process.env.WH_DATASET_ID || null,
    /*
     * What counts as having left the building.
     *
     * These are the model's own Outbound Fulfilled Qty, exactly:
     *
     *   CALCULATE(SUM(fact_outbound_line[Action Base Qty]),
     *             [Status Group] IN {"BOOKED", "DELIVERED", "DECLINED"})
     *
     * DECLINED was left out here at first — the word suggests nothing moved —
     * but the warehouse's own definition counts it, and the warehouse is the
     * authority on what its statuses mean. Two definitions of the same figure
     * is how a dashboard comes to disagree with the report it is copying.
     *
     * It is 0.81% of all quantity and very unevenly spread: 91% of it is one
     * brand, SS, where it adds about 4.9%. Everywhere else it is under 1%.
     *
     * Still overridable, because it is a business definition rather than a
     * technical one. Note what stays out: REQUESTED is 21.6% of all quantity
     * and is not fulfilment — it is what was asked for, not what moved.
     */
    statuses: (process.env.WH_STATUSES || 'BOOKED,DELIVERED,DECLINED')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  /**
   * Each brand is its OWN semantic model, so a brand is chosen before a query
   * runs rather than filtered inside one. PBI_DATASETS is a comma-separated
   * list of `code|Label|datasetId[|chain]`.
   *
   * Two models hold more than one chain (SLC-BUR has SLC + BUR, ERMG has
   * MM + TBL). Those get one entry per brand pointing at the same dataset with
   * `chain` set, so the picker still reads as one brand per row and the chain
   * is applied as a filter automatically.
   */
  brands: parseBrands(process.env.PBI_DATASETS, process.env.PBI_DATASET_ID),
}

function parseBrands(raw, fallbackId) {
  const list = String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, label, datasetId, chain] = entry.split('|').map((p) => (p || '').trim())
      return code && datasetId ? { code, label: label || code, datasetId, chain: chain || null } : null
    })
    .filter(Boolean)

  if (list.length) return list
  return fallbackId ? [{ code: 'BBT', label: 'BBT', datasetId: fallbackId }] : []
}

/** Resolve a brand code to its dataset; unknown or missing falls back to the first. */
export function resolveBrand(code) {
  const list = config.brands
  if (!list.length) return null
  return list.find((b) => b.code.toLowerCase() === String(code || '').toLowerCase()) || list[0]
}

const REQUIRED = {
  MS_TENANT_ID: () => config.ms.tenantId,
  MS_CLIENT_ID: () => config.ms.clientId,
  MS_CLIENT_SECRET: () => config.ms.clientSecret,
  PBI_WORKSPACE_ID: () => config.pbi.workspaceId,
  PBI_DATASETS: () => config.brands.length,
  /*
   * Without this, a deployment is a locked room.
   *
   * Sign-in is Microsoft only. The first person to arrive is created pending,
   * waiting for an administrator to approve them, and there is no administrator
   * and no password form to make one with. Somebody has to be let in by
   * configuration, and this names them.
   *
   * Reported by /api/health alongside the Power BI settings, so a deployment
   * missing it says so before anybody discovers it by being shut out.
   */
  ADMIN_EMAILS: () => process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL,
}

/** Env var names still missing for a live Power BI connection. */
export function missingSettings() {
  return Object.entries(REQUIRED)
    .filter(([, get]) => !get())
    .map(([name]) => name)
}
