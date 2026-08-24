import { config } from '../config.js'
import { sendMail as sendViaGraph, verifyMailbox as verifyGraph } from './graph.js'
import { sendViaSubmission, sendDirect } from './smtp.js'
import { sendMail as sendDelegated, connectedMailbox } from './delegated.js'
import { sendMail as sendViaFlow, readiness as flowReadiness, describe as describeFlow } from './flow.js'

/**
 * How a message actually leaves the building.
 *
 * Three ways, because the obvious one needs something only a tenant
 * administrator can grant, and that grant has not happened. Each was tested
 * from this network rather than assumed:
 *
 *   graph   Microsoft Graph with an application permission. The tidiest, and
 *           what the app was built for. Blocked: the token comes back with no
 *           roles at all, so sendMail answers 403. One admin consent fixes it.
 *
 *   smtp    Authenticated submission to smtp.office365.com:587. The server
 *           advertises AUTH LOGIN after STARTTLS, so this is available now —
 *           it needs SMTP AUTH left enabled on the sending mailbox and a
 *           password for it, which on an MFA tenant means an app password.
 *           No administrator involved.
 *
 *   flow    A Power Automate flow sends it. Nothing to grant and no password
 *           to store: the flow runs as whoever built it. Its trigger is a
 *           premium connector, which is the one thing to check first.
 *
 *   direct  Straight to the recipient domain's mail exchanger on port 25, with
 *           no credentials. Reaches recipients inside that domain only. It got
 *           as far as "Sender OK" from here and was then refused at RCPT —
 *           this machine's address is on Spamhaus, as any home connection is.
 *           From a server with its own reputation and an SPF record naming it,
 *           this works; from a laptop it never will.
 *
 * MAIL_TRANSPORT picks. The default stays graph so that granting the permission
 * needs no other change.
 */

const TRANSPORT = (process.env.MAIL_TRANSPORT || 'graph').toLowerCase()

/**
 * The one address these reports may leave from.
 *
 * OUTLOOK_EMAIL is the account the reports come from, and it is deliberately
 * not whoever pressed the button: an administrator signs in to send, but the
 * message has to arrive from the automation mailbox, so a branch can filter on
 * it and nobody's personal address ends up on sixty morning emails.
 *
 * The delegated route sends as whichever mailbox granted consent, which is the
 * one place this could quietly drift — an administrator who consents with their
 * own account would turn every report into mail from them. So the connected
 * mailbox is checked against this before anything is sent.
 */
const sender = () => config.mail?.from || process.env.OUTLOOK_EMAIL || null

const sameAddress = (a, b) =>
  Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

/** Null when the mailbox that would send is the right one; a sentence when not. */
function senderMismatch() {
  if (TRANSPORT !== 'delegated') return null
  const from = sender()
  const mailbox = connectedMailbox()
  if (!from || !mailbox) return null
  if (sameAddress(mailbox.email, from)) return null
  return (
    `The connected mailbox is ${mailbox.email}, but reports must be sent from ${from}. ` +
    `Disconnect it and connect ${from} instead.`
  )
}

export const transportName = () => TRANSPORT

/** The address every report leaves from, whoever pressed the button. */
export const sendingAddress = () => sender()

/** What each one needs before it can be used at all. */
export function transportReadiness() {
  const from = sender()
  switch (TRANSPORT) {
    case 'smtp':
      return {
        transport: 'smtp',
        ready: Boolean(from && process.env.SMTP_PASS),
        missing: [!from && 'OUTLOOK_EMAIL', !process.env.SMTP_PASS && 'SMTP_PASS'].filter(Boolean),
        note: 'Authenticated submission through Office 365. SMTP AUTH must be enabled on the sending mailbox.',
      }
    case 'flow':
      return { ...flowReadiness(), endpoint: describeFlow() }
    case 'delegated': {
      const mailbox = connectedMailbox()
      const wrong = senderMismatch()
      return {
        transport: 'delegated',
        ready: Boolean(mailbox) && !wrong,
        missing: mailbox ? (wrong ? [`the ${from} mailbox`] : []) : ['a connected mailbox'],
        mailbox: mailbox?.email ?? null,
        from,
        note: wrong
          ? wrong
          : mailbox
            ? `Sending as ${mailbox.email}, with that mailbox's own consent. No administrator needed.`
            : `Nobody has connected a mailbox yet. Open the consent link on the admin page and sign in as ${from ?? 'the sending account'}.`,
      }
    }
    case 'direct':
      return {
        transport: 'direct',
        ready: Boolean(from),
        missing: [!from && 'OUTLOOK_EMAIL'].filter(Boolean),
        note: 'Straight to each recipient domain. Internal addresses only, and the sending host must not be blocklisted.',
      }
    default:
      return {
        transport: 'graph',
        ready: Boolean(config.ms?.clientId && config.ms?.clientSecret),
        missing: [!config.ms?.clientId && 'MS_CLIENT_ID', !config.ms?.clientSecret && 'MS_CLIENT_SECRET'].filter(Boolean),
        note: 'Microsoft Graph. Needs the Mail.Send application permission with admin consent.',
      }
  }
}

export async function sendMail({ to, subject, html, replyTo, attachments = [] }) {
  const from = sender()
  const fromName = process.env.MAIL_FROM_NAME || 'Demand Forecast'

  if (TRANSPORT === 'smtp') {
    return sendViaSubmission({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || undefined,
      from,
      fromName,
      to,
      subject,
      html,
      user: process.env.SMTP_USER || from,
      pass: process.env.SMTP_PASS,
      attachments,
    })
  }

  if (TRANSPORT === 'flow') {
    return sendViaFlow({ to, subject, html, attachments })
  }

  if (TRANSPORT === 'delegated') {
    // Checked here rather than only on the admin page: the schedule sends
    // without anybody looking at a page first.
    const wrong = senderMismatch()
    if (wrong) throw new Error(wrong)
    return sendDelegated({ to, subject, html, replyTo, attachments })
  }

  if (TRANSPORT === 'direct') {
    return sendDirect({ from, fromName, to, subject, html, attachments })
  }

  return sendViaGraph({ to, subject, html, replyTo, attachments })
}

/** A pre-flight the admin page can call before anyone waits on a schedule. */
export async function verifyTransport() {
  const readiness = transportReadiness()
  if (!readiness.ready) {
    return { ...readiness, ok: false, detail: `Not configured: ${readiness.missing.join(', ')}` }
  }
  if (TRANSPORT === 'graph') {
    const r = await verifyGraph()
    return { ...readiness, ...r }
  }
  // Nothing to verify short of sending; the admin page's test message does that.
  return {
    ...readiness,
    ok: true,
    detail: `Configured. Every report leaves as ${sender() ?? 'the configured mailbox'}.`,
  }
}
