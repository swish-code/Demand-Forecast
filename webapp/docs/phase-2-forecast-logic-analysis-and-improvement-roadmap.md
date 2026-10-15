<!-- markdownlint-disable MD013 -->
# Phase 2 — forecasting analysis and improvement roadmap

A deep look at how the Demand Forecast application actually forecasts today,
what is wrong with it, and what should be built between **13 October and
31 December 2026**.

Sales forecasting is deliberately **out of scope**. It is produced upstream in
Power BI and is treated here only as an input.

---

## How to read this document

| Label | Meaning |
|---|---|
| **[Confirmed]** | Verified in the code. Evidence given. |
| **[Risk]** | Plausible problem that needs data to confirm. Not yet a proven defect. |
| **[Gap]** | Functionality that does not exist. |
| **[Opportunity]** | An improvement, not a fault. |

Nothing is called a defect without evidence.

---

## Contents

- [1. Executive summary](#1-executive-summary)
- [2. The current forecasting landscape](#2-the-current-forecasting-landscape)
- [3. Deep dive by forecast type](#3-deep-dive-by-forecast-type)
- [4. Comparing the methods](#4-comparing-the-methods)
- [5. Confirmed issues, risks and gaps](#5-confirmed-issues-risks-and-gaps)
- [6. The target method for each forecast](#6-the-target-method-for-each-forecast)
- [7. Cross-department mapping requirements](#7-cross-department-mapping-requirements)
- [8. Validation and performance](#8-validation-and-performance)
- [9. Recommended Phase 2 scope](#9-recommended-phase-2-scope)
- [10. The implementation roadmap](#10-the-implementation-roadmap)
- [11. Acceptance criteria and testing](#11-acceptance-criteria-and-testing)
- [12. Open questions and decisions needed](#12-open-questions-and-decisions-needed)

---

## 1. Executive summary

### What is actually built

The application contains **two real forecasting engines**, not six. Everything
else is either a view of those two, a figure read from Power BI, or a stock
calculation wearing a forecast's name.

| Area | What exists today |
|---|---|
| **Warehouse** | A real forecast, calculated here. Well tested. |
| **Production / CK / CPU** | The **same engine**, pointed at kitchen history. |
| **Bakery** | The **same engine again**. No bakery-specific logic at all. |
| **Product mix** | Not calculated here — a Power BI measure, displayed. |
| **Store** | **No demand forecast exists.** Only stock metrics. |
| **Procurement** | **No purchase quantity is produced.** One formula exists and is hidden. |

### The five findings that matter most

1. **There is no store forecast.** Every store figure — Stock cover, SOH status,
   Required shipment — takes its demand signal from the **warehouse** forecast,
   which is brand-level *warehouse outbound*. The shops' own consumption is never
   forecast. **[Confirmed]**

2. **The "six-month" warehouse model is really a two-month model.** With the
   decay factor set to 0.6, the most recent month carries **60.2%** of the answer
   and the last two carry **84.3%**. The oldest three months together contribute
   **6.0%**. **[Confirmed by calculation]**

3. **The headline accuracy figure is partly self-awarded.** A rule gives 100% to
   any row where shops already hold twice the forecast. It fires on **79.5%** of
   scored rows and lifts average accuracy from 49.2% to 90.8% — and because the
   test is `2 × forecast ≤ stock`, **forecasting low makes it easier to pass**.
   **[Confirmed]**

4. **Past months cannot be scored honestly.** When a month closes, the sales
   forecast is overwritten by the actual. The model keeps no record of what was
   predicted. So every "accuracy" figure for a finished month is measured against
   a *reconstructed* forecast, not the one that was issued. **[Confirmed]**

5. **Procurement gets no number to order from.** The requirement formula exists,
   is tested, and is displayed nowhere. There is no lead time, no minimum order
   quantity, no supplier, and no order-level pack rounding. **[Confirmed]**

### What Phase 2 should do

In 58 working days, the realistic goal is **not** to build six forecasts. It is
to:

- fix the measurement, so improvements can be proven rather than argued;
- build the **one genuinely missing forecast** (store demand);
- turn the warehouse forecast into a **purchase quantity** procurement can use;
- correct the product-to-article mapping that everything downstream depends on.

Bakery-specific and CK-specific methods should be explicitly deferred. See
[section 9](#9-recommended-phase-2-scope).

---

## 2. The current forecasting landscape

### 2.1 One engine, three uses

**[Confirmed]** `server/insights/whConstant.js` holds the only demand-forecasting
engine in the application. It is used three times:

| Use | History it learns from | Where |
|---|---|---|
| Warehouse forecast | what the central warehouse issued | Stock Article, Procurement |
| Site forecast | what the kitchens issued | Production, CK/CPU, Bakery, YELO Factory |
| Plan-year sizing | the same, with an equal-weight average | Sales Plan |

`constantsFor()` takes a `source` parameter; `quantityFor()` is shared unchanged.
The Bakery page is the same code with a different production source pinned.

**[Gap]** So "Bakery forecasting" and "CK/CPU forecasting" are not separate
methodologies. They are filters on one method.

### 2.2 What the engine is actually doing

In business language:

> **Work out how many units the warehouse ships for every dinar the brand sells.
> Then multiply that rate by the sales expected in the period you are planning.**

That single sentence explains almost every behaviour and almost every weakness
described in this document.

### 2.3 What is not a forecast, despite appearances

**[Confirmed]** These look like forecasts and are not:

- **Store cover / SOH status / Required shipment** — stock arithmetic driven by
  the warehouse forecast.
- **Store DTL** — a ratio of stock to *receipts*.
- **Tomorrow's prep** — three Power BI measures read and displayed.
- **Product mix / Forecast qty** — a Power BI measure, copied.

---

## 3. Deep dive by forecast type

### 3.1 Warehouse forecast

**What is forecast:** units of one article that the central warehouse will issue
to a brand's shops, over a chosen date range.

**Business problem:** what to buy and hold centrally.

**Inputs:** warehouse outbound history per article per month; brand sales per
month; the forward menu; standard pack sizes.

#### The calculation, in order

**Step 1 — a monthly rate.** For each of the last six whole months:

```
rate = units the warehouse shipped that month / the brand's actual sales that month
```

**Step 2 — drop the months before the article existed.** Zeros before the first
delivery are removed; zeros after it are kept. A zero between deliveries is a
real ordering cycle; a zero before the first one is "we did not stock this yet".

**Step 3 — decay towards the present.** Quantities and sales are averaged
separately with weights `0.4 ^ (months ago)`, then divided.

**Step 4 — classify.** New (≤2 months), rare (shipped in ≤2 of 6), regular
(shipped in all 6), intermittent (everything else).

**Step 5 — apply.**

```
regular / intermittent  : level x (window sales / salesBase)
new                     : level x (window days / 30.44)
rare                    : median of all months x (window days / 30.44)
```

**Step 6 — round up to whole packs** for display. Accuracy is scored on the
unrounded figure.

#### Worked example (illustrative numbers)

An article shipped over six months, against brand sales:

| Month | Shipped | Brand sales | Rate |
|---|---:|---:|---:|
| m-6 | 1,000 | 500,000 | 0.0020 |
| m-5 | 1,200 | 520,000 | 0.0023 |
| m-4 | 900 | 480,000 | 0.0019 |
| m-3 | 1,500 | 600,000 | 0.0025 |
| m-2 | 2,000 | 620,000 | 0.0032 |
| m-1 | 2,400 | 640,000 | 0.0038 |

Decayed level = **2,189 units**. Decayed salesBase = **626,000**.
If next month's expected sales are **700,000**:

```
forecast = 2,189 x (700,000 / 626,000) = 2,448 units
```

Note what happened: the answer is almost entirely driven by months m-1 and m-2.
A flat six-month average would have given about 1,500.

#### Analysis — is this appropriate?

**Good:** the method is well reasoned, backtested, and documented. The behaviour
classes are justified by measured data, not invented. The leakage guard (a month
may never train on itself) is enforced by a thrown error, which is stronger than
most systems manage.

**[Confirmed] Weakness 1 — the effective memory is two months, not six.**

| Month | Share of the forecast |
|---|---:|
| m-1 | **60.2%** |
| m-2 | 24.1% |
| m-3 | 9.6% |
| m-4 | 3.9% |
| m-5 | 1.5% |
| m-6 | 0.6% |

The name "six-month rate" materially overstates how much history is used.
*Business meaning:* the forecast reacts fast to a change, and is **blind to
anything annual**. Ramadan, summer, school terms and festive peaks cannot be
seen through a two-month window. Last December's demand carries 0.6% weight when
forecasting this December.

**[Confirmed] Weakness 2 — no seasonality anywhere in the warehouse path.**
Seasonal factors *exist* in the models (`'Seasonal Effect Branch'`, with 2027
values for all nine brands) but are used **only** by the Sales Plan. The
warehouse forecast never reads them.

**[Confirmed] Weakness 3 — it is blank under a branch, product or PLU filter.**
Both halves of the ratio are brand-level, so the column empties with no message
on screen. Users read this as a broken page.

**[Risk] Weakness 4 — a sales-driven rate for articles that are not sales-driven.**
Cleaning chemicals, uniforms, packaging for a promotion and equipment spares do
not scale with revenue. The behaviour classes catch the *irregular* ones, but a
regular non-sales-driven article is still scaled by sales. Worth measuring.

**[Risk] Weakness 5 — one brand-level sales figure for every article.** A brand
whose mix shifts (more delivery, fewer dine-in) changes what it consumes without
changing revenue. The model cannot see that.

### 3.2 Product mix forecast

**What is forecast:** how much of each article the recipes imply, given the
product forecast.

**[Confirmed]** Not calculated here. It is the Power BI measure
`[Component_Forecast_Qty]`, copied into the local tables.

```
article requirement = SUM over every recipe naming it of
                      (product forecast quantity) x (recipe quantity per unit)
```

#### Analysis

**[Confirmed] It systematically under-forecasts prepared articles.** Measured
over four target months against the site method, on identical rows:

| Method | Per article | By volume | Bias | Error per article |
|---|---:|---:|---:|---:|
| Recipe explosion | 64.8% | 70.7% | **-24%** | 1,548 |
| Site forecast | 85.3% | 89.8% | -1% | 574 |

A **-20% to -27% bias in every month tested** is a standing shortfall, not noise.

**[Confirmed] The two methods disagree by a factor of two on the same articles.**
A recipe audit on 23 Sep 2026 found this and it was never reconciled. The
business decision taken was: **the warehouse answer wins; the recipe explosion
may only fill articles the warehouse left empty.** It may never overwrite.

**[Risk] The likely cause is mapping, not method.** The explosion is arithmetic
— products × recipe rates — so a factor-of-two error points at the *inputs*:
missing recipe lines, wrong units of measure, prep steps counted twice through
nested recipes, or PLU collisions. This is exactly what section 7 addresses, and
it is the single highest-value investigation in Phase 2.

**[Confirmed] A real data-typing hazard.** `Product PLU` is an Integer in BBT's
model and Text in the others. Where the model's own measure cannot compare the
two, the extract rebuilds the join itself. Two code paths are in live use for
what should be one calculation.

### 3.3 Store-level forecast

**[Gap] This does not exist.** This is the most important finding in the
document, and it is easy to miss because the page shows plausible-looking
columns.

**[Confirmed]** Every store figure is derived from the **warehouse** forecast:

```
monthly        = warehouse forecast for the window x 30.44 / window days
Stock cover    = store stock on hand / monthly                  (in months)
SOH status     = banded cover: <0.25m low, >2m already stocked
Required shipment = MAX(0, 1.25 x monthly - stock on hand)
```

*In plain words:* the app asks "how fast does the **warehouse ship** this
article?" and then measures **shop stock** against that. It never asks "how fast
do the **shops use** it?"

**Why this matters.** Warehouse outbound is a *supply* signal, not a demand
signal. It reflects delivery scheduling, batch sizes, minimum order quantities
and warehouse capacity as much as consumption. Measuring shop cover against it
confuses "how often we deliver" with "how fast it is used".

**[Confirmed] Store DTL measures receipts, not consumption.**

```
Store DTL = store stock on hand / (purchases + transfers in, per day)
```

The denominator is what the shop **received**, not what it **used**. A shop that
over-receives looks *better* covered, because the denominator grows. That is
backwards for a cover metric.

**[Confirmed] The derived store columns are switched off**, and for a good
reason: the inventory model stopped posting sales depletion on 1 September 2026,
so store stock rose on 58 of 60 days and read roughly double. Only the raw Store
SOH figure was left on.

**[Confirmed] Negative balances are handled correctly.** 2.0–5.9% of articles
carry negative book balances. They are treated as empty, not as a debt — without
that, the page told users to ship 66,941 units of an article needing 15,341.

**What a real store forecast needs, and what is missing:**

| Needed | Status |
|---|---|
| Store-level sales or consumption history | **[Gap]** not extracted |
| Per-store demand rate | **[Gap]** |
| Store-level seasonality / day-of-week | **[Gap]** |
| New store / new article handling | **[Gap]** |
| Stock, intake, transfers | **Exists** |
| Replenishment arithmetic | **Exists** (switched off) |

So the replenishment *arithmetic* is built and the *demand signal* underneath it
is not.

### 3.4 Procurement forecasting

**[Gap] No purchase quantity is produced for a buyer to act on.**

**[Confirmed]** One formula exists:

```
Required qty = MAX(0, warehouse forecast - warehouse closing stock - pending PO)
```

It is calculated on the server, summed correctly when rows are folded, and
**rendered by no column anywhere in the application.** It was explicitly
requested that it not be shown.

**What a purchasing decision needs that is missing:**

| Needed | Status |
|---|---|
| Demand over the **lead time**, not the screen window | **[Gap]** |
| Supplier, MOQ, order multiple | **[Gap]** |
| Rounding applied to the **order**, not the forecast | **[Gap]** |
| Safety stock in the requirement | Partial — policy read, not applied |
| Open POs netted | **Exists** |
| Stock netted | **Exists** |

**[Confirmed] The safety stock policy is read but not used in any requirement.**
`'Replan Planning'[SS]` holds **days**, not quantities — audited 16 Sep 2026:
1,055 of 2,246 rows are words (`OnDemand`, `NoNeed`) rather than numbers, and no
numeric value exceeds 15.

**[Risk] Pack rounding is applied in the wrong place for purchasing.** Packs are
rounded **up on the forecast**, before stock and pending POs are subtracted. For
an order quantity, rounding should be the **last** step — otherwise the buyer
orders a whole pack more than needed, every time, on every article.

*Worked example (illustrative):* forecast 1,010 units, pack size 100, stock 900,
pending 0.
Today: forecast rounds to 1,100 → requirement = 200 → two packs.
Correct order: 1,010 − 900 = 110 → rounded up = **one pack**.
The current order is **double** the right one.

### 3.5 Production / CK / CPU forecast

**[Confirmed]** The site forecast — same engine, kitchen issue history instead
of warehouse issue history.

**Measured performance, on its own terms, over six target months:** 69.7–74.4%
per article, 84.5–92.6% by volume, bias −1% to +8%. This is the **best-performing
forecast in the application.**

**[Confirmed] The menu rules are deliberately not applied here.** A prepared
article is menu-driven by definition, and excluding it on a missing menu signal
would blank rows the kitchens demonstrably issue.

**[Gap] It forecasts what the kitchen will *issue*, not what it must *produce*.**
A production plan also needs batch sizes, yields, shelf life and a production
calendar. None exist.

**[Gap] No daily granularity.** Kitchens plan tomorrow, not next month. The
Tomorrow's Prep page reads Power BI measures directly and shares nothing with
this engine — so two unrelated answers to "what should we make" sit in one app.

### 3.6 Bakery forecast

**[Confirmed] There is no bakery-specific forecasting.** The Swish Bakery page
is the Production page with `Bakery` pinned as the production source.

**[Gap] Bakery demand has properties this method cannot represent:** very short
shelf life, daily production, strong day-of-week patterns, and bake-off decisions
made each morning. A monthly rate scaled by sales cannot answer "how many loaves
tomorrow".

**[Risk]** Because bakery items are forecast monthly and consumed daily, the
figure is usable for *ingredient purchasing* but not for *production scheduling*.
Using it for the latter would produce waste.

---

## 4. Comparing the methods

| | Warehouse | Site (CK/Bakery) | Product mix | Store | Procurement |
|---|---|---|---|---|---|
| Calculated here? | Yes | Yes | No | **No forecast** | **No output** |
| Level | brand × article | site × article | recipe line | — | — |
| History used | 6 months, ~2 effective | same | none (forward) | none | none |
| Demand driver | brand sales | brand sales | product forecast | warehouse forecast | warehouse forecast |
| Seasonality | **none** | **none** | inherited | — | — |
| New items | own level, no sales scaling | same | recipe handles | — | — |
| Accuracy (measured) | 56.7% article / 81.3% volume | 69.7–74.4% / 84.5–92.6% | 64.8% / 70.7% | n/a | n/a |
| Bias | +9% | −1% to +8% | **−24%** | n/a | n/a |

**The pattern:** where the app forecasts from **its own movement history**, it
does well. Where it inherits a figure (product mix) or borrows another module's
signal (store), it does badly or does nothing.

**That is the strategic conclusion for Phase 2:** extend the approach that works
— forecast each level from its own observed movement — rather than deriving more
levels from the warehouse number.

---

## 5. Confirmed issues, risks and gaps

### Confirmed issues

| # | Issue | Evidence | Impact |
|---|---|---|---|
| C1 | No store demand forecast; store metrics driven by warehouse outbound | `stockColumnsFor` | Store replenishment rests on a supply signal |
| C2 | Store DTL divides by receipts, not consumption | `purchasesOver` | Over-receiving looks like good cover |
| C3 | Effective memory is 2 months, not 6 | decay weights, computed | No seasonal capability |
| C4 | Stock rule awards 100% to 79.5% of rows and rewards low forecasts | recorded measurement | Headline accuracy is not trustworthy |
| C5 | Finished months scored against a reconstructed forecast | the ratio cancels; vintage empty | Backtests measure the wrong thing |
| C6 | Recipe explosion under-forecasts PA articles 20–27% | four-month backtest | Known shortfall, unreconciled |
| C7 | Required qty calculated, never displayed | `withOpenPo` | Procurement has no output |
| C8 | Pack rounding applied before netting, not to the order | `withRoundedForecast` | Systematic over-ordering |
| C9 | WH forecast silently blank under branch/product filters | `forecastFromConstants` | Reads as a broken page |
| C10 | Supply rule documented as "6 months" but implemented with no time window | `calculations.js` vs `warehouse.js` | App documents a rule it does not follow |
| C11 | Three different accuracy formulas in use | `whAccuracy`, `mixAccuracy`, ratio | Figures are compared that should not be |
| C12 | Safety stock policy read but applied to nothing | `replanPlanning.js` | Buffer intent not realised |

### Risks needing validation

| # | Risk | How to test |
|---|---|---|
| R1 | Non-sales-driven articles scaled by sales | Correlate article outbound vs sales; flag low-correlation articles |
| R2 | Recipe factor-of-two gap is a mapping fault, not a method fault | Reconcile 20 high-volume articles by hand |
| R3 | Double counting through nested recipes (prep inside prep) | Explode a known nested recipe and compare |
| R4 | Brand mix shifts invisible to a revenue-driven rate | Compare units-per-dinar over time per brand |
| R5 | Two `Product PLU` data types cause silent row loss | Row-count both join paths per brand |

### Gaps

G1 store demand forecast · G2 lead-time-aware purchasing · G3 supplier/MOQ data ·
G4 production batch/yield/shelf life · G5 daily granularity for bakery and prep ·
G6 wastage · G7 forecast vintage capture · G8 store-level history extraction

---

## 6. The target method for each forecast

### 6.1 Warehouse — **modify, do not replace**

The method is sound and evidenced. Three changes, in order of value:

1. **Add a seasonal adjustment.** Multiply the decayed rate by the brand's
   seasonal factor for the target month ÷ the weighted factor of the training
   months. The factors already exist and are already extracted. This gives the
   model an annual memory without changing its short-term responsiveness.
   *Expected benefit: the first time the model can anticipate Ramadan or summer.*
2. **Flag low-correlation articles** (R1) and forecast them on their own level
   rather than on sales.
3. **Say so when the forecast is suppressed** by a branch or product filter,
   instead of showing an empty column.

**Keep:** six-month window, decay, behaviour classes, leakage guard, zero
forecasts.

### 6.2 Store — **build, from store movement**

Target method:

```
store demand rate = units consumed per store per day, from the shop's own history
store forecast    = rate x days in window x seasonal / day-of-week factor
```

Then, and **only** then, the existing replenishment arithmetic becomes
meaningful:

```
requirement = MAX(0, target cover days x daily demand - stock on hand - in transit)
```

**Separate the three ideas cleanly**, which the current page does not:

| Idea | Question | Status |
|---|---|---|
| **Demand forecast** | how fast will this be used? | **[Gap]** to build |
| **Stock position** | what is on the shelf now? | exists |
| **Replenishment** | what should we send? | arithmetic exists |

**Prerequisite:** store-level consumption history must be extracted. Until the
inventory depletion posting issue is confirmed fixed, consumption must be derived
as `opening + receipts − closing`, which is available today.

### 6.3 Product mix — **investigate before changing**

Do **not** rebuild the explosion. Reconcile it first (R2, R3). If the gap is
mapping, fix the mapping and the method is fine. If the gap survives correct
mapping, then retire the recipe explosion for PA articles and use the site
forecast, which already beats it.

### 6.4 Production / CK / CPU — **retain, extend**

The site forecast is the best performer. Extend with batch size and yield so it
answers "how much to produce" rather than "how much was issued".

### 6.5 Bakery — **defer a bespoke method**

Keep the site forecast for ingredient purchasing. A daily, day-of-week bakery
model is a genuine project and does not fit in Phase 2 alongside the rest. Say so
now rather than half-building it.

### 6.6 Procurement — **turn the existing number into an order**

```
order qty = roundUpToPack(
              MAX(0, demand over (lead time + review period)
                     + safety stock
                     - stock on hand
                     - open POs)
            )
```

Every term except lead time, safety stock and pack-at-the-end already exists.

---

## 7. Cross-department mapping requirements

**[Risk] This is where the factor-of-two disagreement most likely lives**, and it
affects every downstream number.

Four levels must agree:

```
menu item  ->  product (PLU)  ->  recipe  ->  article
```

Known hazards, all confirmed in code:

- **`'RECIPE TABLE'` has no brand column.** Recipe groups are mapped to brands
  separately. A wrong mapping silently moves quantities between brands.
- **`Product PLU` collides across brands and within one.** PLU matching is exact;
  a collision attaches the wrong recipe.
- **`Product PLU` is Integer in one model, Text in six.** Two join paths in use.
- **Prep steps have no article number** and are keyed by name, so a renamed prep
  step becomes a different thing.
- **An article can appear on several paths of one product** (a sauce in the base
  and again in a topping). Summing per `(PLU, article)` is correct; summing
  per path would double count.

**Recommended work:** a reconciliation harness that takes 20 high-volume
articles, explodes them by hand from the recipe master, and compares with the
measure. Any article differing by more than a tolerance is a mapping defect.
This is cheap, decisive, and unblocks sections 6.3 and 6.4.

---

## 8. Validation and performance

### 8.1 Fix the measurement first

**[Confirmed]** Today's accuracy numbers cannot support a methodology decision:

- The stock rule sets 79.5% of rows to 100%.
- Past months are scored against a reconstructed forecast.
- Three different formulas are in use and get compared.

**Recommended:**

1. **Capture the forecast before the month opens** (the vintage table exists and
   is empty). Nothing else gives an honest backtest. This is the single most
   valuable technical task in Phase 2.
2. **Report accuracy both ways** — with and without the stock rule. Keep the rule
   for operational reporting; exclude it when judging the model.
3. **Add a bias measure beside every accuracy measure.** Accuracy alone hides
   systematic over- or under-forecasting; bias is what moves stock.
4. **Weight by volume as well as per article**, and show both. They differ by
   ~25 points, and each answers a different question.
5. **Add an under-forecast detector** for rows that pass the stock rule, so a
   low forecast cannot earn a perfect score unnoticed.

Suggested metrics: **WAPE** for volume-weighted error, **bias %** for direction,
and the existing per-article score for comparability with what people already
read.

### 8.2 Performance

**[Confirmed] The current architecture is sound and should not be expanded
carelessly.** Measured: adding one year of product rows to `Forecast_Product_Table`
would add **21.6 million rows, +86%**, across the brand models.

**Principles for Phase 2:**

- **Compute in the app, not in the model**, where the inputs already exist
  locally. Method C already proves this works.
- **Pre-aggregate to month** for anything planning-related. Daily grain is needed
  only for store and bakery.
- **Keep query splitting.** Power BI returns a 200 with roughly half the rows
  when a query is too large — a silent failure the extract already guards against.
- **Store-level history is the one genuinely large new dataset.** Extract it
  pre-aggregated per store per article per week, not per day per line.

---

## 9. Recommended Phase 2 scope

### What fits in 58 working days

**It is not possible to deliver genuine forecasting for all six areas by
31 December.** Store forecasting alone is a full workstream, and it depends on
data that is not yet extracted.

**Recommended: four workstreams in, two deferred.**

| In scope | Why |
|---|---|
| Measurement and validation | Nothing else can be proven without it |
| Store demand forecast | The only entirely missing forecast |
| Procurement order quantity | Highest business value per day of work |
| Mapping reconciliation | Unblocks product mix and production |

| Deferred, with reasons |
|---|
| **Bakery daily model** — needs daily data and a different method; a project of its own |
| **Production batch/yield/shelf life** — needs master data that does not exist |
| **Warehouse seasonality** — valuable, but should follow honest measurement, not precede it |

**Trade-off stated plainly:** if the business insists on bakery and production
methods inside Phase 2, then store forecasting must move out. They cannot both
be done properly in the time available.

---

## 10. The implementation roadmap

**Calendar:** 13 Oct – 31 Dec 2026, Sunday to Thursday. **58 working days, 12
working weeks.** Week 1 is short (3 days).

### Workstream 1 — Critical defects and data integrity

| | |
|---|---|
| **W1.1 Correct pack rounding for order quantities** | |
| Issue | Packs rounded on the forecast, before netting — systematic over-ordering (C8) |
| Action | Round at the order step; keep forecast rounding for display |
| Benefit | Stops buying a whole extra pack per article per cycle |
| Depends on | none |
| Priority | **Critical** |
| Dates | 13–15 Oct (3 d) |
| Acceptance | Worked example reproduces 1 pack, not 2; no change to displayed forecast or accuracy |

| | |
|---|---|
| **W1.2 Reconcile the Supply rule with its documentation** | |
| Issue | Catalogue says 6-month lookback; code applies none (C10) |
| Action | Business decides which is correct; align both |
| Benefit | Removes a contradiction users can see |
| Depends on | business decision |
| Priority | **High** |
| Dates | 18–19 Oct (2 d) |
| Acceptance | Code and catalogue state the same rule |

| | |
|---|---|
| **W1.3 Explain a suppressed forecast** | |
| Issue | Branch/product filters blank the column silently (C9) |
| Action | Show an inline note stating why and what to clear |
| Benefit | Removes the most common "the page is broken" report |
| Depends on | none |
| Priority | **High** |
| Dates | 20–22 Oct (3 d) |
| Acceptance | Selecting a branch shows the note, not an empty column |

### Workstream 2 — Honest measurement

| | |
|---|---|
| **W2.1 Capture forecast vintages** | |
| Issue | Past months scored against a reconstructed forecast (C5) |
| Action | Snapshot each month's forecast before the month opens; store per brand/article/month |
| Benefit | The first genuinely honest backtest the project can run |
| Depends on | none |
| Priority | **Critical** |
| Dates | 25 Oct – 5 Nov (10 d) |
| Acceptance | November's forecast is captured on 31 Oct and readable in December |

| | |
|---|---|
| **W2.2 Dual accuracy reporting and bias** | |
| Issue | Stock rule inflates accuracy; no bias shown (C4, C11) |
| Action | Report with and without the stock rule; add bias and WAPE; flag under-forecast passes |
| Benefit | Methodology changes can be judged on evidence |
| Depends on | W2.1 for historical comparison |
| Priority | **Critical** |
| Dates | 8–19 Nov (10 d) |
| Acceptance | One screen shows accuracy, bias, volume-weighted error, with and without the rule |

### Workstream 3 — Mapping reconciliation

| | |
|---|---|
| **W3.1 Reconciliation harness for 20 articles** | |
| Issue | Recipe and warehouse methods differ by ~2× (C6, R2, R3) |
| Action | Hand-explode 20 high-volume articles; compare with the measure; classify every difference |
| Benefit | Settles whether the gap is mapping or method |
| Depends on | none |
| Priority | **Critical** |
| Dates | 25 Oct – 5 Nov (10 d, parallel with W2.1) |
| Acceptance | Every one of the 20 is either reconciled or has a named defect |

| | |
|---|---|
| **W3.2 Fix the mapping defects found** | |
| Issue | Whatever W3.1 finds |
| Action | Correct recipe-to-brand mapping, PLU types, nested prep handling |
| Benefit | Every downstream forecast becomes trustworthy |
| Depends on | W3.1 |
| Priority | **Critical** |
| Dates | 8–26 Nov (15 d) |
| Acceptance | The 20 articles reconcile within tolerance; no brand's totals move unexpectedly |

### Workstream 4 — Store demand forecast

| | |
|---|---|
| **W4.1 Extract store consumption history** | |
| Issue | No store demand data exists (G8) |
| Action | Derive consumption as opening + receipts − closing, per store per article per week |
| Benefit | The missing input for every store calculation |
| Depends on | confirmation of the depletion-posting issue |
| Priority | **Critical** |
| Dates | 8–19 Nov (10 d) |
| Acceptance | Weekly consumption reconciles to stock movement within tolerance |

| | |
|---|---|
| **W4.2 Store demand forecast** | |
| Issue | Store metrics use a warehouse supply signal (C1, C2) |
| Action | Per store per article demand rate; reuse the behaviour classes; keep the engine |
| Benefit | Replenishment based on usage, not on delivery frequency |
| Depends on | W4.1 |
| Priority | **Critical** |
| Dates | 22 Nov – 10 Dec (14 d) |
| Acceptance | Backtested against four months; beats the current warehouse-derived signal on bias |

| | |
|---|---|
| **W4.3 Rebase cover, status and DTL on real demand** | |
| Issue | DTL divides by receipts (C2) |
| Action | Replace the demand denominator; re-enable the derived columns if data allows |
| Benefit | Cover means time to run out, not time since delivery |
| Depends on | W4.2 |
| Priority | **High** |
| Dates | 13–17 Dec (5 d) |
| Acceptance | A shop that over-receives no longer reads as better covered |

### Workstream 5 — Procurement output

| | |
|---|---|
| **W5.1 Lead-time-aware order quantity** | |
| Issue | No purchasable number exists (C7, G2) |
| Action | Demand over lead time + review period, plus safety stock, net of stock and open POs, rounded last |
| Benefit | Procurement gets a number to act on |
| Depends on | W1.1, lead-time master data |
| Priority | **High** |
| Dates | 22 Nov – 3 Dec (9 d, parallel with W4.2) |
| Acceptance | Reproduces the worked example; no double counting of open POs |

| | |
|---|---|
| **W5.2 Apply the safety stock policy** | |
| Issue | Policy read as days, applied to nothing (C12) |
| Action | Convert days to quantity using the new demand rate; handle OnDemand / NoNeed explicitly |
| Benefit | The buffer the business already defined starts working |
| Depends on | W5.1, W4.2 |
| Priority | **Medium** |
| Dates | 6–10 Dec (5 d) |
| Acceptance | Each of the eight policy values produces a defensible quantity |

### Workstream 6 — Validation and close

| | |
|---|---|
| **W6.1 Backtest every change** | |
| Action | Re-run the four-month backtest on warehouse, site and store forecasts, with and without the stock rule |
| Benefit | Evidence that Phase 2 improved things |
| Depends on | W2.2, W3.2, W4.2 |
| Priority | **Critical** |
| Dates | 13–24 Dec (9 d) |
| Acceptance | Written comparison, before and after, per method |

| | |
|---|---|
| **W6.2 Performance check and handover** | |
| Action | Measure load times with store data in place; confirm no Power BI model growth; update documentation |
| Priority | **High** |
| Dates | 27–31 Dec (5 d) |
| Acceptance | No page slower than today; model row counts unchanged |

### Schedule at a glance

| Weeks | Dates | Main work |
|---|---|---|
| 1 | 13–15 Oct | W1.1 pack rounding |
| 2–3 | 18–29 Oct | W1.2, W1.3, start W2.1 + W3.1 |
| 4–5 | 1–12 Nov | W2.1, W3.1 finish; W2.2, W3.2, W4.1 begin |
| 6–7 | 15–26 Nov | W3.2, W4.2, W5.1 |
| 8–9 | 29 Nov – 10 Dec | W4.2 finish, W5.1, W5.2 |
| 10–11 | 13–24 Dec | W4.3, W6.1 backtesting |
| 12 | 27–31 Dec | W6.2 performance, handover |

**Slack:** roughly 6 of 58 days. That is thin. If anything slips, **W5.2 (safety
stock) is the first thing to drop**, then W4.3.

---

## 11. Acceptance criteria and testing

### Rules that must not change

Any Phase 2 change must leave these intact, and each should have a test:

1. A month may never train on itself — the leakage guard still throws.
2. Historical figures for closed months do not move.
3. A forecast of zero stays on the page and is scored.
4. Consumables (gloves, napkins, bags) are never blanked by the menu rule.
5. Warehouse figures stay on one row per article; folding re-derives scores.
6. Negative book balances count as zero, never as a debt.
7. Stock quantities stay withheld from accounts without stock detail.
8. The warehouse answer still wins where both methods have one.

### Per-workstream tests

| Workstream | Test |
|---|---|
| W1.1 | Unit test: forecast 1,010, pack 100, stock 900 → one pack |
| W2.1 | A captured vintage is readable a month later and differs from the actual |
| W2.2 | Accuracy with and without the stock rule differ by roughly the recorded 41 points |
| W3.1 | 20 articles each reconciled or defect-named |
| W4.1 | Weekly consumption reconciles to opening + receipts − closing |
| W4.2 | Four-month backtest; bias closer to zero than the warehouse-derived signal |
| W5.1 | Open POs netted exactly once; order rounded after netting |
| W6.1 | Before/after comparison published per method |

### Regression

The existing suite must stay green. Every number on Stock Article for a **closed
month** must be unchanged, which is the sharpest single regression test
available.

---

## 12. Open questions and decisions needed

**Decisions the business must make before the dependent work starts:**

1. **Keep the stock rule?** It awards 100% to four rows in five and rewards low
   forecasts. Needed before W2.2.
2. **Is the store depletion posting fixed?** W4.1 depends on it.
3. **Supply = "ever" or "last 6 months"?** W1.2 is blocked on this.
4. **Should Required Qty be visible?** W5.1 produces a number nobody has agreed
   to show.
5. **Bakery and production deferred — accepted?** If not, store forecasting moves
   out of Phase 2.

**Data that must be supplied:**

6. **Lead times per article or supplier.** Without them W5.1 cannot be correct.
7. **Minimum order quantities and order multiples.**
8. **Confirmation of what `OnDemand` and `NoNeed` should mean numerically.**

**Still unknown from the code:**

9. **How the upstream sales and product forecasts are produced.** The warehouse
   forecast is multiplied by the sales forecast, so any bias there passes
   straight through, and nothing on this side can see it.
10. **Whether wastage is recorded anywhere.** No wastage input was found. If it
    exists, it belongs in the store demand calculation.

---

## Closing note

The application forecasts well where it learns from its own movement history, and
badly where it borrows another module's number. Phase 2's best use of 58 days is
to **fix the measurement, build the one missing forecast, and make the warehouse
number purchasable** — not to add more forecasts derived from the same source.
