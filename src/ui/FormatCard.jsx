// Result card for a format_sheet action: a plain-words preview, then
// Apply (one undo step) or Discard. The plan is computed by the pure
// planner against the current sheet; the engine applies it.
import { useState } from 'react'
import { planFormat } from '../ai/formatPlan.js'
import { describeFormat } from '../ai/describe.js'
import { measureText } from '../grid/draw.js'
import { perf } from './perf.js'
import { PlanToggle } from './PlanToggle.jsx'

let measureCtx = null
function measure(text, style) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
    return measureText(measureCtx, text, style)
}

function summarize(plan) {
    if (plan.result !== 'OK') return plan.message || plan.result
    const parts = []
    if (plan.styles.length) parts.push(`${plan.styles.length.toLocaleString('en-US')} cell styles`)
    if (plan.widths.length) parts.push(`${plan.widths.length} column widths`)
    if (plan.frozenRows !== undefined) parts.push(plan.frozenRows === 0 ? 'unfreeze rows' : `freeze ${plan.frozenRows} row${plan.frozenRows === 1 ? '' : 's'}`)
    return 'Will change ' + parts.join(', ')
}

export function FormatCard({ m, engine, update }) {
    // Dry run when the card first renders, so the preview says what Apply would do.
    const [preview] = useState(() => planFormat(m.action, engine.getFormatSheet(), measure))

    function apply() {
        const t0 = performance.now()
        const plan = planFormat(m.action, engine.getFormatSheet(), measure)
        let status = plan.result
        if (plan.result === 'OK') {
            const changed = engine.applyFormat(plan, 'AI format')
            if (!changed) status = 'NO_CHANGES'
        }
        const ms = performance.now() - t0
        perf.record('format', ms)
        update({ status, message: plan.message, ms })
    }

    const done = m.status !== undefined
    return (
        <div className="ai-card">
            <div className="ai-card-title">Format preview</div>
            <div className="ai-description">{describeFormat(m.action)}</div>
            <div className={`ai-meta ${preview.result !== 'OK' ? 'warn' : ''}`}>
                {preview.result !== 'OK' && <strong>{preview.result}: </strong>}{summarize(preview)}
            </div>
            {!done && (
                <div className="ai-actions">
                    <button type="button" className="primary" onClick={apply}>Apply</button>
                    <button type="button" onClick={() => update({ status: 'DISCARDED' })}>Discard</button>
                </div>
            )}
            {m.status === 'OK' && <div className="ai-note">Applied in {m.ms.toFixed(1)} ms. Ctrl+Z reverts it in one step.</div>}
            {m.status === 'NO_CHANGES' && <div className="ai-note"><strong>NO_CHANGES</strong>: nothing to change, so no undo step was added.</div>}
            {m.status === 'OUT_OF_RANGE' && <div className="ai-detail" role="alert"><strong>OUT_OF_RANGE</strong>: refused, nothing was changed.</div>}
            {m.status === 'DISCARDED' && <div className="ai-note">Discarded.</div>}
            <PlanToggle m={m} update={update} />
        </div>
    )
}
