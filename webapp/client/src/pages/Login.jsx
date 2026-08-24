import { useEffect, useState } from 'react'
import { IconLock, IconUser, IconEye, IconEyeOff } from '../components/Icons.jsx'
import { BRANDS } from '../brands.js'

/**
 * Sign-in — Microsoft work accounts only.
 *
 * Staff already have a work account, so there is no second password to issue,
 * forget or leak, and revoking someone in Entra revokes them here.
 *
 * The password form is behind "Administrator sign-in" rather than removed. It
 * is not a second way in for staff — it is the way back in if the Entra app
 * registration or its redirect URI is ever broken, which would otherwise lock
 * every administrator out of their own tool.
 *
 * The server returns the same message for every credential failure, so this
 * screen never reveals whether an email exists.
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

export function Login({ onSignedIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [methods, setMethods] = useState({ microsoft: true, password: true })

  useEffect(() => {
    fetch('/api/auth/methods')
      .then((r) => r.json())
      .then(setMethods)
      .catch(() => {
        // If the server cannot be asked, leave Microsoft on: it is the only
        // route staff have, and showing a password box they cannot use would be
        // worse than showing nothing.
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
      setNotice(
        `${back.email ?? 'Your account'} is signed in with Microsoft and is waiting for an administrator to grant access.`
      )
    } else if (back.signin === 'blocked') {
      setError('That account is not active. Contact an administrator.')
    } else {
      setError(back.reason || 'Microsoft sign-in did not complete.')
    }
  }, [onSignedIn])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `Sign-in failed (${res.status})`)
      onSignedIn(json)
    } catch (err) {
      setError(err.message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

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

        {/* No password option is offered while Microsoft sign-in is working.
            The form below still exists, but only appears when the server says
            Microsoft is unavailable — it is the way back in if the Entra app
            registration or its redirect URI breaks, not a second door. */}
        {!methods.microsoft && (
          <form onSubmit={submit} className="signin__form">
            <label className="signin__field">
              <span className="signin__label">Email</span>
              <span className="signin__input">
                <IconUser size={16} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  placeholder="name@swishhh.net"
                  required
                />
              </span>
            </label>

            <label className="signin__field">
              <span className="signin__label">Password</span>
              <span className="signin__input">
                <IconLock size={16} />
                <input
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="signin__reveal"
                  onClick={() => setReveal((r) => !r)}
                  aria-label={reveal ? 'Hide password' : 'Show password'}
                >
                  {reveal ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              </span>
            </label>

            <button type="submit" className="signin__submit" disabled={busy || !email || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        <p className="signin__assure">Secure session · your access is scoped to your role.</p>

        <hr className="signin__rule" />

        <div className="signin__request">
          <p>Don&apos;t have access yet?</p>
          <a className="signin__requestBtn" href="/api/auth/microsoft/start">
            <MailIcon />
            Request access
          </a>
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
