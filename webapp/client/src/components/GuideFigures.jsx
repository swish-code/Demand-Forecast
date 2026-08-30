/**
 * Line drawings of the pages, for the guide.
 *
 * Drawn rather than screenshotted, deliberately. A screenshot is out of date
 * the first time a column moves, it carries whichever brand and month happened
 * to be on screen, it cannot follow the reader into dark mode, and at this size
 * the text in it is unreadable anyway. A diagram says where things sit, which
 * is the only question a guide is answering.
 *
 * Every shape takes its colour from two custom properties set on the wrapper —
 * an ink and an accent — so the figures follow the theme without a second set
 * of assets, and each page keeps the colour it has everywhere else in the
 * guide.
 */

const W = 320
const H = 196

/** The window: a rail down the left, a bar across the top, content under it. */
function Shell({ children, rail = true }) {
  return (
    <>
      <rect x="0.5" y="0.5" width={W - 1} height={H - 1} rx="7" className="fig__frame" />
      {rail && <path d={`M8 1 H26 V${H - 1} H8 Z`} className="fig__rail" />}
      <line x1={rail ? 26 : 8} y1="26" x2={W - 8} y2="26" className="fig__line" />
      {children}
    </>
  )
}

/** The filter bar: brand, then the slicers, then the date. */
function Filters({ y = 36, active = 0 }) {
  const widths = [56, 42, 42, 52]
  const top = Number(y)
  let x = 36
  return (
    <g>
      {widths.map((w, i) => {
        const el = (
          <rect
            key={i}
            x={x}
            y={top}
            width={w}
            height="13"
            rx="4"
            className={i === active ? 'fig__pill fig__pill--on' : 'fig__pill'}
          />
        )
        x += w + 6
        return el
      })}
    </g>
  )
}

const Card = ({ x, y, w = 58, h = 30, strong }) => (
  <rect x={x} y={y} width={w} height={h} rx="4" className={strong ? 'fig__card fig__card--on' : 'fig__card'} />
)

/** A row of table lines, the first one heavier so it reads as a header. */
function Rows({ x = 36, y, w = 276, n = 5, gap = 11 }) {
  // Coerced, because `+` on a string prop concatenates: y="76" with a gap of 12
  // put the second row at 7612 rather than at 88, and the drawing collapsed to
  // a single line with everything else off the canvas.
  const left = Number(x)
  const top = Number(y)
  const width = Number(w)
  return (
    <g>
      {Array.from({ length: n }, (_, i) => (
        <rect
          key={i}
          x={left}
          y={top + i * gap}
          width={i === 0 ? width : width - (i % 3) * 26}
          height="5"
          rx="2.5"
          className={i === 0 ? 'fig__row fig__row--head' : 'fig__row'}
        />
      ))}
    </g>
  )
}

/* ------------------------------------------------------------ the pages --- */

export function FigOverview() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fig" role="img" aria-label="The Overview page: four figure cards above a chart of actual against forecast">
      <Shell>
        <Filters />
        {[36, 100, 164, 228].map((x, i) => (
          <Card key={x} x={x} y={58} strong={i === 0} />
        ))}
        <rect x="36" y="98" width="276" height="88" rx="5" className="fig__panel" />
        {/* Actual solid, forecast dashed — the same pair as the chart itself. */}
        <path d="M46 168 C 86 150, 106 120, 146 130 S 216 116, 256 108 L 302 118" className="fig__series" />
        <path
          d="M46 160 C 86 146, 106 132, 146 138 S 216 126, 256 120 L 302 126"
          className="fig__series fig__series--dashed"
        />
      </Shell>
    </svg>
  )
}

export function FigProducts() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fig" role="img" aria-label="The Products page: a table of products with actual, forecast and variance columns">
      <Shell>
        <Filters active={1} />
        <rect x="36" y="58" width="276" height="128" rx="5" className="fig__panel" />
        {/* Column edges, so it reads as a table rather than as paragraphs. */}
        {[176, 216, 256].map((x) => (
          <line key={x} x1={x} y1="70" x2={x} y2="178" className="fig__line fig__line--faint" />
        ))}
        <Rows x="46" y="76" w="256" n={9} gap={12} />
      </Shell>
    </svg>
  )
}

