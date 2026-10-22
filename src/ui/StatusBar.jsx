// Status line: filter status ("28 of 32 rows"), selection summary,
// last undo step and live performance numbers.
import { useSyncExternalStore } from 'react'
import { perf } from './perf.js'
import { toNum } from '../engine/values.js'

const MAX_SUMMARY_CELLS = 200000

function summarize(engine, sel) {
    const area = (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1)
    if (area < 2) return null
    const used = engine.getUsedRange()
    if (!used) return null
    const r2 = Math.min(sel.r2, used.r2)
    const c2 = Math.min(sel.c2, used.c2)
    if ((r2 - sel.r1 + 1) * (c2 - sel.c1 + 1) > MAX_SUMMARY_CELLS) return null
    let count = 0, numbers = 0, sum = 0
    for (let r = sel.r1; r <= r2; r++) {
        if (engine.isRowHidden(r)) continue
        for (let c = sel.c1; c <= c2; c++) {
            const text = engine.getText(r, c)
            if (text === '') continue
            count++
            const n = toNum(text)
            if (n !== null) { numbers++; sum += n }
        }
    }
    return { count, numbers, sum }
}

const fmt = (ms) => (ms === undefined || ms === null ? '–' : ms < 10 ? ms.toFixed(1) : Math.round(ms).toString())

let cached = null
let cachedVersion = 0
const subscribePerf = (l) => perf.subscribe(l)
const perfSnapshot = () => {
    // a new object only when a recorded action changed, so React can bail out
    const s = perf.stats()
    const key = JSON.stringify(s.actions) + s.firstPaint
    if (!cached || cached.key !== key) { cached = { key, actions: s.actions }; cachedVersion++ }
    return cachedVersion
}

export function StatusBar({ engine, selection, filterStatus, onClearFilters }) {
    useSyncExternalStore(subscribePerf, perfSnapshot)
    const summary = summarize(engine, selection)
    const stats = perf.stats()
    const actions = Object.entries(stats.actions)
    return (
        <div className="status-bar">
            {filterStatus.active && (
                <span className="status-filter">
                    {filterStatus.visible} of {filterStatus.total} rows
                    <button type="button" onClick={onClearFilters}>clear</button>
                </span>
            )}
            {summary && (
                <span>Count {summary.count}{summary.numbers > 0 && <> · Sum {Number(summary.sum.toFixed(2)).toLocaleString('en-US')}</>}</span>
            )}
            {engine.undoLabel() && <span className="status-dim">Last: {engine.undoLabel()}</span>}
            <span className="spacer" />
            <span className="status-dim" title="First canvas paint measured from navigation start / from app start; average and worst canvas paint over the last 120 frames">
                first paint {fmt(stats.firstPaint)} / {fmt(stats.firstPaintFromApp)} ms · frame {fmt(stats.avgFrame)} / {fmt(stats.maxFrame)} ms · commits {stats.commits}
            </span>
            {actions.length > 0 && (
                <span className="status-dim" title="Duration of the last run of each action">
                    {actions.map(([k, v]) => `${k} ${fmt(v)} ms`).join(' · ')}
                </span>
            )}
        </div>
    )
}
