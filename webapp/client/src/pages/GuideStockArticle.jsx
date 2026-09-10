/**
 * The Stock Article walkthrough, drawn rather than screenshotted.
 *
 * It exists because one question kept coming back by email: somebody compares a
 * warehouse outbound sheet against the page, cannot find an article, and reports
 * it missing. Measured on 10 Sep 2026, 468 of 488 such articles were already on
 * the page — the reports spell names differently, and the page's search box only
 * filters the rows already loaded. So the walkthrough's real job is to show the
 * two things that settle it: which filters to set, and where "Find an article"
 * is.
 *
 * The interface below is rebuilt in markup instead of pasted in as images. Three
 * reasons, all practical: it stays sharp at any zoom and on any screen, it
 * follows the reader's light or dark theme like the rest of the app, and a
 * highlight ring can be attached to the element it marks rather than to a pixel
 * coordinate that a different window width would move off target.
 *
 * Every label, menu entry, figure and column below is copied from the live page.
 *
 * One layout rule worth keeping: an open menu is rendered *below* the filter bar
 * rather than floating over it. Anchoring it absolutely put it inside the bar's
 * own scroller, where it was clipped at the bottom edge — the reader got a
 * scrollbar exactly where the point of the step was.
 */

import { useLayoutEffect, useRef, useState } from 'react'

