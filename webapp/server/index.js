import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { gzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { config, missingSettings } from './config.js'
import { DATA_DIR } from './db/driver.js'
import { seedFirstAdmin } from './db/seed.js'
import { initDatabase } from './db/accounts.js'
import { attachUser } from './auth/middleware.js'
import { purgeExpiredSessions } from './auth/sessions.js'
import { api } from './routes/api.js'
import { perfMiddleware } from './perf.js'
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

// Before the routers, so every API request carries a ledger.
app.use('/api', perfMiddleware)

/*
 * Nothing was compressed. Not the JSON, not the bundle.
 *
 * Express does not compress anything by default and nothing here had been added
 * to. The production plan for nine brands is 4.7 MB of JSON on the wire; the
 * client bundle is another half a megabyte. Both are text, both compress about
 * ten to one, and on any connection slower than a local socket that transfer is
 * most of what the reader is waiting for — the server had already finished its
 * work in a tenth of a second.
 *
 * Written against node's own zlib rather than pulling in a package, and
 * asynchronous rather than gzipSync: compressing four megabytes on the event
 * loop would stall every other request in flight to save one of them some
 * bytes.
 */
const MIN_GZIP = Number(process.env.GZIP_MIN_BYTES) || 1400

const wantsGzip = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '')

app.use((req, res, next) => {
  if (!wantsGzip(req)) return next()
  const plain = res.json.bind(res)

  res.json = (body) => {
    let text
    try {
      text = JSON.stringify(body)
    } catch {
      return plain(body)
    }
    // Below about one packet the gzip header costs more than it saves.
    if (text.length < MIN_GZIP) return plain(body)

    gzip(text, (err, buf) => {
      if (err) return plain(body)
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Encoding', 'gzip')
      res.setHeader('Vary', 'Accept-Encoding')
      res.setHeader('Content-Length', buf.length)
      res.end(buf)
    })
    return res
  }

  next()
})

/*
 * The bundle, compressed once and kept.
 *
 * A build produces a handful of hashed files that never change, so they are
 * gzipped the first time somebody asks and held in memory afterwards. The hash
 * is in the filename, so a new build is a new key and the old entries fall out
 * of use rather than going stale.
 */
const packed = new Map()

app.use((req, res, next) => {
  if (!wantsGzip(req) || req.method !== 'GET') return next()
  if (!/\.(js|css|svg|json|map)$/.test(req.path)) return next()

  const file = path.join(clientDist, req.path)
  if (!file.startsWith(clientDist)) return next()

  const serve = (buf) => {
    res.setHeader('Content-Type', TYPES[path.extname(req.path)] ?? 'application/octet-stream')
    res.setHeader('Content-Encoding', 'gzip')
    res.setHeader('Vary', 'Accept-Encoding')
    // Hashed filenames, so this can be cached hard; index.html is not served here.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.setHeader('Content-Length', buf.length)
    res.end(buf)
  }

  const held = packed.get(req.path)
  if (held) return serve(held)

  fs.readFile(file, (readErr, raw) => {
    if (readErr) return next()
    gzip(raw, (err, buf) => {
      if (err) return next()
      packed.set(req.path, buf)
      serve(buf)
    })
  })
})

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

app.use('/api/auth', auth)
app.use('/api/admin', admin)
app.use('/api', api)

/*
 * The one file that must never be cached.
 *
 * Every build gives the bundles new hashed names, and those are served with a
 * year of immutable caching because a hashed file's content can never change.
 * index.html is the opposite: it is the only thing that knows which hashes are
 * current, and a browser holding yesterday's copy asks for bundles that no
 * longer exist — a blank page that a hard reload fixes and nothing else does.
 *
 * So the shell revalidates every time. It is 833 bytes; the round trip costs
 * nothing next to being served a page that cannot start.
 */
const noStore = (res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

// Serve the built SPA in production; in dev, Vite serves it and proxies /api.
app.use(
  express.static(clientDist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) noStore(res)
    },
  })
)
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  noStore(res)
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next()
  })
})

/**
 * Faults, on disk as well as on the console.
 *
 * The console is fine while somebody is watching it. Nobody is watching the
 * deployment's, and by the time a fault is reported the scrollback that held it
 * has usually gone — which is how "the calculated columns are blank" arrives
 * with no way to find out why.
 *
 * One file, capped and rotated, holding the last stack traces and the request
 * that produced them. Read it at <DATA_DIR>/error.log, or through the admin
 * alerts, which record the same faults but only their messages.
 */
const ERROR_LOG = path.join(DATA_DIR, 'error.log')
const ERROR_LOG_MAX = 1024 * 1024

export function logError(where, err, extra = null) {
  const line = [
    `[${new Date().toISOString()}] ${where}`,
    extra ? `  ${JSON.stringify(extra)}` : null,
    `  ${err?.stack || err?.message || String(err)}`,
    '',
  ]
    .filter((v) => v !== null)
    .join('\n')

  try {
    if (fs.existsSync(ERROR_LOG) && fs.statSync(ERROR_LOG).size > ERROR_LOG_MAX) {
      fs.renameSync(ERROR_LOG, `${ERROR_LOG}.1`)
    }
    fs.appendFileSync(ERROR_LOG, line)
  } catch {
    /* a log that cannot be written must never be the thing that breaks */
  }
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
app.use((err, req, res, next) => {
  const status = err.status || 500
  if (status >= 500) {
    console.error('[api]', err)
    logError(`${req.method} ${routePath(req)}`, err, {
      brands: req.body?.brands,
      dateFrom: req.body?.dateFrom,
      dateTo: req.body?.dateTo,
      user: req.user?.email ?? null,
    })
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
  logError('unhandledRejection', reason)
  recordCrash('rejection', reason)
})

process.on('uncaughtException', (err) => {
  logError('uncaughtException', err)
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






