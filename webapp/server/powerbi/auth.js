import { config, missingSettings } from '../config.js'
import { HttpError } from './errors.js'

const SCOPE = 'https://analysis.windows.net/powerbi/api/.default'

let token = null // { value, expiresAt }
let inFlight = null

/** The token endpoint answers in well under a second when it is healthy. */
const TOKEN_TIMEOUT_MS = Number(process.env.PBI_TOKEN_TIMEOUT_MS) || 8_000
const TOKEN_RETRIES = [400, 1200]

/**
 * Client-credentials token for the Power BI REST API, cached until 60s before
 * expiry. Concurrent callers share a single token request.
 */
export async function getAccessToken() {
  const missing = missingSettings()
  if (missing.length) {
    throw new HttpError(
      500,
      `Power BI is not configured. Missing in .env: ${missing.join(', ')}. ` +
        'Set DEMO_MODE=1 to run against sample data instead.'
    )
  }

  if (token && token.expiresAt > Date.now() + 60_000) return token.value
  if (inFlight) return inFlight

  const { tenantId, clientId, clientSecret } = config.ms
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: SCOPE,
  })

  inFlight = (async () => {
    let last
    for (let attempt = 0; attempt <= TOKEN_RETRIES.length; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          // Without this the request can hang indefinitely, and because every
          // caller awaits the same promise a single stalled token request
          // freezes the whole page — not one query, all of them.
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          // Bad credentials will never succeed, so those fail immediately.
          throw new HttpError(
            res.status,
            `Entra ID token request failed: ${json.error_description || json.error || res.statusText}`
          )
        }
        token = {
          value: json.access_token,
          expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
        }
        return token.value
      } catch (err) {
        last = err
        const worthRetrying = !err.status && attempt < TOKEN_RETRIES.length
        if (!worthRetrying) break
        await new Promise((r) => setTimeout(r, TOKEN_RETRIES[attempt]))
      }
    }
    throw last.status
      ? last
      : new HttpError(503, `Could not reach Entra ID to sign in to Power BI: ${last.message}`)
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}
