# Demand Forecast — web app

A Node/React front end for the Swishhh **PRODUCT FORECAST** Power BI reports, one semantic model per brand (BBT, Chilli Pepper, Pattie Pattie, Shawarma Shakir; ERMG and SLC-BUR are verified and one line away in `.env`). It reads
the published semantic model over the Power BI REST API (`executeQueries`) and
reuses the model's own DAX measures, so the numbers match the dashboard rather
than re-deriving them.

## Pages

| Tab | Mirrors report page | Slicers | Visuals |
|---|---|---|---|
| Forecast Summary | FORECAST SUMMARY | Brand, Location, Product, Article/PLU, Date | Actual Qty · Forecast Qty · Variance % · Forecast Accuracy % cards, Demand Forecast Tracking line chart, Top Products by Qty bars, Qty by Location columns + table |
| Product Level | PRODUCT LEVEL | Brand, Location, Product, Article/PLU, Date | Same 4 cards + Products count, sortable Runrate table with totals |
| Component Level | COMPONENT LEVEL | Brand, Location, Article/PLU, Component, Recipe Group, Production Type, Date | Components / Recipe Groups / Top Component cards, top-components charts faceted by base unit, Runrate by component table |
| Production Plan | PRODUCTION PLAN | Brand, Location, Product, Article/PLU, Prep Status | Tomorrow Forecast Qty, Products To Prepare, Extra Prep Needed, Reduced Prep Needed cards, prep-vs-recent-actual bars, production plan table with prep-status badges |

Every table has CSV export. Slicers cross-filter each other, an empty selection
means "no filter" (as in Power BI), and light/dark/system themes are supported.

## Model fields used

Verified against `../BBT PRODUCT FORECAST.SemanticModel`:

- `Forecast_Product_Table[Date | CHAINID | LocationID | Clean_ItemID | ProductName_Fixed_Option]`
- `'RECIPE TABLE'[Recipe Group | Item | Node Type | BU | Product PLU]`
- `Prep_Filter_Options[Prep Status]`, `DateTable[Date]`
- Measures: `[Total_Actual_Qty]`, `[Total_Forecast_Qty]`, `[Variance%]`,
  `[Variance_Qty]`, `[Forecast Accuracy %]`, `[Component_Forecast_Qty]`,
  `[Tomorrow Forecast Qty]`, `[Products To Prepare]`, `[High Demand Products]`,
  `[Low Demand Products]`, `[Last 2 Weekdays Avg Actual]`, `[Demand Change %]`,
  `[Product Prep Status]`

## Running it (local testing)

One-time:

```bash
npm run install:all     # server + client dependencies
```

Every time:

```powershell
npm.cmd run dev
```

Then open **http://localhost:7006** — that is the page you use.

