import { config } from '../config.js'

/**
 * Handing the message to a Power Automate flow, which sends it.
 *
 * The simplest route in an organisation that already runs Microsoft 365, and
 * the only one that needs nothing from a tenant administrator and no password
 * stored anywhere. The flow is created by a person, runs as that person's
 * Office 365 Outlook connection, and the app never sees a credential — it just
 * posts JSON to the flow's URL.
 *
 * The URL is the credential. It carries its own signature, so anyone holding it
 * can make the flow send mail; it belongs in .env beside the client secret, not
 * in a repository or a chat message. Regenerating it in Power Automate revokes
 * the old one.
 *
 * What the flow needs to be, once:
 *
 *   Trigger  "When an HTTP request is received", with the schema below.
 *   Action   "Send an email (V2)" — To: to, Subject: subject, Body: html,
 *            tick "Is HTML", and set Attachments to the attachments array
 *            (Name: name, Content: contentBytes).
 *
 * The trigger is a premium connector, which is the one catch worth knowing
 * before starting.
 */

const URL_SETTING = 'POWER_AUTOMATE_URL'

/** Paste into the trigger's "Request Body JSON Schema" box. */
export const REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    to: { type: 'string' },
    subject: { type: 'string' },
    html: { type: 'string' },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          contentBytes: { type: 'string' },
        },
        required: ['name', 'contentBytes'],
      },
    },
  },
  required: ['to', 'subject', 'html'],
}

export const flowUrl = () => process.env[URL_SETTING] || ''

export function readiness() {
  const url = flowUrl()
  return {
    transport: 'flow',
    ready: Boolean(url),
    missing: url ? [] : [URL_SETTING],
    note: url
      ? 'Posting each message to a Power Automate flow, which sends it as whoever built the flow. No tenant permission and no password here.'
      : `Create the flow, then put its POST URL in ${URL_SETTING}.`,
  }
}

const TIMEOUT_MS = Number(process.env.POWER_AUTOMATE_TIMEOUT_MS) || 30_000

/**
 * An attachment's bytes, whether it arrived as text or as a Buffer.
 *
 * A CSV is a string; an .xlsx is binary and must not be run through a UTF-8
 * decode on the way to base64 — that silently corrupts the zip and Excel then
 * reports the file as unreadable.
 */
const bytesOf = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'))

export async function sendMail({ to, subject, html, attachments = [] }) {
  const url = flowUrl()
  if (!url) throw new Error(`${URL_SETTING} is not set, so there is no flow to post to.`)

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean)
  if (!recipients.length) throw new Error('No recipients')

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      // Comma-separated, which is what "Send an email (V2)" expects in To.
      to: recipients.join(';'),
      subject,
      html,
      attachments: attachments.map((a) => ({
        name: a.filename,
        contentBytes: bytesOf(a.content).toString('base64'),
      })),
    }),
  })

  // A flow with no explicit response returns 202 the moment it is queued.
  if (res.ok || res.status === 202) return { ok: true, status: res.status }

  const detail = await res.text().catch(() => '')
  throw Object.assign(
    new Error(
      res.status === 401 || res.status === 403
        ? `The flow rejected the request (${res.status}). Its URL has most likely been regenerated — copy the current one into ${URL_SETTING}.`
        : `The flow answered ${res.status}. ${String(detail).slice(0, 200)}`
    ),
    { status: res.status }
  )
}

/** Named so the admin page can show where mail is going without sending any. */
export const describe = () => {
  const url = flowUrl()
  if (!url) return null
  try {
    const u = new URL(url)
    // Never the whole thing: the query string is the credential.
    return `${u.host}${u.pathname.slice(0, 48)}…`
  } catch {
    return 'a Power Automate flow'
  }
}
