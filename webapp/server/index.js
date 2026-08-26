import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, missingSettings } from './config.js'
import { seedFirstAdmin } from './db/seed.js'
import { initDatabase } from './db/accounts.js'
import { attachUser } from './auth/middleware.js'
import { purgeExpiredSessions } from './auth/sessions.js'
import { api } from './routes/api.js'
import { auth } from './routes/auth.js'
import { admin } from './routes/admin.js'
import { startDigestSchedule } from './insights/digest.js'
import { startMailSchedule } from './mail/runner.js'
import { startPrewarm } from './warm.js'
import { startCubeSchedule, cubeState } from './cube/schedule.js'
import { loadCoverage } from './cube/query.js'
import { raise, clear, isOpen, loadOpenAlerts } from './insights/alerts.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.join(__dirname, '..', 'client', 'dist')

/*
 * SQLite first — it still holds the forecast copy and the mail tables — then
 * the accounts database, which is PostgreSQL and therefore asynchronous.
 *
 * Awaited before the server listens: a request arriving against a database with
 * no tables would fail in a way that looks like a bug rather than like a boot
 * still in progress.
 */
await initDatabase()
await loadOpenAlerts()
await loadCoverage()
await purgeExpiredSessions()

/**
 * The route an alert belongs to, stable wherever it is read from.
 *
 * `originalUrl` is the one property Express never rewrites; the query string is
 * dropped so two calls to the same endpoint with different filters fold into a
 * single alert rather than one per parameter combination.
 */
const routePath = (req) => req.originalUrl.split('?')[0]
const routeKey = (req) => `app:${req.method}:${routePath(req)}`

const app = express()
// Behind IIS or a reverse proxy this makes req.ip the real client address.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 0)
app.use(express.json({ limit: '1mb' }))

// Every request learns who is signed in; individual routes decide what that means.
app.use(attachUser)
/**
 * A route that starts working again clears its own alert.
 *
 * Without this, a fault recorded during a network blip sits on the admin page
 * indefinitely even though the route recovered minutes later — which teaches
 * people to ignore the alert list. Power BI alerts already self-heal this way
 * when the digest next reads a brand successfully; this does the same for
 * routes.
 */
app.use((req, res, next) => {
  // Captured now, not inside the listener. Express rewrites req.url as a
  // request passes through a mounted router, so by the time 'finish' fires
  // req.path can read "/slicers" rather than "/api/slicers" — which silently
  // produced a key that matched nothing and cleared nothing.
  const key = routeKey(req)
  res.on('finish', () => {
    if (res.statusCode >= 500) return
    if (isOpen(key)) clear(key)
  })
  next()
})

app.use('/api/auth', auth)
app.use('/api/admin', admin)
app.use('/api', api)

// Serve the built SPA in production; in dev, Vite serves it and proxies /api.
app.use(express.static(clientDist))
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next()
  })
})

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
app.use((err, req, res, next) => {
  const status = err.status || 500
  if (status >= 500) {
    console.error('[api]', err)
    // Server faults are recorded so the admin sees them, rather than only the
    // one user who happened to hit the failing page.
    raise({
      source: 'app',
      // Keyed on the route, not the message, so a failing endpoint folds into
      // one alert however many people trip over it.
      key: routeKey(req),
      severity: 'critical',
      title: `${req.method} ${routePath(req)} failed`,
      detail: err.message,
    })
  }
  res.status(status).json({ error: err.message || 'Internal error' })
})

/*
 * A stray promise must not be able to take the site down.
 *
 * Node ends the process on an unhandled rejection. Inside a request that is
 * fine — Express catches it and answers 500. Outside one it is not: a rejection
 * in a scheduled job, a timer or a fire-and-forget write kills a server that
 * was otherwise answering perfectly, and every request in flight dies with it.
 * On a hosted deployment the platform restarts the container and the person
 * using the app sees an error with no message in it, on whatever page they
 * happened to be on — which is exactly how this presented.
 *
 * Staying up with one broken background task beats dropping every request, so a
 * rejection is logged, recorded as an alert an administrator can actually see,
 * and otherwise ignored.
 *
 * An uncaught exception is treated differently. That one can leave state
 * genuinely broken, so it is recorded and then allowed to end the process, and
 * the platform restarts it clean. The exit is deferred a moment so the alert
 * has a chance to reach the database first.
 */
