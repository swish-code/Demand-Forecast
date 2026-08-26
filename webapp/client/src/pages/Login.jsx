import { useEffect, useState } from 'react'

/** A line break, named so the request body reads as a list. */
const NEWLINE = String.fromCharCode(10)
import { BRANDS } from '../brands.js'

/**
 * Sign-in — Microsoft work accounts only.
 *
 * Staff already have a work account, so this app issues no password of its
 * own: there is nothing here to forget or leak, and revoking someone in Entra
 * revokes them here.
 *
 * There is no password form, and no endpoint that would take one. If Microsoft
 * sign-in is not configured, nobody signs in — the way back from that is fixing
 * the app registration, not a second door left open in case.
 */

/** Microsoft's own mark, drawn inline so the page pulls in nothing external. */
function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="0" y="0" width="7.4" height="7.4" fill="#f25022" />
      <rect x="8.6" y="0" width="7.4" height="7.4" fill="#7fba00" />
      <rect x="0" y="8.6" width="7.4" height="7.4" fill="#00a4ef" />
      <rect x="8.6" y="8.6" width="7.4" height="7.4" fill="#ffb900" />
    </svg>
  )
}

function MailIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </svg>
  )
}

/** What the callback told us, read once and then cleared from the address bar. */
function readCallback() {
  const params = new URLSearchParams(window.location.search)
  const signin = params.get('signin')
  if (!signin) return null
  const detail = { signin, reason: params.get('reason'), email: params.get('email') }
  window.history.replaceState({}, '', window.location.pathname)
  return detail
}

/**
 * What the access request actually says.
 *
 * It used to be a blank form the applicant had to fill in and the administrator
 * had to act on from memory. It now names the account that is waiting and links
 * straight to the page where it is approved — the administrator opens the link,
 * signs in, and the account is sitting at the top of Admin with a Grant access
 * button beside it.
 *
 * A one-click approve straight from the mail would need a signed token in the
 * URL, which is a standing key to granting access sitting in somebody's inbox.
 * A link to the page costs one more click and no such key.
 */
function requestBody(pendingEmail) {
  const origin = window.location.origin
  return [
    pendingEmail
      ? `${pendingEmail} has signed in to Demand Forecast and is waiting for access.`
      : 'Please give me access to Demand Forecast.',
    '',
    `Approve here: ${origin}/?approve=1`,
    '(sign in, then press Grant access beside the name)',
    '',
    'Name:',
    'Brand(s):',
    'Branch(es):',
    '',
  ].join(NEWLINE)
}

export function Login({ onSignedIn }) {
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [pendingEmail, setPendingEmail] = useState(null)
  const [busy, setBusy] = useState(false)
  const [methods, setMethods] = useState({ microsoft: true, password: false, contact: null })

  useEffect(() => {
    fetch('/api/auth/methods')
      .then((r) => r.json())
      .then(setMethods)
      .catch(() => {
        // If the server cannot be asked, leave Microsoft on: it is the only
        // route in, so offering it and failing is better than offering nothing.
      })

    const back = readCallback()
    if (!back) return
    if (back.signin === 'ok') {
      // The session cookie is already set; ask the server who we are.
      fetch('/api/auth/me')
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => s && onSignedIn(s))
        .catch(() => setError('Signed in, but the session could not be read. Try again.'))
    } else if (back.signin === 'pending') {
      setPendingEmail(back.email ?? null)
      setNotice(
        `${back.email ?? 'Your account'} is signed in with Microsoft and is waiting for an administrator to grant access.`
      )
    } else if (back.signin === 'blocked') {
      setError('That account is not active. Contact an administrator.')
    } else {
      setError(back.reason || 'Microsoft sign-in did not complete.')
    }
  }, [onSignedIn])


  return (
    <div className="signin">
      <header className="signin__masthead">
        <img className="signin__logo" src="/swish-logo.png" alt="" aria-hidden="true" />
        <div>
          <h1 className="signin__wordmark">
            <span>Demand</span> Forecast
          </h1>
          <p className="signin__strap">Business Performance &amp; Analytics</p>
        </div>
      </header>

      <main className="signin__card">
        <div className="signin__intro">
          <h2 className="signin__title">Sign in</h2>
          <p className="signin__sub">Use your company Microsoft account.</p>
        </div>

        {error && (
          <div className="signin__error" role="alert">
            {error}
          </div>
        )}
        {notice && <div className="signin__notice">{notice}</div>}

        {methods.microsoft && (
          <a className="signin__ms" href="/api/auth/microsoft/start">
            <MicrosoftMark />
            Sign in with Microsoft
          </a>
        )}

        {!methods.microsoft && (
          <p className="signin__down">
            Microsoft sign-in is not configured on this server, and it is the only way in. An
            administrator needs to set the app registration before anybody can sign in.
          </p>
        )}

        <p className="signin__assure">Secure session · your access is scoped to your role.</p>

        <hr className="signin__rule" />

        {/*
          A request that reaches a person.
          
          This used to send you back through Microsoft sign-in, which creates a
          pending account and tells you to wait — the same dead end you were
          already looking at. It now writes to whoever administers the
          deployment, with the address filled in.
        */}
        <div className="signin__request">
          <p>Don&apos;t have access yet?</p>
          <a
            className="signin__requestBtn"
            href={
              methods.contact
                ? `mailto:${methods.contact}?subject=${encodeURIComponent(
                    pendingEmail
                      ? `Demand Forecast — access request from ${pendingEmail}`
                      : 'Demand Forecast — access request'
                  )}&body=${encodeURIComponent(requestBody(pendingEmail))}`
                : '/api/auth/microsoft/start'
            }
          >
            <MailIcon />
            Request access
          </a>
          {methods.contact && <p className="signin__requestWho">Goes to {methods.contact}</p>}
        </div>
      </main>

      <footer className="signin__brands">
        <p className="signin__brandsLabel">Our brands</p>
        <ul>
          {BRANDS.map((b) => (
            <li key={b.code}>
              {/* The name on hover, because nine marks in a row is a quiz
                  otherwise — several are wordless or set in Arabic. */}
              <span className="signin__brandChip">
                <img
                  src={b.logo}
                  alt={b.label}
                  style={{ transform: `scale(${b.zoom})`, objectFit: b.fit ?? 'contain' }}
                />
              </span>
              <span className="signin__brandName" role="tooltip">
                {b.label}
              </span>
            </li>
          ))}
        </ul>
      </footer>
    </div>
  )
}
