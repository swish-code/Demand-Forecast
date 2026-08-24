import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns/promises'
import { randomBytes } from 'node:crypto'

/**
 * A small SMTP client, written here rather than pulled in.
 *
 * The app has two dependencies. Adding a mail library for what amounts to a
 * dozen line-oriented commands would be a poor trade, and the protocol is small
 * enough to read in one sitting.
 *
 * It covers two ways of getting a message out, both verified reachable from
 * this network:
 *
 *   submission  smtp.office365.com:587, STARTTLS, then AUTH as a real mailbox.
 *               Sends to anyone. Needs SMTP AUTH enabled on that mailbox and a
 *               password — which for a tenant with MFA means an app password.
 *
 *   direct      straight to the recipient domain's own mail exchanger on port
 *               25. No credentials at all, because the receiving server accepts
 *               mail for its own users from anywhere. That is the catch: it
 *               only works for recipients inside that domain, and it is subject
 *               to SPF, so mail claiming to be from a domain this machine is
 *               not authorised to send for may be junked or refused outright.
 */

const CRLF = '\r\n'

class SmtpError extends Error {
  constructor(message, { code, command } = {}) {
    super(message)
    this.name = 'SmtpError'
    this.code = code
    this.command = command
  }
}

/** One connection, spoken line by line. */
class Session {
  constructor(socket, { timeout = 20_000, log } = {}) {
    this.socket = socket
    this.timeout = timeout
    this.log = log
    this.buffer = ''
    this.pending = null
    socket.setEncoding('utf8')
    socket.setTimeout(timeout)
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('error', (err) => this.#fail(err))
    socket.on('timeout', () => this.#fail(new SmtpError('the server stopped responding')))
    socket.on('close', () => this.#fail(new SmtpError('the connection closed unexpectedly')))
  }

  #fail(err) {
    const p = this.pending
    this.pending = null
    if (p) p.reject(err instanceof Error ? err : new SmtpError(String(err)))
  }

  #onData(chunk) {
    this.buffer += chunk
    // A reply ends with "NNN <space>" on its own final line; "NNN-" continues.
    const match = this.buffer.match(/^\d{3} [^\n]*\r?\n$|(?:^|\n)(\d{3}) [^\n]*\r?\n$/)
    if (!match) return
    const text = this.buffer
    this.buffer = ''
    const code = Number(text.match(/(\d{3})[ -][^\n]*\r?\n$/)?.[1] ?? text.slice(0, 3))
    const p = this.pending
    this.pending = null
    if (p) p.resolve({ code, text: text.trim() })
  }

  read() {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  async send(command, { expect = [250], secret = false } = {}) {
    if (command !== null) {
      this.log?.(`> ${secret ? '<hidden>' : command}`)
      this.socket.write(command + CRLF)
    }
    const reply = await this.read()
    this.log?.(`< ${reply.text.split(CRLF)[0]}`)
    if (expect.length && !expect.includes(reply.code)) {
      throw new SmtpError(reply.text.split(CRLF)[0], { code: reply.code, command: secret ? '<hidden>' : command })
    }
    return reply
  }

  /** Upgrade the plain socket in place. */
  upgrade(servername) {
    return new Promise((resolve, reject) => {
      this.socket.removeAllListeners('data')
      this.socket.removeAllListeners('error')
      this.socket.removeAllListeners('timeout')
      this.socket.removeAllListeners('close')
      const secure = tls.connect({ socket: this.socket, servername }, () => {
        resolve(new Session(secure, { timeout: this.timeout, log: this.log }))
      })
      secure.once('error', reject)
    })
  }

  end() {
    try {
      this.socket.write('QUIT' + CRLF)
      this.socket.end()
    } catch {
      /* the message is already delivered; a rude goodbye costs nothing */
    }
  }
}

function connect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    socket.setTimeout(timeout)
    socket.once('connect', () => resolve(socket))
    socket.once('timeout', () => {
      socket.destroy()
      reject(new SmtpError(`${host}:${port} did not answer within ${Math.round(timeout / 1000)}s`))
    })
    socket.once('error', (err) => reject(new SmtpError(`${host}:${port} — ${err.code || err.message}`)))
  })
}

/** Dot-stuffing: a line that is just "." would otherwise end the message. */
const stuff = (text) =>
  text.split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join(CRLF)

/** Base64 in 76-character lines, as the encoding requires. */
/**
 * Base64, wrapped at 76 characters as the MIME rules require.
 *
 * Takes bytes as readily as text: an .xlsx is a zip, and decoding it as UTF-8
 * on the way in would corrupt every byte above 0x7f.
 */
