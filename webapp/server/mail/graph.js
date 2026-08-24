import { config } from '../config.js'

/**
 * Sending mail through Microsoft Graph, with the same service principal that
 * reads Power BI.
 *
 * Graph needs its own token: the Power BI token is issued for a different
 * audience and will be rejected here. Both come from the same app registration,
 * so the only extra requirement is the Mail.Send application permission, granted
 * with admin consent on the tenant.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0'
const SCOPE = 'https://graph.microsoft.com/.default'

let cached = null

/**
 * Throw away the cached token.
 *
 * Granting a permission in Entra does not change any token already issued, and
 * these last about an hour. Without this, an admin who grants Mail.Send and
 * immediately presses Send would keep hitting the same 403 with no clue why —
 * so a permission failure discards the token and the next attempt asks for a
 * fresh one carrying the new role.
 */
function forgetToken() {
  cached = null
}

async function token() {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value

  const { tenantId, clientId, clientSecret } = config.ms
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET must be set to send mail')
  }

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPE,
      grant_type: 'client_credentials',
    }),
  })

  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(json.error_description || `Graph token request failed (${res.status})`)
  }

  cached = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 }
  return cached.value
}

/**
 * Sends one message as the configured mailbox.
 *
 * `saveToSentItems` is on so there is a record in the mailbox itself — when a
 * branch says they never got the plan, someone needs to be able to check
 * without taking this application's word for it.
 */
/**
 * An attachment's bytes, whether it arrived as text or as a Buffer.
 *
 * A CSV is a string; an .xlsx is binary and must not be run through a UTF-8
 * decode on the way to base64 — that silently corrupts the zip and Excel then
 * reports the file as unreadable.
 */
const bytesOf = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'))

export async function sendMail({ to, subject, html, replyTo, attachments = [] }) {
  const from = config.mail.from
  if (!from) throw new Error('OUTLOOK_EMAIL is not set')

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean)
  if (!recipients.length) throw new Error('No recipients')

  const body = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
      ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
      ...(attachments.length
        ? {
            attachments: attachments.map((a) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: a.filename,
              contentType: a.contentType ?? 'text/csv',
              contentBytes: bytesOf(a.content).toString('base64'),
            })),
          }
        : {}),
    },
    saveToSentItems: true,
  }

  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (res.status === 202) return { ok: true }

  const json = await res.json().catch(() => ({}))
  const message = json?.error?.message || `Graph sendMail failed (${res.status})`
  if (res.status === 401 || res.status === 403) forgetToken()

  // Deliberately no alert raised here. One failed send and "the daily run
  // failed" are the same event seen from two heights, and raising at both
  // produced two alerts on the admin page saying the same thing. The caller
  // owns the alert; this only makes sure the reason travels with the error.
  const err = new Error(
    res.status === 403 || /denied|privileges/i.test(message)
      ? `${message} The app registration most likely lacks the Mail.Send application permission with admin consent on the tenant.`
      : message
  )
  err.status = res.status
  throw err
}

/**
 * Reads the application roles the token was actually issued with.
 *
 * The access token itself lists every app permission the tenant has consented
 * to, in its `roles` claim. Reading it costs nothing and needs no permission of
 * its own — which matters, because the obvious check (asking Graph about the
 * mailbox) needs User.Read.All, and failing that check made it look as though
 * sending was misconfigured when only the check was.
 *
 * Not verifying the signature is deliberate and safe: this token came straight
 * from the login endpoint over TLS moments ago and is only being read to tell
 * an admin what is missing. Nothing is authorised on the strength of it.
 */
function grantedRoles(jwt) {
  try {
    const payload = jwt.split('.')[1]
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return JSON.parse(json).roles ?? []
  } catch {
    return []
  }
}

/**
 * Whether mail can actually be sent, without sending anything.
 *
 * Checks the two things that are genuinely required — a mailbox to send as, and
 * the Mail.Send application permission — and says plainly which is missing.
 */
export async function verifyMailbox() {
  const from = config.mail.from
  if (!from) {
    return { ok: false, error: 'OUTLOOK_EMAIL is not set, so there is no mailbox to send as.' }
  }

  // Always ask for a fresh token here. This check exists to answer "have the
  // permissions landed yet?", and a cached token cannot answer that.
  forgetToken()

  let roles
  try {
    roles = grantedRoles(await token())
  } catch (err) {
    return { ok: false, error: err.message }
  }

  if (!roles.length) {
    return {
      ok: false,
      mailbox: from,
      roles,
      error:
        'The app registration has no application permissions consented on this tenant. It needs Mail.Send (Application), with admin consent granted.',
    }
  }

  if (!roles.includes('Mail.Send')) {
    return {
      ok: false,
      mailbox: from,
      roles,
      error: `Mail.Send is not among the granted application permissions (${roles.join(', ')}). Add Mail.Send (Application) to the app registration and grant admin consent.`,
    }
  }

  return { ok: true, mailbox: from, roles }
}
