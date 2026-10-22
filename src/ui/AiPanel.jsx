// Ctrl+K side panel: prompt → provider → validated action → result card.
// The model only ever proposes an action; every number on a card comes
// from executeQuery over the sheet's computed values (never from the model).
import { useEffect, useRef, useState } from 'react'
import { runAiRequest } from '../ai/runRequest.js'
import { executeQuery } from '../ai/queryExecutor.js'
import { buildSheetContext } from '../ai/context.js'
import { describeQuery } from '../ai/describe.js'
import { cellAddress, parseCellAddress, rangeAddress } from '../engine/address.js'
import { FormatCard } from './FormatCard.jsx'
import { PlanToggle } from './PlanToggle.jsx'
import { perf } from './perf.js'

const HISTORY_TURNS = 6
const PREVIEW_ROWS = 100
const EXAMPLES = [
    'What is the total sales by region?',
    'Top 3 sales reps by total sales',
    'How many orders were placed in February 2024?',
    'Format this as a clean table',
]

let nextId = 1

function sheetContext(engine, selection) {
    const used = engine.getUsedRange()
    return buildSheetContext(engine.getTable(), {
        range: used ? rangeAddress(used) : 'A1',
        selection: selection ? rangeAddress(selection) : null,
    })
}

function runQuery(engine, plan) {
    const t0 = performance.now()
    const result = executeQuery(plan, engine.getTable())
    const ms = performance.now() - t0
    perf.record('query', ms)
    return { result, ms }
}

export function AiPanel({ engine, provider, selection, onClose, onSelectRange }) {
    const [messages, setMessages] = useState([])
    const [busy, setBusy] = useState(false)
    const inputRef = useRef(null)
    const listRef = useRef(null)

    useEffect(() => { inputRef.current?.focus() }, [])
    useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    }, [messages])

    const update = (id, patch) => setMessages(ms => ms.map(m => (m.id === id ? { ...m, ...patch } : m)))

    async function send(text) {
        const prompt = text.trim()
        if (!prompt || busy) return
        const history = []
        for (const m of messages.slice(-HISTORY_TURNS * 2)) {
            if (m.role === 'user') history.push({ role: 'user', content: m.text })
            else if (m.rawText) history.push({ role: 'assistant', content: m.rawText })
        }
        const userMsg = { id: nextId++, role: 'user', text: prompt }
        const pending = { id: nextId++, role: 'assistant', kind: 'pending' }
        setMessages(ms => [...ms, userMsg, pending])
        setBusy(true)
        if (inputRef.current) inputRef.current.value = ''
        try {
            const res = await runAiRequest({ provider, prompt, context: sheetContext(engine, selection), history })
            if (!res.ok) {
                update(pending.id, { kind: 'error', error: res.error, detail: res.detail, rawText: res.rawText })
                return
            }
            const action = res.action
            if (action.type === 'clarify') {
                update(pending.id, { kind: 'clarify', action, rawText: res.rawText })
            } else if (action.type === 'query') {
                const { result, ms } = runQuery(engine, action)
                const used = engine.getUsedRange()
                const insertAt = cellAddress(0, used ? used.c2 + 2 : 0)
                update(pending.id, { kind: 'query', action, rawText: res.rawText, result, ms, insertAt })
            } else if (action.type === 'format_sheet') {
                update(pending.id, { kind: 'format', action, rawText: res.rawText })
            }
        } finally {
            setBusy(false)
        }
    }

    function onKeyDown(e) {
        e.stopPropagation()
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send(e.target.value)
        } else if (e.key === 'Escape') {
            onClose()
        }
    }

    return (
        <aside className="ai-panel" aria-label="Ask your data" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
            <header className="ai-header">
                <strong>Ask your data</strong>
                <span className="ai-provider" title="Set VITE_AI_PROVIDER in .env.local">provider: {provider.name}</span>
                <button type="button" className="ai-close" onClick={onClose} title="Close (Esc)">✕</button>
            </header>
            <div className="ai-messages" ref={listRef}>
                {messages.length === 0 && (
                    <div className="ai-empty">
                        <p>Ask a question about the sheet, or ask for formatting. The model returns a plan; the numbers are computed here.</p>
                        {EXAMPLES.map(x => <button key={x} type="button" className="ai-example" onClick={() => send(x)}>{x}</button>)}
                    </div>
                )}
                {messages.map(m => (m.role === 'user'
                    ? <div key={m.id} className="ai-user">{m.text}</div>
                    : <AssistantCard key={m.id} m={m} engine={engine} update={patch => update(m.id, patch)} onSelectRange={onSelectRange} />
                ))}
            </div>
            <div className="ai-input">
                <textarea ref={inputRef} rows={2} placeholder="e.g. Total sales by region (Enter to send)" onKeyDown={onKeyDown} disabled={busy} />
                <button type="button" className="primary" disabled={busy} onClick={() => send(inputRef.current.value)}>{busy ? '…' : 'Ask'}</button>
            </div>
        </aside>
    )
}

