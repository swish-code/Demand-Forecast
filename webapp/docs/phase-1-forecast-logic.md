<!-- markdownlint-disable MD013 -->
# Phase 1 — how the forecasting works

A plain-language description of **all** the forecasting that is live today in
the Demand Forecast application, written for Phase 2 (DF2-1).

It covers every forecast the application shows — where each one comes from, how
it is worked out, what the business rules are, and what the known weak spots
are. The **warehouse forecast** on the Stock Article page gets the most space,
because it is the one the application itself calculates and the one people order
from.

**This document describes the system as it is. Nothing was changed to write it.**

---

## How to read this document

Every statement carries one of four labels:

| Label | Meaning |
|---|---|
| **[Verified]** | Read directly in the code. The file and function are named. |
| **[Rule]** | A business rule deliberately built into the app, usually with the reason recorded beside it. |
| **[Check]** | Could not be confirmed from the code alone. Someone needs to confirm it. |
| **[Risk]** | A limitation, edge case or inconsistency worth knowing about. |

Nothing here is invented. Where the code did not answer a question, it says so.

---

## Contents

- [The short version](#the-short-version)
- [1. Where the data comes from](#1-where-the-data-comes-from)
- [2. The five forecasts, and which is which](#2-the-five-forecasts-and-which-is-which)
- [3. The warehouse forecast, step by step](#3-the-warehouse-forecast-step-by-step)
- [4. Which articles get a warehouse forecast](#4-which-articles-get-a-warehouse-forecast)
- [5. The product mix forecast](#5-the-product-mix-forecast)
- [6. The site (production) forecast](#6-the-site-production-forecast)
- [7. The plan-year forecast](#7-the-plan-year-forecast)
- [8. Article-level calculation and grouping](#8-article-level-calculation-and-grouping)
- [9. Stock figures](#9-stock-figures)
- [10. Required quantity and replenishment](#10-required-quantity-and-replenishment)
- [11. Dates, windows and filters](#11-dates-windows-and-filters)
- [12. Accuracy](#12-accuracy)
- [13. Business rules and exceptions](#13-business-rules-and-exceptions)
- [14. Which file does what](#14-which-file-does-what)
- [15. Limitations and risks](#15-limitations-and-risks)
- [16. Open questions for Phase 2](#16-open-questions-for-phase-2)

---

## The short version

**The application does not have one forecast. It has five**, and most confusion
about the numbers comes from treating them as one.

| # | Forecast | Answers | Worked out by |
|---|---|---|---|
| 1 | **Sales forecast** | How much money will this brand take? | Power BI (upstream) |
| 2 | **Product forecast** | How many of each menu item will we sell? | Power BI (upstream) |
| 3 | **Product mix forecast** | What do the recipes say we need for those sales? | Power BI measure |
| 4 | **Warehouse forecast** | What will the warehouse actually ship? | **This application** |
| 5 | **Site forecast** | What will the kitchens actually issue? | **This application** |

Forecasts 1–3 are produced upstream; the app reads and displays them. Forecasts
4 and 5 are calculated here, in JavaScript, from shipping history.

**A sixth exists for planned years** (2027 onwards), where there is no product
data to explode: the *plan-year forecast*, covered in section 7.

The central relationship:

> **Warehouse forecast = how much the warehouse ships per dinar of sales,
> measured over the last six whole months and weighted towards recent months,
> multiplied by the sales expected in the period you selected.**

On the **Stock Article** page, forecasts 3 and 4 sit side by side — "Forecast
qty" and "WH forecast" — and the *Variance* columns exist precisely because they
disagree.

---

## 1. Where the data comes from

### 1.1 The original source systems

**[Verified]** Everything begins in Power BI. The app never keeps its own master
data — it reads the same semantic models the Power BI reports read, through the
`executeQueries` REST API.

| Source model | Table | What it supplies |
|---|---|---|
| Each brand's forecast model (nine brands) | `'FORECAST (2)'` | Daily brand sales — `[Totalsale]` and `[Actual Sales]` |
| Each brand's forecast model | `Forecast_Product_Table` | Product/PLU level forecast and actual quantities |
| Each brand's forecast model | `'RECIPE TABLE'` | Which articles each product needs, and how much |
| **Warehouse Analytics** | `fact_outbound_line` | What the warehouse actually issued |
| **Inventory Control** | `cc_daily_inventory` | Daily closing stock, in shops and in the warehouse |
| **Inventory Control** | `'CC Item Location'` | Pending purchase orders |
| **SWISH RUNRATE** | `'FORECAST'` | One all-brand source of actual sales |
| Each brand's forecast model | `'Seasonal Effect Branch'` | Twelve monthly seasonal factors per brand |

**[Verified]** Each brand is a **separate semantic model**. Choosing a brand
selects a different model; it does not filter a column. Two models hold two
brands each (SLC‑BUR and ERMG), and the chain is pinned automatically so the
pairs never show each other's figures.

### 1.2 The local copy

**[Verified]** Pulling everything live from Power BI was too slow, so the app
keeps a local copy in an in-process PostgreSQL database (PGlite). Built by
`server/cube/extract.js`, refreshed hourly with a full rebuild at 02:00.

The tables that matter for forecasting:

| Table | Holds | Filled from |
|---|---|---|
| `cube_sales_daily` | one row per brand per day: `value`, `actual`, `actual_fc` | `'FORECAST (2)'` and SWISH RUNRATE |
| `cube_outbound_daily` | brand, date, article, quantity issued | `fact_outbound_line` |
| `cube_outbound_monthly` | the same, rolled up per month | derived from the daily table |
| `cube_component_daily` / `_monthly` | the recipe explosion, per article | Power BI's component measures |
| `cube_article_daily` / `_monthly` | product/PLU level forecast and actual | `Forecast_Product_Table` |
| `cube_coverage` | which dates each brand's copy actually holds | written by the extract |

**Important distinction [Verified]:** `cube_sales_daily` has two sales columns
and they are **not** the same thing.

- **`value`** is `'FORECAST (2)'[Totalsale]` — this is *actual* for a day that
  has already happened and *forecast* for a day that has not. This is the
  column the forecast multiplies by.
- **`actual`** / **`actual_fc`** is `[Actual Sales]` — only what really sold.
  This is what the forecast is *trained* on.

Mixing these up is the single easiest way to produce a wrong number.

---

## 2. The five forecasts, and which is which

### 2.1 Sales forecast — upstream

**[Verified]** `'FORECAST (2)'[Totalsale]` in each brand's model, copied into
`cube_sales_daily.value`.

**[Rule]** One column holding two things: **actual** for a day that has already
happened, **forecast** for a day that has not. That is exactly what the warehouse
model needs on each side of today, and it is why a separate `actual` column is
carried beside it for anything that must show only what really sold.

> Measured 20 Sep 2026: between a fifth and a third of each brand's "2026 sales"
> had not happened yet — BBT's 5,971,402 was 4,276,285 traded and 1,695,117 still
> forecast.

**[Check]** How Power BI produces this forecast is **outside this application**.
Nothing in the codebase describes the statistical method behind `[Totalsale]`.
Phase 2 should get that from the model owner.

### 2.2 Product forecast — upstream

**[Verified]** `Forecast_Product_Table`, per day, per branch, per PLU, with
measures `[Total_Forecast_Qty]` and `[Total_Actual_Qty]`. Copied into
`cube_article_daily` (no branch) and `cube_daily` (with branch).

**[Check]** Also produced upstream; the method is not described in this codebase.

### 2.3 Product mix forecast — Power BI measure, shown here

**[Verified]** `[Component_Forecast_Qty]`. See section 5.

### 2.4 Warehouse forecast — calculated here

**[Verified]** `server/insights/whConstant.js`. See section 3. This is the
figure people order from.

### 2.5 Site forecast — calculated here

**[Verified]** `server/insights/siteForecast.js`. See section 6.

### 2.6 Tomorrow's prep — upstream measures

**[Verified]** The Production Plan page reads three model measures directly:
`[Tomorrow Forecast Qty]`, `[Last 2 Weekdays Avg Actual]` and
`[Product Prep Status]` (`powerbi/dax.js`, `productionPlanQuery`). It filters to
`[Tomorrow_Forecast_Qty] > 0`.

**[Verified]** The app does no arithmetic of its own here — it displays the
model's answer.

---

## 3. The warehouse forecast, step by step

**[Verified]** All of this lives in `server/insights/whConstant.js`.

### Step 1 — measure the shipping rate, month by month

For each of the **last six whole months**, for each article:

```
rate for that month  =  units the warehouse shipped that month
                        ÷ the brand's actual sales that month (in money)
```

**[Rule]** Three deliberate choices here:

- **Six months**, not one. One month is a single delivery pattern. An article
  ordered in bulk every eight weeks looks enormous in the month it arrives and
  absent in the month it does not.
- **Whole months only.** The current month is incomplete, so its rate would be a
  part-month numerator over a part-month denominator.
- **Sales in money, not items.** One brand has a sales value but no item count,
  and a company total that adds a dinar to an item is not a total of anything.

**[Verified]** Months where the brand had no sales at all are dropped
(`usable` in `constantsFor`). Dividing by zero sales would produce infinity and
ruin the average of the other months.

**[Verified]** If *no* training month has sales, the whole brand returns an
empty result — every WH forecast on the page is blank — and a warning is logged
telling the operator to refill sales values from the Admin page.

### Step 2 — ignore the months before the article existed

**[Rule]** The averaging starts at the article's **first delivery**, not six
months ago.

A zero *before* an article first shipped means "the warehouse was not stocking
it yet". A zero *between* two deliveries means "this is a two-monthly ordering
cycle". These are completely different and must not be averaged the same way.

**[Verified]** Leading zeros are dropped; trailing zeros are kept — an article
that stopped arriving really is winding down and the average should say so.

> **Recorded example:** Ketchup US first shipped in June, so March, April and May
> were three zeros. Including them gave a rate of 0.128 against a real June–August
> rate of 0.256 — exactly half the true requirement.

### Step 3 — average the months, weighted towards now

Two different weighted averages are calculated and kept side by side.

**a) The decayed level** — this is what the live forecast actually uses.

```
weight for each month  =  (1 − ALPHA) ^ (number of months since that month)
ALPHA = 0.6                       (set by WH_FORECAST_ALPHA)

level      = weighted average of the monthly SHIPPED QUANTITIES
salesBase  = weighted average of the monthly SALES
```

**[Rule]** Quantities and sales are decayed *separately and then divided*,
rather than averaging the six monthly ratios. Averaging ratios lets one odd
month count twice — once through an unusual quantity and again through an
unusually small denominator.

> **Recorded example:** January 2026's sales copy was still filling, so the month
> reads 1.0m against a normal 3.2m. Article 100400137 came out forecast at
> 158,333 against a real 1,500, because its January *ratio* was a thousand times
> normal and survived the averaging.

**b) The weighted mean of ratios** (`constant`), weighted 1, 2, 3 … oldest to
newest, so the most recent month counts as much as the first three together.
**[Verified]** This is kept for comparison and used by the legacy model.

**c) The flat mean of ratios** (`constantFlat`), every month counted equally.
**[Verified]** Used **only** by the Sales Plan, never by the warehouse pages.

> **Recorded backtest** (train on five months, predict the sixth, three times):
> flat → weighted gave 69.2%→73.1%, 71.2%→74.3%, 73.2%→75.3% accuracy, and
> over-forecasting fell from +45%→+26%, +29%→+18%, +16%→+6%.

### Step 4 — decide what kind of demand the article is

**[Rule]** Not every article behaves like a rate. Each is put in one of four
classes, and the class decides the method (`behaviourOf`):

| Class | Test | How it is forecast |
|---|---|---|
| **new** | 2 months of history or fewer | its own level × (days ÷ 30.44) — **not** scaled by sales |
| **rare** | shipped in 2 months or fewer of the six | median of **all** months including zeros × (days ÷ 30.44) |
| **regular** | shipped in **every** one of its six months | level × (window sales ÷ salesBase) |
| **intermittent** | anything else | level × (window sales ÷ salesBase) |

The order matters: **new** is tested first, then **rare**, then **regular**.

**[Rule]** Why *new* is not scaled by sales: the ratio would rest on one or two
observations, so any difference between those months and this one becomes a
multiplier. Recorded measurement — scaling new articles by sales gave +32% bias
and 6,480 error per article; taking the level as it stands gave 0% bias and 4,381.

**[Rule]** Why *rare* counts the zeros: with two shipping months a median is just
the mean of them, so one bulk order and one small one average to a figure that
never happened.

> **Recorded example:** article 106800040 shipped 2,510,000 in January and 2,500
> in April. The median of those two is 1,256,250, and the page asked for 1.24
> million units a month of a sticker that had stopped moving. It was the single
> largest error on the page. Counting the zeros took bias from +56% to −5%.

**[Rule]** The classes are not reporting labels. Recorded accuracy by class over
June–August:

| Class | Articles | Accuracy | Bias | Share of volume |
|---|---:|---:|---:|---:|
| regular | 371 | 68.8% | +18% | 29.5% |
| intermittent | 728 | 58.2% | +26% | 59.9% |
| new | 164 | 32.7% | +7% | 10.1% |
| rare | 75 | 33.5% | +1,097% | 0.3% |
| stopped | 88 | 9.1% | +2,407% | 0.2% |

### Step 5 — apply it to the selected period

**[Verified]** `quantityFor(held, sales, windowDays)`:

```
rare                    →  medianAll × (windowDays ÷ 30.44)
new                     →  level     × (windowDays ÷ 30.44)
no usable sales history →  level     × (windowDays ÷ 30.44)
everything else         →  level     × (window sales ÷ salesBase)
```

`30.44` is the average days in a month (`DAYS_PER_MONTH`).

**[Rule]** A forecast of **zero stays on the page**. It is the model's real
answer for a rare article in a quiet month, and it is held to it — when the
article does ship, that zero scores 0% and counts. Only a value that is not a
number at all is dropped.

### Step 6 — round up to whole packs

**[Verified]** `withRoundedForecast` in `server/routes/api.js`, using
`insights/stdPkg.js`. Where an article has a standard package size, the WH
forecast shown is **rounded up** to whole packs.

**[Rule]** Up, not to nearest — a part pack cannot be ordered, and ordering less
than the forecast is the one direction that causes a stockout.

**[Rule]** **Accuracy is scored on the unrounded figure.** Scoring against a
number deliberately lifted to a pack boundary would grade the packaging rather
than the forecast.

---

## 4. Which articles get a warehouse forecast

**[Rule]** Two different inclusion tests, because two different kinds of article
sit in the table (`forecastFromConstants`):

**Articles named in a recipe** are forecast only while a menu item still wants
them. If nothing on the forward menu reaches the article, it is dropped.

**With one deliberate exception.** Gloves, napkins, paper bags and face masks are
all in the recipe master, and no menu forecast will ever reach them — nothing on
a menu is measured in gloves. So the menu rule only applies where a menu
genuinely drives the article.

> Without that exception it blanked **1.75 million units** of consumables that
> ship every week.

**Articles not in any recipe** have no menu to ask, so the test becomes "is it
still moving at all?"

**[Verified]** That "still moving" test is controlled by `ACTIVE_MONTHS`, which
**defaults to 0 — meaning the test is switched off.** With it off, `stillMoving()`
always returns true and no article is excluded for inactivity.

**[Check]** Whether the activity test should be switched back on is a business
decision. The code records that it was deliberately disabled, but not whether
that is permanent.

**[Rule]** If the menu query *fails*, the article is left alone rather than
dropped. A failed query must not read as a menu that has emptied.

---

## 5. The product mix forecast

**[Verified]** This is the "Forecast qty" column. It is **not** calculated by
this application — it is the Power BI measure `[Component_Forecast_Qty]`, read
and copied into `cube_component_daily` / `cube_component_monthly` by
`server/cube/extract.js` (`fetchComponentsViaMeasure`).

### 5.1 What it does

In plain words: **take the products we expect to sell, look up every recipe that
uses an article, and add up how much of that article those products need.**

```
Component forecast for an article
    = SUM over every recipe naming it of
        (forecast quantity of the product) x (recipe quantity per unit)
```

**[Verified]** The measure joins the product side to the recipe side on
`Product PLU` to `Clean_ItemID`, grouped by `'RECIPE TABLE'[Recipe Group]`,
`[Item]`, `[Item No.]`, `[BU]` and `[Node Type]`.

**[Risk]** `Product PLU` is an **Integer** in BBT's model and **Text** in the
others. Where the model's own measure cannot compare the two, the extract falls
back to rebuilding the join itself (`componentLevelFallbackQuery`) and logs a
warning. Both paths are in use.

### 5.2 Why it is linear, and why that matters

**[Verified]** The result is **linear in product quantity** — double the products
and you double every component. This is stated explicitly in `componentLevel`
and is what makes the plan-year method in section 7 valid: multiplying each
component row by one factor gives exactly what re-exploding the sized products
through the recipe tree would give. The tree is untouched.

### 5.3 Recipe groups are scoped per brand

**[Rule]** `'RECIPE TABLE'` is a **company-wide master with no brand column**,
and `Product PLU` collides both across brands and within one. So recipe groups
are mapped to brands by `server/insights/recipeBrands.js`.

> Without that scoping, choosing Tabel offered Mishmash's components, and picking
> one returned nothing.

### 5.4 How it compares with the warehouse forecast

**[Verified]** They disagree, and by a measured amount. On prepared (PA)
articles over four target months, scored on identical rows:

| Method | Per article | By volume | Bias | Error per article |
|---|---:|---:|---:|---:|
| Recipe mix | 64.8% | 70.7% | -24% | 1,548 |
| Site forecast | **85.3%** | **89.8%** | **-1%** | **574** |

**[Risk]** The recipe explosion **under-forecast PA articles by 20-27% in every
month tested**. That is a standing shortfall, not noise.

**[Rule]** A recipe audit on 23 Sep 2026 found the recipe and warehouse methods
disagreed by a factor of two on the same articles. This is why the Sales Plan's
article explosion was changed to read warehouse history rather than the recipe
path, and why **the warehouse answer always wins where both exist** — the recipe
explosion may only *fill* what the warehouse left empty, never overwrite it.

---

## 6. The site (production) forecast

**[Verified]** `server/insights/siteForecast.js`. Used by the Production and
per-site pages, not by Stock Article.

### 6.1 What question it answers

Stock Article asks "what will the **central warehouse** ship?". The production
pages ask "what will the **production sites** have to issue?" — a prepared
article is made at the Central Kitchen, the Bakery or the Yelo Factory, so the
warehouse has no line for it and never will.

**[Verified]** The sites counted are `Central Production Unit`,
`Centeral Kitchen` (the source's own spelling), `Swish Bakery` and
`Yelo Factory`. Deliberately **not** included: `FM- CPU` (a separate company),
`ERMG CK` (a dormant entity) and `Staff Meal` (a canteen).

### 6.2 How it is calculated

**[Verified]** It is the **same engine**. `constantsFor` takes a `source`
parameter, and the arithmetic is `quantityFor` — both unchanged from the
warehouse path. Only the history differs: site issues instead of warehouse
issues.

**[Rule]** What could **not** be reused is `forecastFromConstants`, because that
carries warehouse-specific machinery — the menu-driven test that keeps gloves in
the forecast, the recipe-article exclusion, and the catch-all bucket. None apply
to a prepared article: a PA article is menu-driven by definition, and excluding
it on a missing menu signal would blank rows the kitchens demonstrably issue.

### 6.3 What it was measured at

**[Verified]** Over six target months on its own terms: 69.7-74.4% per article,
84.5-92.6% by volume, bias between -1% and +8%. Against the recipe explosion it
won every month on every measure (table in section 5.4).

---

## 7. The plan-year forecast

**[Verified]** For a year the source models hold no product data for — 2027 and
beyond. `server/insights/planForecast.js` ("Method C"), `planArticles.js`,
`cube/planShape.js`, `insights/salesPlan.js`.

### 7.1 Why a different method is needed

**[Verified]** `Forecast_Product_Table` runs 2025-11-01 to 2026-12-31. There is
**no product-level data for 2027**, so there is nothing to explode through the
recipe tree.

### 7.2 The chain

```
annual sales target            cube_sales_plan (typed by Finance)
  x seasonal shape             cube_plan_shape - twelve weights per brand
  = that month's sales
  x units-per-sales ratio      from the base year's OBSERVED actuals
  = units
  x product mix                75% history / 25% last 28 days
  = product rows per PLU
  x recipe rates               'RECIPE TABLE', per (PLU, article)
  = article / component quantities
```

### 7.3 Where the seasonality comes from

**[Rule]** The typed figure says how **big** a plan year is. The seasonal shape
says what **shape** it has. Keeping them apart is the whole design: a manual
target changes the size of the plan, never its seasonality.

**[Verified]** The shape is read from `'Seasonal Effect Branch'[Seasonal Effect]`
— twelve monthly factors per brand, normalised to shares. A brand's own plan-year
factors where it has them, otherwise the newest complete set.

**[Rule]** It is deliberately **not** the base year's own monthly sales. Doing
that inherits things that are not seasonality:

> BBT January 2026 = -1, so January 2027 = -2. CHP opened in March 2026, so its
> January is 0 against a 10.6M target. Their seasonal *factors*, by contrast, run
> 0.87 to 1.16 - perfectly healthy.

### 7.4 Every input is an observed actual

**[Rule]** Method C never reads the `forecast` column. The base year's forecast
rows are sparse in early 2026 — BBT February holds 92,958 product units against
an actual 408,475; CHP February and TBL March hold none at all — so a mix
borrowed from them was empty or wrong for six brand-months.

### 7.5 The sliding history weight

**[Rule]** How much of a product's mix comes from history rather than the last 28
days **slides with how much history the product actually has**. A product present
in every complete base-year month keeps 0.75; one present in none gets 0.25.

> It was a flat 0.75, which under-forecast anything launched mid-year. Yelo
> Nashville Seasoning Powder launched in September 2026 and consumed 27.5 kg in
> one month; it was planned at 26.55 kg for the *whole* of 2027.

### 7.6 Cross-year ranges are refused

**[Rule]** A date range may not span a planned year and a measured one. The two
halves come from different places — one typed against a shape, one measured — and
adding them would report a figure that is part plan and part actual without
saying so. `planBoundaryError` returns a 400 with an explanation.

### 7.7 Warehouse forecast in a plan year

**[Verified]** The warehouse path needs no new method for a plan year: the rate
is unchanged and `resolveBasis` clamps a future window's training anchor to the
current month, so December 2027 trains on the same six whole months as anything
else. Only its **sales input** comes from the plan rather than the model.

**[Verified]** The Sales Plan's own article route passes `flatConstant`, asking
for the **equal-weight** six-month ratio rather than the decayed one — a target
twelve months out should not inherit whichever way last month happened to move.
**Only that route passes the flag; every warehouse page is untouched.**

---

## 8. Article-level calculation and grouping

### 8.1 The key

**[Verified]** The article number — `Item No.` on the page, `Article No.` in the
warehouse model, `article` in the local tables. Everything joins on this.

### 8.2 Rows versus articles

**[Verified]** This is the most common source of confusion on the page.

The component query returns **one row per recipe line**, grouped by
`(recipe group, item, article, BU, node type)`. So an article used by three
different recipes arrives as **three rows**.

But the warehouse figures — outbound, WH forecast, stock, pending PO — are
**per article**, not per recipe. If they were repeated on all three rows, any
total would count them three times.

**[Rule]** So the server stamps them on exactly **one row per article**, chosen
in two steps (`withStoreStock`):

1. the row that already carries the article's warehouse figures; or
2. failing that, the first row seen for that article.

**[Rule]** Step 2 exists because on the Production pages a prepared article is
made at a kitchen and the warehouse has no line for it at all.

> **Recorded example:** `Marinated BBT Chicken tender` held 11,337 units across 13
> BBT shops on 31 Aug 2026 and read blank, because there was no warehouse figure
> to hang the stock on.

**[Verified]** When the browser folds rows together, quantities are **added** and
all scores are **recalculated from the folded totals** — never carried over from
whichever row happened to be first.

**[Rule]** Two exceptions that are carried rather than added: **Store DTL** (it is
in *days*, and adding two articles' cover gives a number that describes neither)
and per-article policy settings such as lead time.

---

## 9. Stock figures

**[Verified]** All in `server/insights/storeStock.js`, surfaced by
`withStoreStock` and `withOpenPo` in `server/routes/api.js`.

| Column | What it is | Source |
|---|---|---|
| **WH opening** | warehouse stock on the day before the period | `cc_daily_inventory[Closing Stock Qty]` |
| **WH closing** | warehouse stock on the period's last day | same |
| **Store SOH** | shop stock on the period's last day | same, shop locations |
| **Store DTL** | how many days of intake the shelf is worth | Store SOH ÷ average daily intake |
| **Pending PO** | units ordered but not yet arrived | `[CC Open PO Qty]` |

### 9.1 The "as at" rule

**[Rule]** The inventory feed only reaches *yesterday*. A period ending today or
later has no reading of its own.

Since stock is a **balance**, the app clamps the read date to the most recent day
the feed actually holds, and reports that date alongside the figure:

```
asAt = the earlier of (the period's last day, the feed's last day)
```

**[Verified]** It only ever clamps, never extends — a period ending inside the
feed is completely unaffected, so historical figures do not move. The date is
shown in the cell tooltip so a balance displayed against a future month is not
mistaken for a prediction of that month's stock.

**[Verified]** Measured on 11 Oct 2026, `cc_daily_inventory` ran
2026‑01‑01 → 2026‑10‑10.

**[Verified]** A period lying entirely after the feed gets the balance but **no
intake**, so Store DTL stays blank rather than being divided by days that
reported nothing.

### 9.2 Pending PO

**[Verified]** Read from the Inventory Control model's **own measures**
(`[CC Open PO Qty]`, `[CC Open PO Pending Value]`) so this column and that
dashboard cannot disagree.

**[Rule]** They must be grouped on `'CC Item Location'[Article No.]`. Grouped on
anything else they return the company-wide total on every row.

**[Verified]** Blank, not zero, when nothing is outstanding — so the column says
"nothing pending" in words rather than printing a column of zeros.

### 9.3 Columns that are currently switched off

**[Rule]** Three groups are deliberately hidden, and the server does not even put
them in the response:

| Switch | Default | Hides |
|---|---|---|
| `STORE_COLUMNS_ON` | **off** | Stock cover, SOH status |
| `REPL_COLUMNS_ON` | **off** | Required shipment, Shipment status |
| `STORE_SOH_ON` | **on** | Store SOH, Store DTL |

**[Rule]** Store inventory was switched off on 14 Sep 2026 for a data reason:
store closing stock rose on 58 of the previous 60 days and never fell, ending
28.8% above where the month started. The inventory model had stopped posting
sales depletion on 1 September, so the figures read roughly double.

**Store SOH alone was turned back on** on 15 Sep — a number someone can see and
judge is worth showing, where a *ratio* built on it is not.

**[Risk]** The underlying posting gap is an upstream problem. This document
cannot confirm whether it has since been fixed.

### 9.4 Who can see stock

**[Verified]** Gated on `seesStockDetail(user)` — administrators, **Warehouse,
Procurement, Supply Chain and Management**.

**[Rule]** For everyone else the quantities are **withheld from the response
entirely**, not hidden in the browser. But the *stock rule* is still evaluated on
the server and its yes/no answer is sent to everybody, so the same page reports
the same accuracy to every reader.

> Before that change, the same page showed "Outbound vs forecast" as 113.6% to
> one reader and 85.7% to another, from identical rows.

---

## 10. Required quantity and replenishment

**[Verified]** One formula exists, in `withOpenPo`:

```
New_Required_Qty = MAX(0, WH forecast − WH closing stock − pending PO)
```

**[Rule]** Three deliberate choices: **closing** stock (what is on the shelf now,
for someone deciding what to order), a missing or **negative** figure counts as
zero, and the result is **blank — not zero — when there is no WH forecast**, since
with nothing forecast there is no requirement to net down.

**[Risk] This field is calculated but displayed nowhere.** It is in the API
response and is summed when rows are folded, but no column renders it. It was
explicitly requested that it not be shown.

**[Verified]** The separate **Replenishment Planning** table (a 43-column table
below Article Detail, administrators and stock departments only) is withheld for
future windows, because a plan built on an extrapolated forecast would read as
firmer than it is.

---

## 11. Dates, windows and filters

### 11.1 Three kinds of window

**[Verified]** `resolveBasis` in `whConstant.js` decides which question is being
asked. They need different sales figures:

| Mode | When | Sales used |
|---|---|---|
| **live-future** | the period has not started | the sales forecast — everything about it is a forecast already |
| **live-current** | the period contains today | part actual, part forecast |
| **historical** | the period has ended | **not its own sales** — see below |

### 11.2 The leakage rule

**[Rule]** This is the most important safeguard in the system.

**A month may never be trained on itself or on anything after it.** The training
months are the six whole months before the *target* month, not before today.

```
pastMonths('2026-08-01')  →  Feb, Mar, Apr, May, Jun, Jul   (viewing August)
pastMonths('2026-09-01')  →  Mar, Apr, May, Jun, Jul, Aug   (viewing September)
```

**[Verified]** `constantsFor` **throws an error and refuses to run** if any
training month is not strictly before the target month. The error names the
offending months.

**[Rule]** It also refuses to default the anchor. Passing nothing used to mean
"today", and every caller forgot — which is exactly how the target month leaked
into its own forecast.

**[Rule]** A **future** window is anchored to the *current* month, not to itself:
planning October in September would make September "a completed month before it",
and September is not over.

### 11.3 A finished month has no retained sales forecast

**[Risk]** When the month closes, `[Totalsale]` is overwritten with the actual,
and the model keeps no record of what was forecast beforehand.

**[Verified]** So for a historical window, the sales figure falls back to the
article's own decayed sales base, scaled to the window length. The arithmetic
then cancels:

```
level ÷ salesBase × salesBase × (days ÷ 30.44)   =   level × (days ÷ 30.44)
```

**This looks like a bug and is not.** With no retained sales forecast there is no
honest sales signal left for a past month. A `salesVintage` table exists to
capture forecasts before the month closes, but **[Verified]** it returns null for
every month that closed before it shipped.

### 11.4 What makes the WH forecast go blank

**[Rule]** `forecastFromConstants` returns **nothing at all** if any of these
filters are set:

- **Location / branch**
- **Product**
- **Article (PLU)**

**[Rule]** Both halves of the ratio are brand-level facts: outbound names a
*brand*, not a branch, and the sales total has no product column. Under a branch
filter the numerator would stay whole while the denominator shrank, and the
column would read several times too high. **Blank is the honest answer.**

**[Risk]** This surprises people regularly — selecting "42 locations" silently
empties the WH forecast column with no message on screen.

### 11.5 Which window the local copy can answer

**[Verified]** `canAnswer` / `canAnswerComponents` in `server/cube/query.js` check
`cube_coverage` before using the copy. The recipe side must hold a row for
**every day it claims**, not merely span the range.

> **Recorded example:** a thin copy answered a month's question with 8 rows where
> the live query returned 1,151. Nothing errored — the page simply came back
> nearly empty, which reads as "there is almost nothing to make".

**[Verified]** Outbound's end date is **clamped** to the last day the warehouse
has reported, rather than refused. Reaching forward is only asking about days
that have not happened; reaching back before the copy begins is a real hole and
*is* refused.

---

## 12. Accuracy

**[Verified]** There are three different accuracy figures on the page. They are
not interchangeable.

### 12.1 WH ACC% — the warehouse forecast

```
WH ACC% = 1 − |forecast − outbound| ÷ MAX(forecast, outbound)
```

**[Rule]** Dividing by the **larger** of the two makes it symmetric and bounded
between 0 and 1, so nothing needs clamping. Equal quantities score 100%, one side
twice the other scores 50%, a real forecast against nothing issued scores 0%.

**[Verified]** It replaced dividing by outbound, which sent articles with a tiny
denominator to −442% and clamped 204 of 1,135 components to zero.

**[Verified]** Blank only where there is genuinely nothing to compare.

### 12.2 ACC% — the product mix forecast

```
ACC% = 1 − |actual − forecast| ÷ actual
```

**[Verified]** `client/src/mixAccuracy.js`. Divided by the **actual**, which makes
it a different measure from WH ACC% — it asks "how wrong was the plan about what
we would need", and the thing that happened is the denominator.

**[Rule]** Blank (not zero) in three cases: no actual, an actual of zero, or no
forecast. The value is left **signed and unbounded** — an article forecast at
40,345 against four units issued scores −1,008,417%, and that is a finding about
a discontinued line rather than a number to hide.

### 12.3 The stock rule

**[Rule]** This changes the headline number more than anything else on the page.

```
IF  2 × WH forecast  ≤  Store SOH   THEN  WH ACC% = 100%
```

If the shops already held at least twice the forecast, not shipping was the right
call, so the forecast is not marked down for it. Applied **before** the ordinary
score, so it wins outright. A row scored this way is **marked with a dot**.

**[Verified]** Measured over 2–24 Sep on 1,485 scored rows:

| | |
|---|---:|
| rows meeting the condition | 1,181 (79.5%) |
| of those, previously under 50% | 537 |
| average WH ACC% | 49.2% → **90.8%** |

**[Risk] The argument against this rule is recorded in the code and is a good
one.** Store stock correlates with what the warehouse actually shipped at
**r = +0.80, positively**, across 28,147 brand-article-weeks — shops holding more
of an article *receive* more of it, because both are driven by how much that shop
sells. So high store stock mostly means "busy article", not "needs nothing".

**[Risk]** There is also a direction problem: the test is `2 × forecast ≤ SOH`, so
a **smaller** forecast is more likely to qualify. **Under-forecasting earns the
perfect score**, and nothing detects or reports when that happens.

**[Rule]** Both points were put to the business on 26 Sep 2026 with these figures
and the rule was confirmed.

**[Rule]** A missing SOH reading is **not** cover, and a negative book balance is
not cover. Roughly 5% of forecast rows have no store SOH at all.

### 12.4 New WH ACC% (administrators only)

```
ratio = outbound ÷ forecast
```

**[Verified]** Directional and **unbounded** — shipping double scores 200%.
A high number here is not necessarily good. Measured over 1–23 Sep: 461 of 1,467
articles above 100%, 49 above 300%, largest 2,757%.

### 11.6 The Status column

**[Verified]** `server/insights/whClassify.js`. How long since the warehouse last
issued the article, in **rolling days** rather than calendar months:

| Status | Meaning |
|---|---|
| **Active** | shipped within the last 60 days |
| **Slow-Moving** | nothing for 61–90 days |
| **Super Slow-Moving** | nothing for 91–120 days |
| **Non-Moving** | nothing for 121–150 days |
| **To Be Deactivated** | nothing for more than 150 days |
| **Never shipped** | the warehouse has never issued it |

**[Rule]** Rolling days, not calendar months, so an article does not change status
merely because the calendar turned over.

**[Rule]** Idle days are counted to the **end of the selected window**, clamped to
the last day actually reported (`clampAsAt`). Without the clamp, selecting a
window that ended in the future counted days nobody had lived through: an article
14 days idle was relabelled Slow-Moving at 61 days idle simply because the window
ended on 2 November.

---

---

## 13. Business rules and exceptions

A consolidated list of every deliberate rule found.

| # | Rule | Where |
|---|---|---|
| 1 | Six whole months of history, never the current one | `pastMonths` |
| 2 | A month may never be trained on itself — enforced by a thrown error | `constantsFor` |
| 3 | Averaging starts at the article's first delivery | `constantsFor` |
| 4 | Recent months weighted more heavily, decay `ALPHA = 0.6` | `constantsFor` |
| 5 | Four behaviour classes decide the method | `behaviourOf`, `quantityFor` |
| 6 | New and rare articles are **not** scaled by sales | `quantityFor` |
| 7 | A forecast of zero stays on the page and is scored | `forecastFromConstants` |
| 8 | Recipe articles need a forward menu — except consumables | `forecastFromConstants` |
| 9 | A failed menu query never deletes a forecast | `forecastFromConstants` |
| 10 | WH forecast rounded **up** to whole packs | `withRoundedForecast` |
| 11 | Accuracy scored on the **unrounded** figure | `withRoundedForecast` |
| 12 | Stock rule: 2 × forecast ≤ Store SOH → 100%, marked with a dot | `whAccuracy.js` |
| 13 | A missing or negative SOH is not cover | `coveredByStock` |
| 14 | Branch / product / PLU filters blank the WH forecast | `forecastFromConstants` |
| 15 | Warehouse figures stamped on one row per article only | `withStoreStock` |
| 16 | Folded rows recalculate scores from folded totals | `ComponentLevel.jsx` |
| 17 | Store DTL is carried, not added (it is in days) | `ComponentLevel.jsx` |
| 18 | Stock balances clamp to the feed's last reported day | `storeStock` |
| 19 | Stock quantities withheld from the response, not hidden | `withStoreStock` |
| 20 | The stock rule's answer is sent to everyone, the number is not | `withStoreStock` |
| 21 | Supply classification uses **no time window** | `powerbi/warehouse.js` |
| 22 | Required Qty blank when there is no forecast | `withOpenPo` |
| 23 | The catch-all bucket is measured against **all** brands' sales | `constantsFor` |

**[Rule] On #21 — supply classification:** decided by `warehouseSourcedArticles()`
in `server/powerbi/warehouse.js`, applied by `withSupply` in `routes/api.js`.

"Warehouse" means the article's inbound supply came from the Central Warehouse;
"Direct Supply" means it did not. It is read from the **source column** of every
outbound line, not inferred from shipping history, stock or purchase orders.

**Membership, not quantity: one supplied line is enough, and there is no time
window** — an article the warehouse supplied last year is warehouse-supplied.
Whether it moved *recently* is what the Status column is for.

The model folds 14 differently-named warehouse sites into one value, so supply,
stock and outbound are all attributed by the same mapping. Measured 14 Sep 2026:
174 distinct raw source names, none blank, none unmapped, across 558,155,896
units.

**[Risk] The in-app Calculations catalogue disagrees with the code on this
point.** `server/calculations.js` describes Supply as *"the warehouse has issued
this article in the last 6 months"*, and names "the six-month lookback" as a
tunable. The implementation applies **no lookback at all**. One of the two is
wrong and they are shown to the same users. See open question 7.

**[Rule] On #23 — the catch-all bucket:** outbound that reaches a destination
which is not one of the nine brands is kept together under `__other` rather than
discarded. It is real consumption with nobody to attribute it to.

---

## 14. Which file does what

### Server

| File | Responsibility |
|---|---|
| `server/insights/whConstant.js` | **The forecast engine.** Constants, behaviour classes, quantities |
| `server/insights/siteForecast.js` | The site forecast — same engine, kitchen history |
| `server/insights/planForecast.js` | Method C — the plan-year product forecast |
| `server/insights/planArticles.js` | Plan-year article explosion through the recipes |
| `server/insights/salesPlan.js` | Typed targets, plan windows, the cross-year refusal |
| `server/cube/planShape.js` | Seasonality — twelve monthly weights per brand |
| `server/insights/recipeBrands.js` | Which recipe groups belong to which brand |
| `server/insights/storeStock.js` | Store and warehouse stock, Store DTL, the as-at clamp |
| `server/insights/openPo.js` | Pending purchase orders |
| `server/insights/stdPkg.js` | Standard pack sizes for rounding |
| `server/insights/whClassify.js` | The **Status** ladder (Active → To Be Deactivated) |
| `server/insights/futureDemand.js` | Which articles a forward menu still wants |
| `server/insights/stockCover.js` | Server copy of the stock rule |
| `server/cube/query.js` | Reads the local copy; decides copy vs live |
| `server/cube/extract.js` | Builds the local copy from Power BI |
| `server/cube/outbound.js` | Outbound daily and monthly tables |
| `server/powerbi/warehouse.js` | Outbound DAX, and **Warehouse vs Direct Supply** |
| `server/powerbi/client.js` | Power BI calls, retries, concurrency gate |
| `server/routes/api.js` | `/component-level`; stitches every column together |
| `server/departments.js` | Who may see which page and which columns |

### Client

| File | Responsibility |
|---|---|
| `client/src/pages/ComponentLevel.jsx` | The Stock Article page — all 39 columns |
| `client/src/whAccuracy.js` | WH accuracy and the stock rule |
| `client/src/mixAccuracy.js` | Product-mix accuracy |
| `client/src/scores.js` | Averaging across articles |
| `client/src/components/DataTable.jsx` | The table, grouping, export |
| `client/src/components/ReplenishmentPlanning.jsx` | The replenishment table |

### The flow, end to end

```
Power BI models
      │  extract.js, hourly + 02:00 rebuild
      ▼
local copy  (cube_sales_daily, cube_outbound_*, cube_component_*)
      │
      ▼
constantsFor()        six months of rates per article
      │
      ▼
forecastFromConstants()   rate × this window's sales, by behaviour class
      │
      ▼
/api/component-level      + stock, pending PO, pack rounding, status, category
      │
      ▼
ComponentLevel.jsx        folds rows per article, scores, renders
```

**[Verified]** A single Stock Article page load touches: the local copy for
components and outbound; `whConstant` for the forecast; the Inventory Control
model for stock and pending POs; and the brand models for anything the copy
cannot answer.

---

## 15. Limitations and risks

| # | Issue | Impact |
|---|---|---|
| 1 | Branch/product/PLU filters blank the WH forecast with **no message on screen** | High — users think the page is broken |
| 2 | The stock rule lifts average WH ACC% by ~41 points and rewards under-forecasting | High — the headline number is not what it appears |
| 3 | Finished months have no retained sales forecast, so the ratio cancels | Medium — backtests are not measuring the live method |
| 4 | Store stock had an upstream posting gap; derived columns still switched off | Medium — **[Check]** whether fixed |
| 5 | Required Qty is calculated but shown nowhere | Low — deliberate, but easy to forget it exists |
| 6 | The "still moving" test is off by default (`ACTIVE_MONTHS = 0`) | **[Check]** — stopped articles may still be forecast |
| 7 | Power BI can return ~half the rows with a 200 and no error | High — mitigated by splitting queries into spans |
| 8 | Local copy is single-writer PGlite; one process at a time | Medium — a lock conflict stops the app |
| 9 | Stock balances for a future period are *today's* balance | Low — clamped and labelled, but must be read correctly |
| 10 | Legacy model still reachable via `WH_FORECAST_MODEL=legacy` | Low — two models can be confused |
| 11 | **The sales and product forecast methods are not documented anywhere in this codebase** | High for Phase 2 — three of the five forecasts are upstream black boxes |
| 12 | The recipe explosion under-forecasts PA articles by 20–27% | Medium — known, and why the site forecast exists |
| 13 | `Product PLU` is Integer in one model and Text in the others | Medium — a fallback join exists and is in use |

**[Risk] On #7:** Power BI does not refuse a query that returns too much — it
answers 200 with roughly half the rows and says nothing.

> **Recorded example:** a month of articles split by branch and day came back
> reading 1,133,418 units against a true 1,228,977.

---

## 16. Open questions for Phase 2

Things this review could **not** settle from the code. Each needs a business or
data owner to answer.

1. **Should the stock rule stay as it is?** It was confirmed on 26 Sep 2026 with
   the evidence against it on the table. Phase 2 should decide whether to keep
   it, report it separately, or add a check for under-forecasting.
2. **Has the store-stock posting gap been fixed upstream?** If so, Stock cover
   and SOH status can come back.
3. **Should the "still moving" test be switched on?** `ACTIVE_MONTHS` is 0, so
   stopped articles are not excluded.
4. **Should Required Qty be shown?** It is calculated, tested and hidden.
5. **Can a sales-forecast vintage be captured?** Without it, no finished month can
   be scored against the forecast that was actually made for it. The table exists
   and is empty.
6. **Should the WH forecast answer under a branch filter?** Currently blank by
   design. If branch-level warehouse forecasting is wanted, both halves of the
   ratio need a branch dimension that does not exist today.
7. **Is "Warehouse supply means ever, not recently" still the right rule?**
8. **Should the Calculations catalogue be corrected for Supply?** It states a
   six-month lookback that the code does not apply. Either the text or the rule
   needs to change — currently the app documents a rule it does not follow.
9. **How are the sales forecast and the product forecast actually produced?**
   `[Totalsale]` and `[Total_Forecast_Qty]` are built upstream in Power BI and
   **no part of this codebase describes the method**. Three of the five
   forecasts are therefore undocumented from this side. Phase 2 should get this
   from the model owner — the warehouse forecast is multiplied by `[Totalsale]`,
   so any bias in it passes straight through.
10. **Should the recipe explosion be corrected, or retired for PA articles?**
    The site forecast beats it on every measure tested.
11. **Should `Product PLU` be made one data type across the models?** The
    fallback join works but is a standing difference between brands.

---

## Summary

- **Five forecasts, not one.** Sales, products and the recipe explosion come
  from Power BI. The warehouse forecast and the site forecast are calculated in
  this application. A sixth method, Method C, covers planned years.
- **The warehouse forecast** is a six-month, decay-weighted shipping rate applied
  to expected sales, with four behaviour classes and a strict no-leakage rule.
- **The site forecast** is the same engine pointed at kitchen history, and it
  beats the recipe explosion on prepared articles by a wide, measured margin.
- **The plan-year forecast** keeps size and seasonality apart: a typed target
  says how big the year is, the seasonal factors say what shape it has, and
  every other input is an observed actual.
- **Stock** comes from one inventory feed that ends yesterday, clamped and
  labelled.
- **Accuracy** is measured three different ways, and the stock rule moves the
  headline figure by about forty points.
- **The biggest risks** are silent ones: filters that blank a column without
  saying so, a stock rule that rewards forecasting low, and three upstream
  forecasts whose method is not documented anywhere on this side.
