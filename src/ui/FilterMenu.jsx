// Column filter dropdown: search, a checklist of distinct values plus
// (Blanks), and one condition. Applying writes a filter spec to the
// engine (one undo step); the grid then hides non-matching rows.
import { useEffect, useMemo, useRef, useState } from 'react'
import { columnLabel } from '../engine/address.js'

const MAX_LISTED = 300
const CONDITIONS = [
    { op: '', label: 'No condition' },
    { op: 'contains', label: 'Text contains' },
    { op: 'gt', label: 'Greater than' },
    { op: 'lt', label: 'Less than' },
    { op: 'isEmpty', label: 'Is empty' },
    { op: 'notEmpty', label: 'Is not empty' },
]

export function FilterMenu({ engine, col, anchor, onClose }) {
    const values = useMemo(() => engine.getFilterValues(col), [engine, col])
    const current = engine.getFilter(col)
    const [checked, setChecked] = useState(() => new Set(current?.values ?? values.map(v => v.key)))
    const [search, setSearch] = useState('')
    const [op, setOp] = useState(current?.condition?.op ?? '')
    const [opValue, setOpValue] = useState(current?.condition?.value ?? '')
    const ref = useRef(null)

    useEffect(() => {
        const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        // Attach after the pointer event that opened the menu has finished,
        // otherwise that same event closes it again.
        const timer = setTimeout(() => document.addEventListener('pointerdown', onDown), 0)
        document.addEventListener('keydown', onKey)
        return () => {
            clearTimeout(timer)
            document.removeEventListener('pointerdown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [onClose])

    const needle = search.trim().toLowerCase()
    const matching = needle ? values.filter(v => v.label.toLowerCase().includes(needle)) : values
    const listed = matching.slice(0, MAX_LISTED)

    function toggle(key) {
        setChecked(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    function setAll(on) {
        setChecked(prev => {
            const next = new Set(prev)
            for (const v of matching) {
                if (on) next.add(v.key)
                else next.delete(v.key)
            }
            return next
        })
    }

    function apply() {
        const all = values.every(v => checked.has(v.key))
        const condition = op ? { op, value: opValue } : null
        engine.setFilter(col, { values: all ? null : [...checked], condition })
        onClose()
    }

    function clear() {
        engine.setFilter(col, null)
        onClose()
    }

    const needsValue = op === 'contains' || op === 'gt' || op === 'lt'
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 268))
    const top = Math.min(anchor.top, window.innerHeight - 440)

    return (
        <div className="filter-menu" ref={ref} style={{ left, top }} role="dialog" aria-label={`Filter column ${columnLabel(col)}`}>
            <div className="filter-title">Filter by values · {engine.getText(0, col) || columnLabel(col)}</div>
            <input className="filter-search" autoFocus placeholder="Search values" value={search} onChange={e => setSearch(e.target.value)} />
            <div className="filter-links">
                <button type="button" onClick={() => setAll(true)}>Select all</button>
                <button type="button" onClick={() => setAll(false)}>Clear</button>
                <span>{values.length} values</span>
            </div>
            <div className="filter-list">
                {listed.map(v => (
                    <label key={v.key} className="filter-item">
                        <input type="checkbox" checked={checked.has(v.key)} onChange={() => toggle(v.key)} />
                        <span className={v.key === '' ? 'blanks' : ''}>{v.label}</span>
                        <span className="filter-count">{v.count}</span>
                    </label>
                ))}
                {matching.length > MAX_LISTED && <div className="filter-more">{matching.length - MAX_LISTED} more — refine the search</div>}
            </div>
            <div className="filter-title">Filter by condition</div>
            <div className="filter-condition">
                <select value={op} onChange={e => setOp(e.target.value)}>
                    {CONDITIONS.map(c => <option key={c.op} value={c.op}>{c.label}</option>)}
                </select>
                {needsValue && <input value={opValue} onChange={e => setOpValue(e.target.value)} placeholder="Value" />}
            </div>
            <div className="filter-actions">
                <button type="button" onClick={clear} disabled={!current}>Clear filter</button>
                <span className="spacer" />
                <button type="button" onClick={onClose}>Cancel</button>
                <button type="button" className="primary" onClick={apply}>OK</button>
            </div>
        </div>
    )
}
