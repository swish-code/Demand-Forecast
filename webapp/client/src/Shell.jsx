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

  useEffect(() => {
    api
      .me()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setChecking(false))
  }, [])

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

  if (!session) return <Login onSignedIn={setSession} />

  return <App session={session} onSignedOut={signOut} />
}
