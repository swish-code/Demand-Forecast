import { Component, useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import App from './App.jsx'
import { Login } from './pages/Login.jsx'

/**
 * Anything that throws while rendering says so, instead of leaving a blank page.
 *
 * React unmounts the whole tree when a render throws, and with nothing to catch
 * it the result is a white screen: no message, no stack, nothing on the page to
 * act on. The console has the detail, but "it is not loading" is what gets
 * reported, and a blank page gives no reason to go and look.
 *
 * Class component because this is the one thing hooks cannot do — there is no
 * useErrorBoundary.
 */
class Boundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[app] render failed', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    const { error } = this.state
    return (
      <div className="signin">
        <div className="signin__card">
          <h2 style={{ margin: '0 0 8px' }}>Something in this page failed to render</h2>
          <p style={{ margin: '0 0 12px', color: 'var(--text-muted)' }}>
            The rest of the application is fine. Reloading usually clears it; if it does not, the
            message below is what to report.
          </p>
          <pre
            style={{
              margin: '0 0 12px',
              padding: 12,
              maxHeight: 220,
              overflow: 'auto',
              background: 'var(--sunken)',
              borderRadius: 8,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            {String(error?.message || error)}
            {error?.stack ? `\n\n${error.stack}` : ''}
          </pre>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}

/**
 * Decides between the login screen and the dashboard.
 *
 * The session lives in an HttpOnly cookie, so the client cannot read it — it
 * asks the server who it is on boot. That also means a revoked or expired
 * session is caught on the next request rather than trusted until it expires.
 */
export function Shell() {
  const [session, setSession] = useState(null)
  const [checking, setChecking] = useState(true)
  const [unreachable, setUnreachable] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setChecking(true)
    setUnreachable(null)
    api
      .me()
      .then((s) => {
        if (!live) return
        setSession(s)
        setUnreachable(null)
      })
      .catch((err) => {
        if (!live) return
        setSession(null)
        /*
         * "Not signed in" and "could not ask" are different answers.
         *
         * Only the first should show the login screen. Treating a server that
         * was restarting as a signed-out visitor sends somebody to log in again
         * for no reason — and if they do, it fails, because the server that
         * could not answer cannot sign them in either.
         */
        if (err?.retryable) setUnreachable(err.message)
      })
      .finally(() => {
        if (live) setChecking(false)
      })
    return () => {
      live = false
    }
  }, [attempt])

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {})
    setSession(null)
  }, [])

  // A request rejected with 401 means the session went away underneath us.
  useEffect(() => {
    const onUnauthorized = () => setSession(null)
    window.addEventListener('df:unauthorized', onUnauthorized)
    return () => window.removeEventListener('df:unauthorized', onUnauthorized)
  }, [])

  if (checking) {
    return (
      <div className="signin">
        <div className="signin__card signin__card--quiet">
          <span className="busy">
            <span className="busy__spin" />
            Checking your session…
          </span>
        </div>
      </div>
    )
  }

  // The server could not be asked. Say so, rather than showing a login form
  // that cannot work either.
  if (unreachable) {
    return (
      <div className="signin">
        <div className="signin__card signin__card--quiet">
          <p style={{ margin: '0 0 12px' }}>{unreachable}</p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!session) return <Login onSignedIn={setSession} />

  return (
    <Boundary>
      <App session={session} onSignedOut={signOut} />
    </Boundary>
  )
}
