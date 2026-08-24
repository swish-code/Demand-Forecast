<!-- markdownlint-disable MD013 -->
# Demand Forecast — guide

A web front end over the Swishhh Power BI product-forecast models. It reads the
same semantic models as the Power BI reports through the `executeQueries` REST
API and reuses the models' own DAX measures, so a number here and the same
number in Power BI cannot drift apart.

Nine brands, each its own semantic model: **BBT, Chilli Pepper, Pattie Pattie,
Shawarma Shakir, Yelo Pizza, Slice, Just C, Mishmash, Tabel**. Choosing a brand
selects a different model rather than filtering a column. Two models hold two
brands each — SLC-BUR and ERMG — and the chain is pinned automatically, so Slice
and Just C never show each other's numbers.

**Several brands can be selected at once.** Each is queried separately and the
results added together: quantities add, and variance and accuracy are recomputed
from the totals rather than averaged — the average of two brands' percentages is
not the percentage of their combined totals unless the brands happen to be the
same size.

---

## Contents

- [Running it](#running-it)
- [Signing in](#signing-in)
- [Roles and statuses](#roles-and-statuses)
- [The pages](#the-pages)
- [Every metric, explained](#every-metric-explained)
- [Why forecast and actual differ](#why-forecast-and-actual-differ)
- [Administration](#administration)
- [Daily email reports](#daily-email-reports)
- [Configuration](#configuration)
- [Outstanding items](#outstanding-items)

---

## Running it

```
npm.cmd run dev
```

Two processes start: the API on **7005** and the Vite dev server on **7006**.
Open **http://localhost:7006**.

Use `npm.cmd`, not `npm` — PowerShell's execution policy blocks `npm.ps1` on this
machine.

There is no hosting setup here by design; the folder is handed to IT for that.

---

## Signing in

**Microsoft is the way in.** Staff use their Swishhh work account, and nobody has
to be issued another password. It uses OpenID Connect with PKCE against the same
app registration that reads Power BI, so the only setup is the redirect URI —
already registered.

Signing in with Microsoft proves *who someone is*. It deliberately does not
decide *what they may see*: that still comes from the users table. Someone with a
valid tenant account who has never been set up lands as a **pending** account
with no scope, appears in the admin approval banner, and sees nothing until an
administrator grants them a role and a brand.

The password form is kept behind a link rather than removed, for two reasons: the
first admin exists before anyone has signed in with Microsoft, and if the
redirect URI is ever misconfigured in Entra the password form is the only way
back into the application.

The session lives in an HttpOnly cookie for **12 hours** (`SESSION_TTL_HOURS`)
and can be revoked instantly from the admin page — which is why sessions are
server-side rather than JWTs.

The first admin is seeded from `.env` on first run (`ADMIN_EMAIL`,
`ADMIN_PASSWORD`). **Change that password once you are in** — open your own row
in the users table and use *Change my password*. Your current tab stays signed
in; every other device signed in as you is signed out.

Three brakes on the sign-in form, all of which an admin can see the effects of:

| Brake | Behaviour |
|---|---|
| Per-IP throttle | More than **20 attempts a minute** from one address is refused |
| Per-account lockout | **5 failed attempts** locks the account for **15 minutes**, and raises an alert |
| Uniform errors | An unknown email and a wrong password give the same message and take the same time, so the form cannot be used to discover who has an account |

Only a SHA-256 of the session token is stored, so the database cannot be used to
impersonate anyone.

---

## Roles and statuses

**Role** is *what someone can see*. **Status** is *whether they can get in at
all*. They are separate on purpose: you can suspend a stakeholder without losing
the brand grants you set up for them, then reactivate them unchanged.

### Departments

Which part of the business someone sits in: Production, Branches, Warehouse,
Operations, Supply Chain, Finance, Marketing, IT, Management.

Kept separate from role, because the two do not line up — a warehouse lead and a
GM can both be stakeholders. It is a fixed list rather than free text because the
usage figures group on it, and "Prodution" typed once would show as a second
department and quietly halve both numbers.

### Roles

| Role | Sees |
|---|---|
| **admin** | Every brand and location, plus the Administration tab |
| **stakeholder** | Read-only across the brands granted to them. For head office |
| **store** | Read-only, normally locked to one brand and its own branches |

### Statuses

| Status | Meaning |
|---|---|
| **active** | Can sign in now. The normal state |
| **pending** | Account exists, sign-in refused. For setting someone up before they should have access. Shows in the amber "awaiting approval" banner |
| **suspended** | Blocked, **and every open session ends immediately**. For a temporary block — someone on leave, or an account you suspect is compromised |
| **disabled** | Same block, same instant sign-out. Means "gone for good". Keeping the row rather than deleting preserves their sign-in history |

Suspended and disabled behave identically to the server. The distinction is for
whoever reads the user list in six months.

### Scope

Scope is read from the database against the session on every request, **never**
from the request body. Editing a payload cannot widen access. If Power BI cannot
be reached to resolve a location list, the request fails closed rather than
serving unscoped data.

- No brands granted → sees nothing.
- Brands but no locations → every location in those brands.
- Brands and locations → the intersection.

---

## The pages

| Page | Question it answers | Who it is for |
|---|---|---|
| **Forecast Summary** | How did we do against forecast, and why | Everyone |
| **Product Level** | Which articles and products were off, and by how much | Everyone |
| **Component Level** | What ingredients and packaging the forecast implies | Kitchen, purchasing |
| **Production Plan** | What each branch prepares tomorrow | Branch staff |
| **Administration** | Accounts, alerts, the morning digest, email reports | Admins only |

All slicers are multi-select, brand included.

Selections survive a brand change. Picking a date, switching brand and finding
the date gone is the kind of small betrayal that makes a tool feel unreliable,
so the window is carried over and clamped into the new model's calendar. Any
location or product the new brand has never heard of is dropped, because keeping
it would silently filter the page down to nothing.

### Date presets

Backward ranges — last 7, 14, 30 days and month to date — **end yesterday, not
today**. Today's actuals are still being written, so including it compares a full
day of forecast against a part day of sales and drags every figure down for a
reason that has nothing to do with the forecast.

Forward ranges — next 7 and next 30 days — are the opposite case. They are about
what is still to come, so they start today.

On the Production Plan the article slicer lists **product names** with the
article code beside them. The model has no article-name column — an article is a
bare code like `83001108300117` — so pairing it with its product is what makes it
findable.

---

## Every metric, explained

### Thresholds

These are the same everywhere in the app, including the emails and the digest.

| Threshold | Value | Meaning |
|---|---|---|
| Accuracy target | **95%** | At or above: on track (green) |
| Accuracy floor | **85%** | Below: outlier (red) |
| Variance OK | **±5%** | Inside: on track (green) |
| Variance limit | **±15%** | Beyond: outlier (red). Between 5% and 15% is amber |

### Core figures

**Actual qty** — units sold in the selected window.

**Forecast qty** — units the model expected over the same window.

**Variance** — `(actual − forecast) ÷ forecast`. Negative means actual came in
below forecast.

**Accuracy** — `1 − |actual − forecast| ÷ actual`. Direction-blind: 10% over and
10% under both read as 90%.

**Over-forecast / under-forecast** — named from the forecast's point of view.
Forecast **above** actual is *over*-forecast (prep that was not needed).
Forecast **below** actual is *under*-forecast (branches ran short). The shaded
bands on the trend chart use the same convention.

### Forecast Summary

| Visual | What it shows |
|---|---|
| **Demand tracking** | Daily actual against forecast, shaded where they diverge, with a grey envelope showing where actual normally lands |
| **Gap contributors** | Products ranked by their share of the total miss, with the running cumulative share |
| **Rolling 7-day accuracy** | Seven-day accuracy against the 95% target. A single day is noisy; the rolling figure is not |
| **Accuracy by day of week** | Bias per weekday. Answers whether one day is always wrong, which is the part that can be fixed |
| **Products by quantity** | Every product, actual against forecast, with variance labelled. Scrolls; click a bar to open it in Product Level |
| **By location** | Every branch, worst accuracy first |

### Product Level

**Demand vs prev** — how much that article **actually sold** in the selected
window against the window immediately before it, of the same length. With "Last
30 days" chosen, that is roughly 21 Jul–19 Aug against 21 Jun–20 Jul.

It sits beside the variance because together they separate two very different
situations:

- *French Fries: demand **−72.9%**, variance −28.7%* — demand collapsed and the
  forecast has not caught up. A demand event.
- *SALT: demand **−62.3%**, variance −10.8%* — demand fell just as hard and the
  forecast largely tracked it. The model did its job.

A **—** means nothing sold in the earlier window, so there is no comparison to
make. About 44% of BBT's articles fall into that bucket — they are ordinary
low-volume lines, not new products, which is why the cell shows nothing rather
than inventing a percentage.

### Production Plan

**Tomorrow forecast qty** — total units to prepare tomorrow.

**Products to prepare** — distinct articles on the plan.

**Extra prep needed** — demand up more than 20% on the recent average.

**Reduced prep needed** — demand down more than 20%.

**Demand change** — tomorrow's forecast against the average of the last two
matching weekdays.

**Prep pressure by branch** — products on tomorrow's plan per branch, split by
which way demand has moved, ordered by how much is *changing* rather than by
size. A branch with sixty products all needing extra prep is a different morning
from one running normally.

**How much to trust these numbers** — the panel above the plan, and the same
block in the store email. It restates the recent accuracy as the question a
kitchen actually asks: of what the plan says to prepare, how much has been
selling?

> On a normal day, about 95% of what this plan asks for actually sells.
> Eight days out of ten land between 80% and 106% of the plan.

A share of the plan rather than a variance percentage, because "about 95% of this
has been selling" can be acted on and "the forecast runs 4.7% above actual"
cannot. It is computed for whatever is on screen, so a single branch gets its own
figure — SMY reads 93% where BBT as a whole reads 95%.

These figures deliberately ignore the date slicer, matching the Power BI report:
the underlying measures resolve their own dates from `TODAY()`.

---

## Why forecast and actual differ

The most common question this app gets asked is some version of *"the plan told
us to prepare more than we sold — is the dashboard wrong?"*. Usually it is not,
and the real reason is measurable.

One endpoint measures the **last 30 complete days** and returns a cause. It
ignores the date slicer on purpose — "is this normal for us?" is a question about
the recent past, not about whichever range happens to be selected — but it does
respect location and product filters, so a branch asking about its own numbers is
answered about its own numbers.

Both the Forecast Summary and the Production Plan read the same answer from the
same place, so a branch and head office are never told different things.

### The five verdicts

Checked in this order, and the first that applies is the one shown.

| Verdict | Fires when | What it means |
|---|---|---|
| **Demand has moved** | Demand shifted ≥5% week on week and the forecast lagged by ≥3pp | Sales changed and the forecast has not caught up yet. External |
| **A weekday pattern** | One weekday leans ≥8% and correcting weekdays would save ≥1pp | Predictable rather than random. Prepare toward the appropriate end on that day |
| **A steady offset in the forecast** | Consistent lean ≥3% and larger than the scatter | **The forecast itself.** A fixed offset for whoever maintains the model |
| **Normal variation** | No consistent lean; scatter dominates | Some days over, some under. A gap this size on any one day is expected |
| **Not explained** | None of the above | **Worth raising.** None of the usual causes account for it |

The last two rows are the point. A panel that always finds an outside cause gets
noticed within a fortnight and then nobody believes any of it — including the
true readings. Two of the five verdicts point at the forecast.

### The supporting numbers

**Steady lean** — the average signed error. A consistent offset that
recalibrating the model would remove.

**Day-to-day scatter** — what is left after the lean. Varies either way with no
pattern, and no adjustment removes it.

The split matters more than the total. A typical daily gap of 9.8% made of 4.7pp
lean and 5.2pp scatter means roughly half is somebody's to fix and half is not.

**Sold this week / Forecast this week** — week-on-week change in each, with the
chart beside them. When the lines move together the forecast is tracking demand.
When actual turns and forecast does not, the space between the lines *is* the
explanation.

### The "usual range" band

The grey envelope on the trend chart covers the **10th to 90th percentile** of
this brand's own recent daily variance. Actual inside it is an ordinary day;
outside it is genuinely unusual.

Percentiles rather than a standard deviation on purpose — one closure or one
promotion would inflate an SD exactly when the band needs to be tight.

### Weekday guidance

A banner above the production plan, shown only when tomorrow's weekday leans
**5% or more**. It stays quiet otherwise rather than crying wolf. BBT's pattern
at the time of writing: Mon +7.0%, Wed +15.0%, Thu +12.7% and Sat −8.1% would
show a banner; Tue, Fri and Sun would not.

### Branch lean

Every branch's signed lean, sorted. The meaning is in the pattern, not any single
bar. All branches leaning the same way is a brand-wide offset no branch can do
anything about — and the panel says so. A lone branch leaning the other way is
the one worth investigating, and this is the only view where that stands out.

---

## Administration

Admin-only tab. A non-admin has no route to it and the server refuses its
requests regardless.

### Layout

1. **Counts** — total, active, seen in 30 days, pending or blocked
2. **Add a user** — directly under the counts, with pending accounts as one-click chips
3. **This morning** (the digest) beside **Alerts**
4. **Sign-in activity** and **Where the app is used**
5. **Users** table
6. **Daily reports**
7. **Recent sign-in attempts**

### Adding a user

Set role, status, then brands and — for a store account — locations. The location
list is read **live from Power BI** for whichever brands are ticked, so a new
branch appears the moment it exists in the model.

The password is generated (16 characters) and **shown exactly once**. Nobody,
including you, can read it back. If it is lost, reset it and issue a new one. You
may also type a password instead; minimum 12 characters.

Resetting anyone's password signs them out everywhere. Changing your own signs
out your other devices but keeps the tab you are working in.

Guards that cannot be overridden: the last active admin cannot be demoted,
suspended, disabled or deleted, and you cannot delete your own account.

Every change writes to an audit log with who did it and when.

### This morning — the daily digest

Built automatically at **07:00** local (`DIGEST_HOUR`), stored one row per day so
the message stays the same all morning rather than shifting under you on every
page load. **Check now** rebuilds it; **Mark as read** records who read it.

It walks every brand and reports: stale actuals, a brand that cannot be read at
all, **yesterday's accuracy against a 90% threshold**, variance past ±15% with
the direction named, branches below the floor, accuracy trending down, an empty
production plan, and an unusual share of extra prep (above 40% — roughly a
quarter to a third is normal, and reporting that every morning would just be
noise).

### Yesterday, every brand

The digest opens with a roll call: **all nine brands with yesterday's accuracy**,
worst first, whether or not they breached anything. Each tile carries the figure
and the two numbers behind it — *Slice 83.8%, 4,998 sold vs 5,806* — with a
coloured edge for anything under the threshold.

State sits on the edge of the tile rather than filling it. Nine tinted blocks at
once would read as an alarm even on a morning when everything is fine.

The findings underneath still name only the brands that need something done. The
scoreboard answers "how did everyone do?"; the findings answer "what do I do?"

### Accuracy in the digest is one day, not thirty

| | Threshold | Severity |
|---|---|---|
| Yesterday's accuracy | below **90%** | worth a look |
| | below **80%** | needs attention |

A month-long average is slow to move and slow to recover, so it reports the same
brands as "under target" for weeks after the day that caused it — which is not a
morning message. One day is what an operator can still do something about, and
the finding quotes the figures behind it: *"Slice: 83.8% on Fri 21 Aug — sold
4,998 against a forecast of 5,806."*

The line sits at 90% rather than the 95% used for a period, because a single day
swings far more than a month does; holding one day to 95% would flag every brand
every morning. The 80% floor is not "missed it" but "had a bad day".

Everything else in the digest — trends, branch checks, variance — still looks
back over the full 30 days, because those only mean anything across a period. The
panel says which is which.

**It measures to the last complete day, not to today.** Today is still being
written and a half-finished day drags accuracy down for reasons that have nothing
to do with the forecast. This is why a digest figure can read higher than the
same brand's card on the dashboard, whose window runs to today by default. The
panel states its window for exactly this reason.

### Alerts

Faults, as opposed to forecast findings. The digest is *what the forecast says*
and is read once; alerts are *what is broken* and stay until someone clears them.

Fed by real failures: Power BI refusing a brand, mail failing to send, any 5xx
from the API, and account lockouts. Repeats fold into one row with a count, so a
loop failing every thirty seconds is one line saying "×214" rather than two
hundred lines. Clearing one by hand records who did it.

**Most clear themselves.** A brand that reads successfully on the next digest
run retires its own alert, and a route that returns a non-5xx response retires
its own. Only faults that cannot prove they are fixed — a failed send, for
instance — wait for a person. Alerts that linger after the problem has gone are
how a team learns to stop reading the list.

---

## Daily email reports

Sent through Microsoft Graph as the mailbox in `OUTLOOK_EMAIL`, using the same
app registration that reads Power BI.

### Comparing against Power BI

The app and the models agree exactly. Verified across all nine brands, all
dates: every actual and every forecast matches a direct model query to the unit.

If a figure looks different, check the **date range** first. The Power BI reports
open with **no date selection** — the whole year — while the app defaults to the
last 30 days ending yesterday. Comparing those two compares different windows.
Set the report's date slicer to the same range and the numbers meet.

### Who receives what

Recipients are chosen explicitly on the admin page, not inferred from accounts.
An address does not need a dashboard login: a distribution list, an area
manager, or a kitchen's shared mailbox are all legitimate recipients, and
requiring an account for each would mean creating logins nobody uses.

Each recipient is an address, one report, a scope, and **who it goes to** —
Branches, Warehouse, Operations and so on, from the same list as user
departments. That last one changes nothing about what is sent; it is so a list
of forty addresses can be read at a glance.

| Report | Contains | Scope |
|---|---|---|
| **Tomorrow's prep list** | One branch, what to prepare | Needs at least one store — one email per store |
| **Tomorrow across stores** | Every store in the chosen brands, ranked by how far from a normal day | Brands; no brand chosen means all |
| **Morning digest** | Yesterday's accuracy for every brand, plus anything needing attention | The whole group |

Sending can be paused per recipient, which keeps the setup but stops the mail —
for somebody on leave. The same address cannot be added to the same report
twice, so nobody gets two copies.

Existing store and stakeholder accounts were carried over automatically when
this replaced the old role-based sending, so nothing stopped silently.

### The two audiences, in detail

**Store accounts** get their own branch's prep list for tomorrow and nothing
else: products, article, quantity to prepare, recent average, demand change and
prep status, ordered by volume. Four summary cards and a callout when products
need extra prep. A branch manager needs a prep list, not a group KPI.

**Stakeholder accounts** get tomorrow across every brand they are scoped to,
**broken down by store**, ranked by how far each branch departs from its normal
day rather than by size — the big branch is big every day; the one about to do
26% more is the news.

Scope comes from the same code the API uses, so an email can never show someone a
branch the dashboard would refuse them. **A store account with no branch assigned
is skipped**, not sent the whole brand.

### Controls

The panel is ordered so that everything reversible happens before the send:

1. **Mailbox check** — whether mail can actually be sent
2. **Recipients** — who would be reached, and what each would get
3. **Preview** — renders one person's actual report without sending
4. **Dry run** — builds every report, sends nothing
5. **Send now**

Every attempt is logged, successes included. When a branch says the plan never
arrived, the answer needs to be a row with a timestamp.

### Test mode

While `MAIL_TEST_TO` is set, **every** report is delivered to that address
instead of its real recipient, with the intended address in the subject line. The
override is applied at the moment of sending rather than when the list is built,
so there is no path where a half-configured run reaches real branches. Clear the
line in `.env` to send for real.

`MAIL_ENABLED=0` keeps the 07:00 schedule off entirely.

---

## Configuration

All in `webapp/.env`. **This file holds a live client secret and is gitignored —
keep it that way.**

| Setting | Purpose |
|---|---|
| `PORT` | API port (7005) |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Entra app registration |
| `PBI_WORKSPACE_ID` | Power BI workspace |
| `PBI_DATASETS` | `code\|Label\|datasetId[\|chain]`, comma separated |
| `DEMO_MODE` | `1` generates sample data and makes no Power BI calls |
| `CACHE_TTL` | Seconds a query result is cached (600) |
| `PBI_MAX_CONCURRENCY` | Simultaneous Power BI queries (3) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Seed the first admin on first run |
| `SESSION_TTL_HOURS` | Session lifetime (12) |
| `COOKIE_INSECURE` | **Local development only.** Must not ship to production |
| `DIGEST_HOUR` | Local hour the morning digest is built (7) |
| `OUTLOOK_EMAIL` | Mailbox reports are sent as |
| `MAIL_TEST_TO` | Redirect every report here while testing |
| `MAIL_HOUR` | Local hour reports go out (7) |
| `MAIL_ENABLED` | `0` disables the schedule |

### The reports carry hidden filters — the app copies them

Every Power BI report applies filters that are hidden from the reader, and the
app reproduces them so the two agree. The one that matters excludes products
whose name begins **`SM`**.

It is not marginal. On 22 August it removed:

| Brand | Removed | Share |
|---|---|---|
| Yelo Pizza | 2,842 units | **10.4%** |
| Pattie Pattie | 343 | 9.8% |
| Just C | 8 | 5.9% |
| Mishmash | 674 | 4.7% |
| Tabel | 296 | 3.2% |
| BBT | 752 | 1.9% |

With the filter applied, BBT for that day reads **39,739 sold against a forecast
of 41,018 — identical to the report**.

Two further report filters (excluding brand `YP COOP`, and a null `ChainName`)
were measured against all nine models and changed nothing, so they are
deliberately not reproduced. Inert filters on every query would be surface area
with no benefit.

**A caveat worth passing on.** The report matches on the first two characters,
so it also removes genuine products that merely start with "Sm" — *Smokey Rolls
Beef* among them. The app copies that behaviour on purpose, because agreeing
with the report matters more than being cleverer than it. Fixing it belongs in
the report, and both would then need changing together.

### Power BI access

The service principal needs **Contributor** on the workspace — Viewer is not
enough, because `executeQueries` requires Build permission. Note that Power BI
returns **404** rather than 403 for a workspace the principal cannot see, so a
"workspace cannot be found" error usually means permissions, not a wrong ID.

Add the principal by its **display name** (BPA Web Platform); the picker does not
resolve GUIDs.

### Load speed

Each slicer list is its own DAX round trip against every selected model, so
pages ask only for the lists they actually render — the summary page fetches two
instead of nine. That alone took a cold slicer load from 1.9s to 0.4s. Results
are cached per dataset for `CACHE_TTL` seconds, and the `need` list is part of
the cache key so a page asking for four lists is never served an entry that only
fetched two.

### When Power BI cannot be reached

Transient network failures are retried four times with backoff (0.6s, 1.8s,
4.5s) before giving up, and each request times out after 60 seconds
(`PBI_TIMEOUT_MS`) so a hung socket cannot hold a page open.

This used to be broken in a way worth knowing about: the retry only tested the
HTTP status code, and a network failure rejects with no status at all. A single
dropped socket therefore failed a whole page instantly, showing the useless
message *"Could not load data. fetch failed"*, when a 600ms retry would almost
always have succeeded.

Errors that never reached the service now say what actually happened — *"Could
not reach Power BI — the connection was reset mid-request. Tried 4 times."* A
genuine refusal such as a 403 is still failed immediately, because a permission
error does not fix itself by asking again.

### Rate limiting

Power BI throttles `executeQueries`. The client gates concurrency, honours
`Retry-After`, and backs off. If 429s appear, raise `CACHE_TTL` or lower
`PBI_MAX_CONCURRENCY`.

---

## Outstanding items

**Mail.Send permission.** Reports cannot be sent until the app registration is
granted the **`Mail.Send` application permission with admin consent** on the
tenant. It currently has **no** Graph application permissions at all — Power BI
works through workspace membership, which is a different mechanism.

Entra admin centre → App registrations → *BPA Web Platform* → API permissions →
Add a permission → Microsoft Graph → **Application permissions** → `Mail.Send` →
add → **Grant admin consent**. Confirm it shows *Granted*, then press Refresh on
the Daily reports panel.

`Mail.Send` (Application) allows sending as any mailbox in the tenant. If that is
too broad, the standard narrowing is an Exchange Online **application access
policy** scoping it to `automation@swishhh.net` alone. Worth mentioning when you
request it.

**Brand logos.** Drop eight PNGs into `webapp/client/public/brands/` named
`bbt.png, chp.png, pat.png, ss.png, yp.png, slc.png, mm.png, tbl.png`. The wiring
is done and falls back to coloured code chips until the files exist.

**Before production.** Remove `COOKIE_INSECURE`, change the seeded admin
password, delete the `store@test.local` and `stake@test.local` test accounts, and
rotate the client secret if `.env` has ever been shared.

### A note on brand colours

Each brand has its own colour on its chip. Nine brands is past what colour alone
can carry — an even nine-step hue circle still leaves the closest pair well below
the separation a reader needs, and no hand-picked set does better. The colour is
a scanning aid; the three-letter code is the identity and is always shown. Every
step clears 3:1 contrast so the text stays legible.