export function FigIngredients() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fig" role="img" aria-label="The Ingredients page: a component table beside three cards, one for each unit of measure">
      <Shell>
        <Filters active={2} />
        <rect x="36" y="58" width="168" height="128" rx="5" className="fig__panel" />
        <Rows x="46" y="72" w="148" n={9} gap={12} />
        {/* Three cards down the right: one per unit, which is the page's shape. */}
        {[58, 102, 146].map((y) => (
          <g key={y}>
            <rect x="212" y={y} width="100" height="40" rx="5" className="fig__panel" />
            <rect x="220" y={y + 8} width="42" height="4" rx="2" className="fig__row fig__row--head" />
            {[0, 1].map((i) => (
              <g key={i}>
                <rect x="220" y={y + 20 + i * 9} width="34" height="4" rx="2" className="fig__row" />
                <rect x="260" y={y + 20 + i * 9} width={44 - i * 14} height="4" rx="2" className="fig__bar" />
              </g>
            ))}
          </g>
        ))}
      </Shell>
    </svg>
  )
}

export function FigPlan() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fig" role="img" aria-label="Tomorrow's Prep: a banner naming the day, four figures, and a table with a status on each line">
      <Shell>
        <Filters active={3} />
        {/* The banner naming the day the plan is for. */}
        <rect x="36" y="56" width="276" height="16" rx="4" className="fig__note" />
        {[36, 100, 164, 228].map((x, i) => (
          <Card key={x} x={x} y={80} h={26} strong={i === 0} />
        ))}
        <rect x="36" y="114" width="276" height="72" rx="5" className="fig__panel" />
        {Array.from({ length: 4 }, (_, i) => (
          <g key={i}>
            <rect x="46" y={126 + i * 15} width="190" height="5" rx="2.5" className="fig__row" />
            {/* The prep status, which is the column this page exists for. */}
            <rect x="252" y={123 + i * 15} width="50" height="11" rx="5.5" className={i === 1 ? 'fig__bar' : 'fig__pill'} />
          </g>
        ))}
      </Shell>
    </svg>
  )
}

/** Build view: the column list opening over a table. */
export function FigBuildView() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fig" role="img" aria-label="Build view: a list of columns opening above the table, two of them marked as splitting rows">
      <Shell rail={false}>
        <rect x="8" y="36" width="60" height="14" rx="4" className="fig__pill fig__pill--on" />
        <rect x="8" y="58" width="304" height="128" rx="5" className="fig__panel" />
        <Rows x="18" y="72" w="284" n={9} gap={12} />
        {/* The popover, over the table rather than beside it. */}
        <rect x="8" y="54" width="126" height="104" rx="6" className="fig__pop" />
        {Array.from({ length: 6 }, (_, i) => (
          <g key={i}>
            <rect x="18" y={66 + i * 15} width="9" height="9" rx="2.5" className={i < 3 ? 'fig__check' : 'fig__box'} />
            <rect x="33" y={69 + i * 15} width={i > 3 ? 62 : 78} height="4" rx="2" className="fig__row" />
            {i > 3 && <rect x="100" y={68 + i * 15} width="24" height="6" rx="3" className="fig__bar" />}
          </g>
        ))}
      </Shell>
    </svg>
  )
}

/** Where the app puts things: the rail, the bar, the page. */
export function FigShell() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fig" role="img" aria-label="The app: reports listed down the left, brand and date across the top, the page below">
      <Shell>
        {Array.from({ length: 5 }, (_, i) => (
          <rect key={i} x="12" y={40 + i * 16} width="10" height="6" rx="3" className={i === 0 ? 'fig__bar' : 'fig__row'} />
        ))}
        <Filters y="8" />
        <rect x="36" y="36" width="276" height="150" rx="5" className="fig__panel" />
        <rect x="48" y="50" width="120" height="7" rx="3.5" className="fig__row fig__row--head" />
        <rect x="48" y="63" width="176" height="5" rx="2.5" className="fig__row" />
      </Shell>
    </svg>
  )
}

/** A figure with its caption, so the drawings sit in the prose consistently. */
export function Figure({ tone = 'green', caption, children }) {
  return (
    <figure className={`fig__wrap fig__wrap--${tone}`}>
      {children}
      {caption && <figcaption className="fig__caption">{caption}</figcaption>}
    </figure>
  )
}