Use `npm.cmd`, not plain `npm`, in PowerShell on this machine: the execution
policy blocks `npm.ps1` (`running scripts is disabled on this system`). The
`.cmd` entry point is not affected. To use plain `npm` instead, run once:
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`.

`npm run dev` starts two processes together:

- the **API** on port 7005 (talks to Power BI)
- the **web page** on port 7006 (what you look at), which forwards its `/api`
  calls to 7005

Both reload automatically when a file changes. Stop them with `Ctrl+C`.

### Troubleshooting

`EADDRINUSE: address already in use :::7005` — an older copy is still running.
Close the other terminal, or:

```powershell
Get-Process node | Stop-Process -Force
```

`ERR_CONNECTION_REFUSED` on 7006 even though Vite printed "ready" — the dev
server was binding to the IPv6 loopback (`::1`) only while the browser resolved
`localhost` to `127.0.0.1`. `vite.config.js` now pins `host: '127.0.0.1'`, which
fixes it. Check what is actually bound with:

```powershell
Get-NetTCPConnection -LocalPort 7005,7006 -State Listen | Select LocalAddress, LocalPort
```

### For IT, later

Hosting is not set up and is not needed for testing. When it is time to deploy,
`npm run build` produces `client/dist` and `npm start` serves the whole app from
port 7005 as a single process.

## Configuration (`.env`)

| Key | Meaning |
|---|---|
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Entra ID app registration used as the service principal |
| `MS_REDIRECT_URI` | Reserved for the interactive Microsoft sign-in flow (not wired up yet) |
| `PBI_WORKSPACE_ID` | The Swishhh Production workspace |
| `PBI_DATASETS` | Brands this deployment serves: `code|Label|datasetId`, comma separated. Each brand is its OWN semantic model, so the brand picker in the nav chooses which model every query runs against — it is not a column filter. |
| `PORT` | HTTP port, default `7005` |
| `DEMO_MODE` | `1` runs the UI on generated sample data with no Power BI calls |
| `CACHE_TTL` | Seconds each DAX result is cached in memory, default `120` |

`.env` holds a live client secret and is gitignored — keep it that way, and
rotate the secret if it ever gets committed or shared.

## Service principal access — done

The app signs in as the app registration whose **display name is
`BPA Web Platform`** (`MS_CLIENT_ID` = `b16c4d77-…`). It was granted
**Contributor** on the **SWISH PRODUCTION** workspace on 18 Aug 2026, and live
queries are confirmed working.

Two things to know if access ever breaks:

1. Power BI's *Add people* box resolves by **display name**, not by client ID —
   type `BPA Web Platform`, not the GUID.
2. `Viewer` is not sufficient. `executeQueries` needs Build permission on the
   semantic model, which Contributor grants and Viewer does not.

A revoked principal reports `Workspace … cannot be found` (Power BI returns 404
rather than 403 for workspaces a principal cannot see), and the UI shows a
banner with these steps. Verify with:

```bash
node -e "import('./server/powerbi/auth.js').then(async a=>{const t=await a.getAccessToken();const r=await fetch('https://api.powerbi.com/v1.0/myorg/groups',{headers:{Authorization:'Bearer '+t}});console.log(await r.text())})"
```

An empty `value: []` means the principal still has no workspace access.

## Interface

- **Navigation rail** — one entry per report page; collapses to icons (state is remembered).
- **Filter toolbar** — each slicer is a popover with search and select-all/clear. Applied
  filters also appear as removable chips, so what is narrowing the numbers is visible
  without opening every dropdown.
- **Tables** — sortable, searchable and paginated (50/100/250/All). Totals are computed
  over everything matching the search, not just the visible page. Pagination matters:
  the production plan returns ~3,700 rows.
- **Themes** — light / dark / follow-system, toggled top right and remembered.
- **Refresh** — clears the server cache and refetches, and the rail shows how long ago
  the data loaded.

## Layout

```
server/
  config.js            env parsing, required-settings check
  cache.js             TTL memory cache, de-duplicates in-flight queries
  routes/api.js        /api/slicers, /summary, /product-level, /component-level, /production-plan
  powerbi/auth.js      client-credentials token, cached until 60s before expiry
  powerbi/client.js    executeQueries call + row normalisation + error messages
  powerbi/dax.js       all DAX generation (filters, slicers, page queries)
  data/live.js         Power BI provider
  data/demo.js         sample-data provider (DEMO_MODE=1)
  data/index.js        provider selection + caching
client/src/
  App.jsx              tabs, shared filter state, theme toggle
  useData.js           debounced fetch hook, drops stale responses
  components/          slicers, KPI cards, sortable table, charts
  pages/               one file per report page
```

## Chart colour

Series colours are the validated categorical palette (blue `#2a78d6` /
orange `#eb6834`, stepped for dark mode), which clears colour-vision-deficiency,
normal-vision and contrast thresholds in both themes. Swishhh green `#297836`
is chrome only and never encodes a series. Prep status always ships an icon and
a label so state is never carried by colour alone.

## Notes on fidelity to the report

- The **Production Plan** page ignores the date slicer, because
  `[Tomorrow Forecast Qty]` and `[Last 2 Weekdays Avg Actual]` resolve their own
  dates from `TODAY()`. The report behaves the same way.
- The **Component Level** charts are faceted by base unit (KG / LTR / PCS)
  rather than sharing one axis, since mixed-unit quantities are not comparable.
- The report's hidden page filter excluding `Brand[ChainCode]` = blank / `YP COOP`
  is not replicated, because the app slices on
  `Forecast_Product_Table[CHAINID]` and defaults to `BBT`.