function recordCrash(kind, err) {
  const message = err instanceof Error ? err.stack || err.message : String(err)
  console.error(`  [${kind}]`, message)
  return raise({
    source: 'app',
    key: `process:${kind}`,
    severity: 'critical',
    title: `Unhandled ${kind} in a background task`,
    detail: message.slice(0, 2000),
  })
}

process.on('unhandledRejection', (reason) => {
  recordCrash('rejection', reason)
})

process.on('uncaughtException', (err) => {
  recordCrash('exception', err).finally(() => {
    setTimeout(() => process.exit(1), 250).unref?.()
  })
})

const server = app.listen(config.port, async () => {
  const seeded = await seedFirstAdmin()
  if (seeded) {
    console.log('\n  Empty database - created administrators from ADMIN_EMAILS:')
    for (const email of seeded.admins) console.log(`    ${email}`)
    console.log('    They sign in with Microsoft; there is no password to hand out.')
  }

  console.log(`\n  BBT Product Forecast API  ->  http://localhost:${config.port}`)
  if (config.demoMode) {
    console.log('  Mode: DEMO (generated sample data, no Power BI calls)')
    console.log('  Set DEMO_MODE=0 in .env to query the live semantic model.\n')
  } else {
    const missing = missingSettings()
    console.log('  Mode: POWER BI executeQueries')
    console.log(`  Workspace ${config.pbi.workspaceId}`)
    console.log(`  Brands    ${config.brands.map((b) => b.code).join(', ')}`)
    if (missing.length) {
      console.log(`  WARNING: missing .env settings -> ${missing.join(', ')}`)
    }
    console.log('')
  }

  // The morning digest only makes sense against the live model, and running it
  // in demo mode would fill the admin page with findings about fake numbers.
  if (!config.demoMode) {
    startDigestSchedule()
    console.log(`  Daily digest scheduled for ${String(process.env.DIGEST_HOUR ?? 7).padStart(2, '0')}:00 local`)

    if (startMailSchedule()) {
      console.log(`  Daily reports scheduled for ${String(config.mail.hour).padStart(2, '0')}:00 local`)
      if (config.mail.testTo) console.log(`  MAIL_TEST_TO is set — every report goes to ${config.mail.testTo}`)
    } else {
      console.log('  Daily reports are off (set MAIL_ENABLED=1 to schedule them)')
    }

    if (startCubeSchedule()) {
      const c = await cubeState()
      console.log(
        `  Local copy on — ${c.rows.toLocaleString()} rows across ${c.brands.length} brand(s), ` +
          `refreshed every ${process.env.CUBE_REFRESH_MINUTES ?? 60} min, full rebuild at ${String(process.env.CUBE_BACKFILL_HOUR ?? 2).padStart(2, '0')}:00`
      )
    }

    if (startPrewarm()) {
      console.log('  Cache prewarm on — the pages the copy does not cover are fetched between requests')
    }
    console.log('')
  }
})

// A dead API behind a live Vite proxy shows up in the browser only as a vague
// "Request failed (500)", so say plainly what happened and how to clear it.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ERROR: port ${config.port} is already in use.\n`)
    console.error('  Another copy of the API is still running. The web page will')
    console.error('  load but every request will fail with 500 until this is fixed.\n')
    console.error('  Free the port, then start again:')
    console.error(`    PowerShell:  Get-NetTCPConnection -LocalPort ${config.port} -State Listen |`)
    console.error('                 ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n')
    process.exit(1)
  }
  console.error('[server]', err)
  process.exit(1)
})






