import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import App from './App.jsx'
import { Login } from './pages/Login.jsx'

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

  return <App session={session} onSignedOut={signOut} />
}
