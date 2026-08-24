import { useCallback, useEffect, useState } from 'react'
import { api, fmtInt, fmtPct } from '../api.js'
import { Panel, ChartSkeleton, Pill, Empty } from './ui.jsx'
import { IconRefresh, IconChevron } from './Icons.jsx'
import { BrandTag } from './BrandTag.jsx'

/**
 * A review of how the forecast is built, brand by brand.
 *
 * The digest says what the forecast predicted. This says what is wrong with the
 * way it predicts — problems in the measures and in the shape of the data that
 * reading the numbers will never reveal.
 *
 * Every finding carries its evidence and the change that would fix it, because
 * a review that only lists problems is a complaint. Findings are checked
 * against the live model rather than asserted from reading the DAX, so a
 * formula that looks wrong but never meets the data that would make it wrong
 * stays quiet.
 */

const SEVERITY = {
  high: { tone: 'red', label: 'Worth fixing' },
  medium: { tone: 'amber', label: 'Worth reviewing' },
  low: { tone: 'slate', label: 'Minor' },
}

const order = { high: 0, medium: 1, low: 2 }

function Finding({ finding }) {
  const [open, setOpen] = useState(false)
  const meta = SEVERITY[finding.severity] ?? SEVERITY.low

  return (
    <li className={`review__item review__item--${finding.severity}`}>
      <button type="button" className="review__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Pill tone={meta.tone}>{meta.label}</Pill>
        <span className="review__title">{finding.title}</span>
        <span className={`review__caret${open ? ' review__caret--open' : ''}`} aria-hidden="true">
          <IconChevron size={13} />
        </span>
      </button>

      {open && (
        <div className="review__body">
          <div className="review__meta">
            {finding.area && <code className="review__area">{finding.area}</code>}
            {/* Whether this was asked of the live model or read from the .pbip
                in the repo. A file-read finding can already be fixed in the
                service, and saying so is the difference between a review that
                is trusted and one that is argued with. */}
            {finding.basis && (
              <span className={`review__basis review__basis--${finding.basis.replace(' ', '-')}`}>
                {finding.basis === 'measured'
                  ? 'Measured against the live model'
                  : 'Read from the model file in this repo — may already be fixed in the service'}
              </span>
            )}
          </div>
          {finding.evidencePerBrand ? (
            // Shared wording, but the numbers are each brand's own.
            <ul className="review__evidenceList">
              {finding.evidencePerBrand.map((e) => (
                <li key={e.brand}>
                  <BrandTag code={e.brand} />
                  <span>{e.evidence}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="review__evidence">{finding.evidence}</p>
          )}
          <div className="review__pair">
            <div>
              <h4>{finding.kind === 'improve' ? 'What it costs' : 'Why it happens'}</h4>
              <p>{finding.why ?? finding.detail}</p>
            </div>
            <div>
              <h4>{finding.kind === 'improve' ? 'The change to make' : 'What would fix it'}</h4>
              <p>{finding.fix}</p>
            </div>
          </div>
        </div>
      )}
    </li>
  )
}

function BrandReview({ brand, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  const counts = (brand.findings ?? []).reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1
    return acc
  }, {})
  const sorted = [...(brand.findings ?? [])].sort(
    (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
  )
  // Kept apart from the defects above on purpose. "This is wrong" and "this
  // could be better" are different jobs for whoever opens the model, and mixing
  // them buries the second kind under the first.
  const improvements = [...(brand.improvements ?? [])].sort(
    (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
  )

  return (
    <section className="review__brand">
      <button type="button" className="review__brandHead" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <BrandTag code={brand.brand} />
        <span className="review__brandName">{brand.brandLabel}</span>

        {brand.error ? (
          <Pill tone="red">could not be read</Pill>
        ) : (
          <>
            <span className="review__stat">
              <b>{fmtPct(brand.accuracy)}</b> accuracy
            </span>
            {brand.soldWithNoForecast?.lines > 0 && (
              <span className="review__stat">
                <b>{fmtInt(brand.soldWithNoForecast.lines)}</b> lines sold unforecast
              </span>
            )}
            <span className="review__counts">
              {counts.high > 0 && <Pill tone="red">{counts.high}</Pill>}
              {counts.medium > 0 && <Pill tone="amber">{counts.medium}</Pill>}
              {counts.low > 0 && <Pill tone="slate">{counts.low}</Pill>}
              {improvements.length > 0 && (
                <Pill tone="green">{improvements.length} to improve</Pill>
              )}
            </span>
          </>
        )}

        <span className={`review__caret${open ? ' review__caret--open' : ''}`} aria-hidden="true">
          <IconChevron size={13} />
        </span>
      </button>

      {open && !brand.error && sorted.length === 0 && improvements.length === 0 && (
        <p className="review__nothing">
          Nothing specific to this brand — everything it reports is shared with the others, listed
          above.
        </p>
      )}

      {open && !brand.error && (
        <>
          {sorted.length > 0 && (
            <>
              <h3 className="review__group">What is wrong</h3>
              <ul className="review__list">
                {sorted.map((f) => (
                  <Finding key={f.id ?? f.code ?? f.title} finding={f} />
                ))}
              </ul>
            </>
          )}

          {improvements.length > 0 && (
            <>
              <h3 className="review__group">
                How to improve accuracy
                <span>
                  Every unit forecast is Incidence Rate × (Sales ÷ AOV), so these are the two
                  places a change moves the number.
                </span>
              </h3>
              <ul className="review__list">
                {improvements.map((f) => (
                  <Finding key={f.id ?? f.title} finding={f} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}

/** What every model does the same way, said once. */
function CommonSection({ title, blurb, findings, brandCount }) {
  if (!findings?.length) return null
  const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
  return (
    <section className="review__common">
      <h3 className="review__group">
        {title}
        <span>{blurb}</span>
      </h3>
      <ul className="review__list">
        {sorted.map((f) => (
          <Finding key={f.id ?? f.code ?? f.title} finding={f} />
        ))}
      </ul>
    </section>
  )
}

export function ModelReview() {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async (refresh) => {
    setBusy(true)
    try {
      setData(await api.admin.modelReview(refresh))
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    load(false)
  }, [load])

  const brands = data?.brands ?? []
  const commonFindings = data?.commonFindings ?? []
  const commonImprovements = data?.commonImprovements ?? []
  const brandCount = data?.brandCount ?? brands.length

  const countHigh = (list) => list.filter((f) => f.severity === 'high').length
  const high =
    countHigh(commonFindings) + brands.reduce((n, b) => n + countHigh(b.findings ?? []), 0)
  const total =
    commonFindings.length + brands.reduce((n, b) => n + (b.findings ?? []).length, 0)
  const ideas =
    commonImprovements.length + brands.reduce((n, b) => n + (b.improvements ?? []).length, 0)

  return (
    <Panel
      title="How the forecast is built"
      count={busy ? undefined : `${total} findings`}
      sub={
        busy
          ? 'Reading every model…'
          : data?.window
            ? `Checked against ${data.window.from} to ${data.window.to} · ${high} worth fixing · ${ideas} ways to improve accuracy`
            : undefined
      }
      tools={
        <button type="button" className="btn" onClick={() => load(true)} disabled={busy}>
          <IconRefresh size={12} />
          Re-check
        </button>
      }
    >
      {busy ? (
        <ChartSkeleton height={240} />
      ) : error ? (
        <p className="digest__error">{error}</p>
      ) : brands.length === 0 ? (
        <Empty title="Nothing to review" />
      ) : (
        <>
          <p className="review__intro">
            The models were built from one template, so most of what is true of one is true of all
            of them. Anything shared is listed once below; each brand then shows only what is
            particular to it. Every entry carries its evidence and the exact DAX change.
          </p>

          <CommonSection
            title={`Every brand · what is wrong`}
            blurb={`Present in all ${brandCount} models. Fixing the template fixes all of them.`}
            findings={commonFindings}
          />

          <CommonSection
            title={`Every brand · how to improve accuracy`}
            blurb={`Each unit forecast is Incidence Rate × (Sales ÷ AOV), so these are the two places a change moves the number.`}
            findings={commonImprovements}
          />

          <h3 className="review__group">
            Particular to one brand
            <span>
              {brands.some((b) => (b.findings ?? []).length || (b.improvements ?? []).length)
                ? 'Everything below is true of that brand and not of the others.'
                : 'Nothing here — every finding applies to all of them.'}
            </span>
          </h3>
          <div className="review__brands">
            {brands.map((b, i) => (
              <BrandReview key={b.brand} brand={b} defaultOpen={i === 0} />
            ))}
          </div>
        </>
      )}
    </Panel>
  )
}