/** The pointer, sitting just off the corner of whatever it marks. */
function Cursor() {
  return (
    <span className="sa__cursor" aria-hidden="true">
      <svg width="19" height="23" viewBox="0 0 20 24" fill="none">
        <path
          d="M2 1.5 L2 18 L6.4 13.8 L9.6 21.4 L12.6 20.1 L9.4 12.6 L15.5 12.6 Z"
          fill="#fff"
          stroke="#111"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/** One filter button, exactly as the bar renders it. */
function Slicer({ label, value, n }) {
  if (!n) {
    return (
      <span className="sa__slicer">
        {label ? <span className="sa__slicerLbl">{label}:</span> : null}
        <b>{value}</b>
        <i>⌄</i>
      </span>
    )
  }
  return (
    <span className="sa__pick">
      <span className="sa__slicer sa__ring" data-n={n}>
        {label ? <span className="sa__slicerLbl">{label}:</span> : null}
        <b>{value}</b>
        <i>⌄</i>
      </span>
      <Cursor />
    </span>
  )
}

/**
 * What the two links at the top of every slicer menu do.
 *
 * Attached to the menu rather than written into one step, because it is the same
 * answer for Supply, Status, Prod. type, Recipe and the rest — and because the
 * difference between them is not obvious from the words. They usually show the
 * same rows; where they differ is a row that has no value for the slicer at all.
 */
function MenuLinks() {
  return (
    <dl className="sa__opts sa__opts--tight">
      <div>
        <dt>Select all</dt>
        <dd>
          Ticks every value in the list. Use it to widen a view you have narrowed — reviewing the
          whole range, or looking for an article you cannot find.
        </dd>
      </div>
      <div>
        <dt>Clear</dt>
        <dd>
          Unticks everything, which means no filter at all. The button goes back to reading{' '}
          <b>All</b>.
        </dd>
      </div>
      <div>
        <dt>Which to use</dt>
        <dd>
          Nearly always the same rows, so either will do. They part company on a row that has no
          value for this slicer — a kitchen prep step has no article number, so it has no status.{' '}
          <b>Clear</b> keeps those rows; <b>Select all</b> drops them, because they match none of
          the six values. If a row disappears when you tick everything, that is why.
        </dd>
      </div>
    </dl>
  )
}

/** An open slicer menu — tick list, Select all / Clear, and the value count. */
function Menu({ title, items }) {
  return (
    <div className="sa__menu">
      <div className="sa__menuHead">
        <span>{title}</span>
        <span className="sa__menuActs">
          <span>Select all</span>
          <span>Clear</span>
        </span>
      </div>
      <ul className="sa__menuList">
        {items.map(([name, on]) => (
          <li key={name}>
            <span className={`sa__check${on ? ' sa__check--on' : ''}`}>{on ? '✓' : ''}</span>
            {name}
          </li>
        ))}
      </ul>
      <div className="sa__menuFoot">
        <span>{items.length} values</span>
        <span>{items.filter(([, on]) => on).length} selected</span>
      </div>
    </div>
  )
}

/** What a slicer's options mean, so the reader chooses rather than obeys. */
function Options({ rows }) {
  return (
    <dl className="sa__opts">
      {rows.map(([name, meaning]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{meaning}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A filter bar with, optionally, one of its menus open underneath it.
 *
 * The open panel is nudged across to sit under the slicer it belongs to. It
 * used to start at the left edge of the drawing, which put the Supply panel
 * under Location and left the reader matching a panel to a button by reading
 * its title.
 *
 * The offset is measured from the laid-out ring rather than worked out from the
 * marked slicer's index, because the buttons are all different widths and the
 * bar wraps — only the browser knows where the marked one actually ended up.
 * Clamped, so a wide panel (the date one) cannot hang off the right edge, and
 * re-measured on resize because that is when the bar rewraps.
 *
 * The Select all / Clear explainer underneath stays on the body's left edge: it
 * belongs to the step, not to the button.
 */
function Stage({ slicers, menu, children }) {
  const barRef = useRef(null)
  const rowRef = useRef(null)
  const panelRef = useRef(null)
  const [offset, setOffset] = useState(0)

  useLayoutEffect(() => {
    const bar = barRef.current
    const row = rowRef.current
    const panel = panelRef.current
    if (!bar || !row || !panel) return undefined

    const align = () => {
      const ring = bar.querySelector('.sa__ring')
      if (!ring) return
      const room = Math.max(0, row.clientWidth - panel.offsetWidth)
      const from = ring.getBoundingClientRect().left - row.getBoundingClientRect().left
      setOffset(Math.round(Math.min(Math.max(0, from), room)))
    }

    align()
    const ro = new ResizeObserver(align)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [Boolean(menu)])

  return (
    <div className="sa__stage">
      {slicers ? (
        <div className="sa__bar" ref={barRef}>
          {slicers}
        </div>
      ) : null}
      {menu ? (
        <div className="sa__menuRow" ref={rowRef}>
          <div className="sa__menuAnchor" ref={panelRef} style={{ marginLeft: offset }}>
            {menu}
          </div>
          <MenuLinks />
        </div>
      ) : null}
      {children}
    </div>
  )
}

const ALL = [
  ['', '9 brands'],
  ['Location', 'All'],
  ['Product', 'All'],
  ['Article', 'All'],
  ['Prod. type', 'All'],
  ['Supply', 'Warehouse'],
  ['Status', 'Active'],
  ['Recipe', 'All'],
  ['Date', '01 Aug – 31 Aug'],
]

/** The bar, with one slicer marked. */
function Bar({ mark, n, only }) {
  const list = only ? ALL.filter(([l]) => only.includes(l)) : ALL
  return list.map(([label, value]) => (
    <Slicer key={label || 'brands'} label={label} value={value} n={label === mark ? n : undefined} />
  ))
}

const ROWS = [
  ['Kids Fries Sleeves BBT Food Board 250gsm', '230,809', '243,168', '94.9%', '12,981', '15,000', '86.5%', '97.4%', '2,500'],
  ['2 Oz Clear Souffle Cup W/Lid', '181,692', '189,150', '96.1%', '254,806', '244,000', '95.8%', '97.4%', '92,000'],
  ['Wrapping Sheet BBT 30 X 30', '179,010', '186,880', '95.8%', '270,622', '275,500', '98.2%', '97.4%', '77,000'],
  ['Clear Sauce Container', '153,922', '153,323', '99.6%', '236,896', '243,000', '97.5%', '97.4%', '87,000'],
  ['Combo Box BBT Currugated KBC225565', '132,758', '140,453', '94.5%', '170,639', '174,100', '98.0%', '97.4%', '57,260'],
]

const STEPS = [
  {
    title: 'Brands',
    do: 'Click the brand button at the far left. Tick as many brands as you need.',
    why: 'Everything else on the page follows this choice. Your account decides which brands you can pick — a brand you cannot see has not been granted to you rather than being missing from the data.',
    options: [
      ['One brand', 'The requirement for that brand alone.'],
      ['Several brands', 'The quantities add up across them, so one row is the total to order.'],
    ],
    body: (n) => (
      <Stage
        slicers={<Bar mark="" n={n} only={['', 'Location', 'Product', 'Article', 'Prod. type']} />}
      />
    ),
  },
  {
    title: 'Supply',
    do: 'Click Supply and choose where the stock comes from.',
    why: 'Only warehouse-supplied articles have WH forecast and Outbound figures, because those are built from warehouse movements. Direct-supply articles are not missing — they never pass through the warehouse, so there is nothing for it to have shipped.',
    options: [
      ['Warehouse', 'Articles the Central Warehouse issues to the shops. These carry WH forecast and Outbound.'],
      ['Direct Supply', 'Delivered straight from the supplier to the shop. No warehouse figures, by definition.'],
      ['Both ticked', 'Everything, with the warehouse columns blank on the direct-supply rows.'],
    ],
    body: (n) => (
      <Stage
        slicers={<Bar mark="Supply" n={n} />}
        menu={
          <Menu
            title="Supply"
            items={[
              ['Warehouse', true],
              ['Direct Supply', false],
            ]}
          />
        }
      />
    ),
  },
  {
    title: 'Status',
    do: 'Click Status and choose which article states you want to see.',
    /*
     * No definitions listed here yet.
     *
     * The six statuses are being revised, and a guide that spells out the old
     * thresholds would be wrong the day they change — and wrong in the place a
     * reader is most likely to trust it. The step shows the choices as the menu
     * shows them and says what the slicer does; the meaning of each status
     * belongs here once it is settled.
     */
    why: 'The status groups articles by how recently the warehouse last issued them. Tick several to compare, or all six to see everything — which is what to do when you are looking for an article you cannot find.',
    body: (n) => (
      <Stage
        slicers={<Bar mark="Status" n={n} />}
        menu={
          <Menu
            title="Status"
            items={[
              ['Active', true],
              ['Slow-Moving', false],
              ['Super Slow-Moving', false],
              ['Non-Moving', false],
              ['To Be Deactivated', false],
              ['Never shipped', false],
            ]}
          />
        }
      />
    ),
  },
  {
    title: 'Date range',
    do: 'Click Date. Pick a preset on the left, or type FROM and TO on the right.',
    why: 'One thing worth knowing whichever you pick: most articles are delivered every one to three days, but some are fortnightly and some less than monthly. Over a short window those have not come round yet and show nothing — so a short range makes accuracy look worse than it is. A complete month is the fairest comparison.',
    options: [
      ['Last 7 / 14 / 30 days', 'A rolling window ending yesterday.'],
      ['Month to date', 'The 1st until yesterday. Useful for ordering, not for judging accuracy — the month is unfinished.'],
      ['Tomorrow · Next 7 / 30 days', 'Forecast only. There are no actuals yet, so the accuracy columns are hidden rather than shown as zero.'],
      ['All dates', 'Everything the model covers, 01 Jan to 31 Dec.'],
      ['FROM and TO', 'Any range you type. A whole calendar month is the one to use when checking accuracy.'],
    ],
    body: (n) => (
      <Stage
        slicers={<Bar mark="Date" n={n} only={['Supply', 'Status', 'Recipe', 'Date']} />}
        menu={
          <div className="sa__menu sa__menu--date">
            <ul className="sa__dates">
              {['Last 7 days', 'Last 14 days', 'Last 30 days', 'Month to date', 'Tomorrow', 'Next 7 days', 'Next 30 days', 'All dates'].map(
                (d) => (
                  <li key={d}>{d}</li>
                )
              )}
            </ul>
            <div className="sa__dateFields">
              <label>
                <span>From</span>
                <span className="sa__input">01-08-2026</span>
              </label>
              <label>
                <span>To</span>
                <span className="sa__input">31-08-2026</span>
              </label>
              <p>
                Model covers 01 Jan – 31 Dec. Today is 10 Sept, and past ranges stop at 09 Sept —
                today has only part of its sales in.
              </p>
            </div>
          </div>
        }
      />
    ),
  },
  {
    title: 'Location, Product and Article',
    do: 'You can filter by these — but know what it costs before you do.',
    why: 'Each one empties the WH forecast and Outbound columns. Outbound is recorded per brand — not per branch or per menu item — so the page cannot answer those questions honestly and shows nothing rather than a figure covering the wrong shops. If the warehouse columns are blank on every row, one of these three is why.',
    body: (n) => (
      <Stage
        slicers={
          <>
            <Slicer value="9 brands" />
            <Slicer label="Location" value="All" n="✕" />
            <Slicer label="Product" value="All" n="✕" />
            <Slicer label="Article" value="All" n="✕" />
            <Slicer label="Prod. type" value="All" />
          </>
        }
      />
    ),
  },
  {
    title: 'Read the cards',
    do: 'Warehouse accuracy is the one to watch.',
    why: 'Each accuracy card shows two figures. Average article treats a sticker the same as a pallet of oil. Volume accuracy weights by units shipped — use that one to judge whether the forecast is fit to order from.',
    body: (n) => (
      <div className="sa__stage">
        <div className="sa__cards">
          <div className="sa__kpi">
            <span className="sa__kpiLbl">Outbound</span>
            <b>7,376,100</b>
            <small>Left the warehouse, 621 components measured</small>
          </div>
          <div className="sa__kpi">
            <span className="sa__kpiLbl">Product mix accuracy</span>
            <b>94.1%</b>
            <small>
              Average article · 637 scored
              <br />
              Volume accuracy · 95.9%
            </small>
          </div>
          <div className="sa__kpi sa__ring" data-n={n}>
            <span className="sa__kpiLbl">Warehouse accuracy</span>
            <b>80.0%</b>
            <small>
              Average article · 1,162 scored
              <br />
              Volume accuracy · 93.3%
            </small>
          </div>
          <div className="sa__kpi">
            <span className="sa__kpiLbl">Articles</span>
            <b>1,860</b>
            <small>22 recipe groups</small>
          </div>
          <div className="sa__kpi">
            <span className="sa__kpiLbl">Largest requirement</span>
            <b className="sa__kpiSm">Kids Fries Sleeves BBT Food Board 250gsm</b>
            <small>230,809 Each</small>
          </div>
        </div>
      </div>
    ),
  },
  {
    title: 'Read a row',
    do: 'WH FORECAST is the column to order from. Every column, left to right:',
    why: 'A dash instead of a number is not zero. It means the figure cannot be worked out for that row — hover it and the tooltip says which reason applies. The two accuracy columns are blank rather than zero for a future window, because nothing has been issued against a requirement that has not happened yet.',
    options: [
      ['Article', 'The article name and, in the search, its number. Names differ between systems — the number is the reliable key.'],
      ['Type', 'RAW is bought in, PREP is a kitchen step, PA is something the kitchen produces itself.'],
      ['Unit', "The article's own base unit — Each, Kilogram or Liter. Quantities are always in this unit."],
      ['Forecast qty', 'What the recipes say you need for the sales forecast in your date range.'],
      ['Actual qty', 'What the recipes say the sales that actually happened would have used.'],
      ['Acc%', 'How close those two are. Because both come from the same recipe, this really scores the sales forecast rather than the recipe.'],
      ['WH forecast', 'What to order. Built from six months of what the warehouse actually shipped, applied to the sales expected in your date range — it never looks at a recipe.'],
      ['Outbound', 'What really left the warehouse in your date range.'],
      ['WH acc%', 'How close WH forecast and Outbound are. This is the figure the Warehouse accuracy card averages.'],
      ['Sales acc%', 'How good the sales forecast was for these days. It is a property of the day, not of the article, so every row shows the same figure.'],
      ['Outbound MTD', 'What has left the warehouse from the 1st of this month until today — deliberately ignoring the date slicer, so it still answers "how much of what I am about to order has already gone out" when you look back at July.'],
      ['Status', 'How recently the warehouse last issued the article — the same values as the Status slicer.'],
    ],
    body: (n) => (
      <div className="sa__stage">
        <div className="sa__tablewrap">
          <table className="sa__t">
            <thead>
              <tr>
                <th colSpan={3} />
                <th colSpan={3} className="sa__gh sa__mix">
                  Product mix
                </th>
                <th colSpan={3} className="sa__gh sa__wh">
                  Warehouse
                </th>
                <th colSpan={3} />
              </tr>
              <tr>
                <th>Article</th>
                <th>Type</th>
                <th>Unit</th>
                <th className="sa__num sa__mix">Forecast qty</th>
                <th className="sa__num sa__mix">Actual qty</th>
                <th className="sa__num sa__mix">Acc%</th>
                <th className="sa__num sa__wh sa__ring" data-n={n}>
                  WH forecast
                </th>
                <th className="sa__num sa__wh">Outbound</th>
                <th className="sa__num sa__wh">WH acc%</th>
                <th className="sa__num">Sales acc%</th>
                <th className="sa__num">Outbound MTD</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r[0]}>
                  <td>{r[0]}</td>
                  <td>
                    <span className="sa__tag">RAW</span>
                  </td>
                  <td>Each</td>
                  <td className="sa__num sa__mix">{r[1]}</td>
                  <td className="sa__num sa__mix">{r[2]}</td>
                  <td className="sa__num sa__mix">{r[3]}</td>
                  <td className="sa__num sa__wh sa__strong">{r[4]}</td>
                  <td className="sa__num sa__wh">{r[5]}</td>
                  <td className="sa__num sa__wh">{r[6]}</td>
                  <td className="sa__num">{r[7]}</td>
                  <td className="sa__num">{r[8]}</td>
                  <td>
                    <span className="sa__tag sa__tag--g">Active</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ),
  },
  {
    title: 'Add or remove columns',
    do: 'Click Build view to choose which columns you see.',
    why: 'It shows how many of the available columns are switched on — 12 of 18 here. Your choice is remembered, and the CSV download exports exactly the columns you are looking at.',
    body: (n) => (
      <div className="sa__stage">
        <div className="sa__panelhead">
          <span className="sa__pick">
            <span className="sa__btn sa__btn--on sa__ring" data-n={n}>
              ▥ Build view 12/18
            </span>
            <Cursor />
          </span>
          <span className="sa__spacer" />
          <span className="sa__search">🔍 Search article or group…</span>
        </div>
      </div>
    ),
  },
  {
    title: 'Search inside the table',
    do: 'Type the article number into the search box.',
    why: 'Use the number, never the name — the warehouse system and the forecast spell articles differently. Be aware that this box only searches the rows already on screen, so an article hidden by a filter comes back empty. If nothing is found, go to the next step.',
    body: (n) => (
      <div className="sa__stage">
        <div className="sa__panelhead">
          <span className="sa__btn sa__btn--on">▥ Build view 12/18</span>
          <span className="sa__spacer" />
          <span className="sa__pick">
            <span className="sa__search sa__ring" data-n={n}>
              🔍 106200164
            </span>
            <Cursor />
          </span>
        </div>
      </div>
    ),
  },
  {
    title: 'Cannot find it? Use “Find an article”',
    do: 'Click Find an article, above the table on the right.',
    why: 'This searches the whole warehouse catalogue, not just this page. It tells you whether the article is in the forecast, why not if it is not, which brands it ships to, and what the warehouse issued in each of the last twelve months — so you can check it yourself before reporting it missing.',
    body: (n) => (
      <div className="sa__stage">
        <div className="sa__panelhead">
          <span>
            <b>Article detail</b> <span className="sa__tag">1,860 rows</span>
          </span>
          <span className="sa__spacer" />
          <span className="sa__pick">
            <span className="sa__btn sa__ring" data-n={n}>
              Find an article
            </span>
            <Cursor />
          </span>
          <span className="sa__btn">⭳ CSV</span>
        </div>
      </div>
    ),
  },
]

export function StockArticleWalkthrough() {
  return (
    <div className="sa">
      <p className="sa__intro">
        Ten steps, in order. Set the filters, read the numbers, then check any article for
        yourself. The pink ring and the pointer mark the thing to click.
      </p>

      {STEPS.map((s, i) => (
        <div className="sa__step" key={s.title}>
          <div className="sa__stepHead">
            <span className="sa__stepN">{i + 1}</span>
            <h3>{s.title}</h3>
          </div>
          {/*
            * One padded body, rather than a margin on each child.
            *
            * The header is tinted and spans the whole card; everything else
            * shares this box's padding, so the instruction, the drawing, the
            * option list and the note cannot end up on four different edges.
            */}
          <div className="sa__stepBody">
            <p className="sa__do">
              <span aria-hidden="true">▸</span> {s.do}
            </p>
            {s.body(i + 1)}
            {s.options ? <Options rows={s.options} /> : null}
            <p className="sa__why">{s.why}</p>
          </div>
        </div>
      ))}

      <div className="sa__step sa__step--plain">
        <div className="sa__stepHead">
          <span className="sa__stepN">?</span>
          <h3>If you still cannot find an article</h3>
        </div>
        <div className="sa__stepBody">
          <ol className="sa__last">
            <li>
              Set <b>Status → All</b>, <b>Supply → All</b>, <b>Recipe → All</b>,{' '}
              <b>Location → All</b>.
            </li>
            <li>
              Set the date to a <b>full month</b>.
            </li>
            <li>
              Search by <b>article number</b>, never the name.
            </li>
            <li>
              Open <b>Find an article</b> and read the reason it gives.
            </li>
            <li>
              Send the <b>article number</b> and that reason to the data team.
            </li>
          </ol>
        </div>
      </div>

      {/*
        * The reference table lives in the same card as a step.
        *
        * It sat bare on the page background, which read as something that had
        * not been finished — every other block on the page is in a card. And
        * the effect column was a sentence in a colour; as a flag it can be
        * scanned down instead of read across.
        */}
      <div className="sa__step">
        <div className="sa__stepHead sa__stepHead--plain">
          <h3>What each filter does</h3>
        </div>
        <div className="sa__stepBody">
          <table className="sa__ref">
            <thead>
              <tr>
                <th>Filter</th>
                <th>Set it to</th>
                <th>Effect on the warehouse columns</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Brands', 'The brands you order for', 'Safe', true],
                ['Location', 'All', 'Empties them', false],
                ['Product', 'All', 'Empties them', false],
                ['Article', 'All', 'Empties them', false],
                ['Prod. type', 'All, or RAW for raw materials only', 'Safe', true],
                ['Supply', 'Warehouse', 'Safe — the point of the page', true],
                ['Status', 'Active to order · All to hunt', 'Safe, but hides idle articles', true],
                ['Recipe', 'All', 'Safe', true],
                ['Date', 'A full month', 'Short windows make accuracy look worse', false],
              ].map(([f, v, e, ok]) => (
                <tr key={f}>
                  <th scope="row">{f}</th>
                  <td>{v}</td>
                  <td>
                    <span className={`sa__flag${ok ? ' sa__flag--ok' : ' sa__flag--care'}`}>
                      <span className="sa__dot" aria-hidden="true" />
                      {e}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  )
}