function AssistantCard({ m, engine, update, onSelectRange }) {
    if (m.kind === 'pending') return <div className="ai-card ai-pending">Thinking…</div>
    if (m.kind === 'error') {
        return (
            <div className="ai-card ai-error" role="alert">
                <div className="ai-card-title">{errorTitle(m.error)}</div>
                <div className="ai-detail">{m.detail}</div>
                {m.rawText && (
                    <>
                        <button type="button" className="ai-link" onClick={() => update({ showRaw: !m.showRaw })}>{m.showRaw ? 'Hide' : 'Show'} model output</button>
                        {m.showRaw && <pre className="ai-plan">{m.rawText}</pre>}
                    </>
                )}
                <div className="ai-note">Nothing in the sheet was changed.</div>
            </div>
        )
    }
    if (m.kind === 'clarify') {
        return (
            <div className="ai-card">
                <div className="ai-card-title">The model needs more information</div>
                <div>{m.action.question}</div>
                <PlanToggle m={m} update={update} />
            </div>
        )
    }
    if (m.kind === 'format') return <FormatCard m={m} engine={engine} update={update} />
    return <QueryCard m={m} engine={engine} update={update} onSelectRange={onSelectRange} />
}

function errorTitle(code) {
    switch (code) {
        case 'READ_ONLY': return 'Refused: questions are read-only'
        case 'INVALID_RESPONSE': return 'The model returned something that is not a valid action'
        case 'UNKNOWN_OP': return 'The plan used an unknown filter operator'
        case 'UNKNOWN_FN': return 'The plan used an unknown aggregate'
        case 'PROVIDER_ERROR': return 'The AI provider failed'
        default: return code
    }
}

function formatValue(v) {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
    return String(v)
}

function QueryCard({ m, engine, update, onSelectRange }) {
    const { result } = m
    if (result.error) {
        const columns = engine.getTable().header.filter(h => h.trim() !== '')
        const unknown = result.error === 'UNKNOWN_COLUMN' || result.error === 'UNKNOWN_SORT_COLUMN'
        return (
            <div className="ai-card ai-error" role="alert">
                <div className="ai-card-title">{unknown ? 'Which column did you mean?' : errorTitle(result.error)}</div>
                <div className="ai-detail">{result.detail}</div>
                {unknown && <div className="ai-note">There is no column “{result.detail.split(':').slice(1).join(':')}”. Available: {columns.join(', ')}. Rephrase with one of these; nothing was guessed.</div>}
                <PlanToggle m={m} update={update} />
            </div>
        )
    }

    function rerun() {
        const { result: next, ms } = runQuery(engine, m.action)
        update({ result: next, ms, rerunAt: new Date().toLocaleTimeString() })
    }

    function insert() {
        const at = parseCellAddress(m.insertAt)
        if (!at || at.row >= engine.rows || at.col >= engine.cols) {
            update({ insertError: `“${m.insertAt}” is not a cell address` })
            return
        }
        const matrix = [result.columns, ...result.rows.map(row => row.map(v => (v === null ? '' : String(v))))]
        engine.setCells(at.row, at.col, matrix, 'Insert query result')
        update({ insertError: null, inserted: `Inserted ${matrix.length} × ${result.columns.length} at ${m.insertAt}` })
        onSelectRange({ r1: at.row, c1: at.col, r2: at.row + matrix.length - 1, c2: at.col + result.columns.length - 1 })
    }

    const shown = result.rows.slice(0, PREVIEW_ROWS)
    return (
        <div className="ai-card">
            <div className="ai-description">{describeQuery(m.action)}</div>
            <div className="ai-table-wrap">
                <table className="ai-table">
                    <thead><tr>{result.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                        {shown.map((row, i) => (
                            <tr key={i}>{row.map((v, j) => <td key={j} className={typeof v === 'number' ? 'num' : ''}>{formatValue(v)}</td>)}</tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="ai-meta">
                {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
                {result.truncated && ' (limited)'}
                {result.rows.length > PREVIEW_ROWS && ` · showing first ${PREVIEW_ROWS}`}
                {' · '}computed in {m.ms.toFixed(1)} ms{m.rerunAt && ` · re-run ${m.rerunAt}`}
            </div>
            <div className="ai-actions">
                <button type="button" onClick={rerun} title="Run the same plan again over the current sheet (no model call)">Re-run</button>
                <span className="ai-insert">
                    <input value={m.insertAt} onChange={e => update({ insertAt: e.target.value.toUpperCase() })} aria-label="Insert at cell" />
                    <button type="button" onClick={insert} title="Write the result into the sheet (one undo step)">Insert into sheet</button>
                </span>
            </div>
            {m.insertError && <div className="ai-detail">{m.insertError}</div>}
            {m.inserted && <div className="ai-note">{m.inserted}. Ctrl+Z removes it.</div>}
            <PlanToggle m={m} update={update} />
        </div>
    )
}