const base64Lines = (content) =>
  (Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'))
    .toString('base64')
    .replace(/(.{76})/g, `$1${CRLF}`)

/**
 * Headers and body.
 *
 * With no attachment this is a plain HTML message. With one it becomes
 * multipart/mixed: the HTML the reader sees first, then each file. The boundary
 * is random so it cannot turn up inside the content by accident.
 */
function buildMessage({ from, fromName, to, subject, html, attachments = [] }) {
  const id = `<${randomBytes(12).toString('hex')}@${from.split('@')[1]}>`
  const headers = [
    `From: ${fromName ? `"${fromName.replace(/"/g, '')}" <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
  ]

  if (!attachments.length) {
    headers.push('Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit')
    return headers.join(CRLF) + CRLF + CRLF + stuff(html)
  }

  const boundary = `--=_${randomBytes(16).toString('hex')}`
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)

  const parts = [
    ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', stuff(html)].join(CRLF),
    ...attachments.map((a) =>
      [
        Buffer.isBuffer(a.content)
          ? `Content-Type: ${a.contentType ?? 'application/octet-stream'}; name="${a.filename}"`
          : `Content-Type: ${a.contentType ?? 'text/csv'}; charset=utf-8; name="${a.filename}"`,
        `Content-Disposition: attachment; filename="${a.filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(a.content),
      ].join(CRLF)
    ),
  ]

  return (
    headers.join(CRLF) +
    CRLF +
    CRLF +
    parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF) +
    CRLF +
    `--${boundary}--`
  )
}

/** RFC 2047 for anything outside ASCII, so "£" in a subject survives. */
function encodeHeader(value) {
  const s = String(value ?? '')
  if (/^[\x20-\x7E]*$/.test(s)) return s
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

async function handshake(session, helo, host) {
  await session.send(null, { expect: [220] })
  let reply = await session.send(`EHLO ${helo}`)

  if (/STARTTLS/i.test(reply.text)) {
    await session.send('STARTTLS', { expect: [220] })
    const secure = await session.upgrade(host)
    reply = await secure.send(`EHLO ${helo}`)
    return { session: secure, capabilities: reply.text }
  }
  return { session, capabilities: reply.text }
}

async function authenticate(session, capabilities, user, pass) {
  if (/AUTH[ =-][^\r\n]*LOGIN/i.test(capabilities)) {
    await session.send('AUTH LOGIN', { expect: [334] })
    await session.send(Buffer.from(user).toString('base64'), { expect: [334], secret: true })
    await session.send(Buffer.from(pass).toString('base64'), { expect: [235], secret: true })
    return
  }
  if (/AUTH[ =-][^\r\n]*PLAIN/i.test(capabilities)) {
    const token = Buffer.from(`\0${user}\0${pass}`).toString('base64')
    await session.send(`AUTH PLAIN ${token}`, { expect: [235], secret: true })
    return
  }
  throw new SmtpError('the server offers no authentication method this client understands')
}

/**
 * Deliver one message down one connection.
 *
 * `auth` omitted means an unauthenticated hand-off, which only a recipient's
 * own mail exchanger will accept.
 */
async function deliver({ host, port, helo, from, fromName, to, subject, html, attachments = [], auth, log, timeout = 20_000 }) {
  const socket = await connect(host, port, timeout)
  let session = new Session(socket, { timeout, log })
  try {
    const shook = await handshake(session, helo, host)
    session = shook.session
    if (auth) await authenticate(session, shook.capabilities, auth.user, auth.pass)

    await session.send(`MAIL FROM:<${from}>`)
    await session.send(`RCPT TO:<${to}>`, { expect: [250, 251] })
    await session.send('DATA', { expect: [354] })
    session.socket.write(buildMessage({ from, fromName, to, subject, html, attachments }) + CRLF + '.' + CRLF)
    const done = await session.send(null, { expect: [250] })
    session.end()
    return { ok: true, response: done.text.split(CRLF)[0] }
  } catch (err) {
    session.end()
    throw err
  }
}

/** Authenticated submission — reaches any recipient. */
export function sendViaSubmission({ host, port, from, fromName, to, subject, html, attachments, user, pass, log }) {
  return deliver({
    host: host || 'smtp.office365.com',
    port: port || 587,
    helo: from.split('@')[1],
    from,
    fromName,
    to,
    subject,
    html,
    attachments,
    auth: { user: user || from, pass },
    log,
  })
}

/**
 * Straight to the recipient's mail exchanger, with no credentials.
 *
 * Only for recipients inside a domain whose server will accept mail for its own
 * users — which is every recipient here, since the reports go to @swishhh.net.
 */
export async function sendDirect({ from, fromName, to, subject, html, attachments, log }) {
  const domain = String(to).split('@')[1]
  if (!domain) throw new SmtpError(`"${to}" is not an address this can route`)

  const mx = await dns.resolveMx(domain).catch(() => [])
  if (!mx.length) throw new SmtpError(`${domain} publishes no mail exchanger`)
  mx.sort((a, b) => a.priority - b.priority)

  let last
  for (const { exchange } of mx.slice(0, 2)) {
    try {
      return await deliver({
        host: exchange,
        port: 25,
        helo: from.split('@')[1],
        from,
        fromName,
        to,
        subject,
        html,
        attachments,
        log,
      })
    } catch (err) {
      last = err
    }
  }
  throw last
}

export { SmtpError }
