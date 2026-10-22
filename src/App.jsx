import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { cellAddress, parseRangeAddress, rangeAddress } from './engine/address.js'
import { loadSampleSmall, loadSampleLarge, parseTsv } from './fixtures/loadSample.js'
import { Grid } from './ui/Grid.jsx'
import { FilterMenu } from './ui/FilterMenu.jsx'
import { AiPanel } from './ui/AiPanel.jsx'
import { createProvider } from './ai/provider.js'
import { StatusBar } from './ui/StatusBar.jsx'
import { Toolbar } from './ui/Toolbar.jsx'
import { cellSelection, isMultiCell, makeSelection, rangeSelection } from './ui/selection.js'
import { perf, timed } from './ui/perf.js'

const TOTAL_ROWS = 100000
const TOTAL_COLS = 200

export default function App() {
    // The engine owns all sheet state. React only subscribes to its version
    // number and keeps UI state (selection, editor, open menus).
    const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
    const version = useSyncExternalStore(engine.subscribe, () => engine.version)
    const [selection, setSelection] = useState(() => cellSelection(0, 0))
    const [editing, setEditing] = useState(null)
    const [filterMode, setFilterMode] = useState(false)
    const [filterMenu, setFilterMenu] = useState(null)
    const [aiOpen, setAiOpen] = useState(false)
    const [provider] = useState(() => createProvider())
    const gridRef = useRef(null)
    const editorRef = useRef(null)
    const barRef = useRef(null)
    const nameRef = useRef(null)

    // App-wide shortcuts: Ctrl+K toggles the AI panel; Ctrl+Z / Ctrl+Y undo
    // and redo from anywhere except a text field (which keeps its own undo).
    useEffect(() => {
        const onKey = (e) => {
            if (!(e.metaKey || e.ctrlKey)) return
            const k = e.key.toLowerCase()
            if (k === 'k') {
                e.preventDefault()
                setAiOpen(open => !open)
                return
            }
            const tag = e.target.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
            if (k === 'z' || k === 'y') {
                e.preventDefault()
                const redoing = k === 'y' || e.shiftKey
                timed(redoing ? 'redo' : 'undo', () => (redoing ? engine.redo() : engine.undo()))
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [engine])

    // Counts commits of the app shell, shown in the status bar.
    useEffect(() => { perf.commit() })

    const active = selection.active
    const activeStyle = engine.getStyle(active.r, active.c)

    // ── Selection and navigation ──

    const select = useCallback((sel, scroll = false) => {
        setSelection(sel)
        if (scroll) gridRef.current?.scrollIntoView(sel.focus.r, sel.focus.c)
    }, [])

    const selectionRange = useCallback(() => ({ r1: selection.r1, c1: selection.c1, r2: selection.r2, c2: selection.c2 }), [selection])

    function moveTo(r, c, extend = false) {
        r = Math.max(0, Math.min(engine.rows - 1, r))
        c = Math.max(0, Math.min(engine.cols - 1, c))
        select(extend ? makeSelection(selection.anchor, { r, c }) : cellSelection(r, c), true)
    }

    // Ctrl+Arrow: jump to the edge of the current block of data.
    function jump(r, c, dr, dc) {
        const filled = (rr, cc) => engine.getText(rr, cc) !== ''
        const inside = (rr, cc) => rr >= 0 && cc >= 0 && rr < engine.rows && cc < engine.cols
        let nr = r + dr, nc = c + dc
        if (!inside(nr, nc)) return { r, c }
        if (filled(r, c) && filled(nr, nc)) {
            while (inside(nr + dr, nc + dc) && filled(nr + dr, nc + dc)) { nr += dr; nc += dc }
            return { r: nr, c: nc }
        }
        while (inside(nr, nc) && !filled(nr, nc)) {
            if (!inside(nr + dr, nc + dc)) return { r: nr, c: nc }
            nr += dr; nc += dc
        }
        return { r: nr, c: nc }
    }

    // ── Editing ──

    function startEdit(r, c, typed = null, source = 'cell') {
        const raw = engine.getCell(r, c).raw
        const initial = typed ?? raw
        if (selection.active.r !== r || selection.active.c !== c) select(cellSelection(r, c), true)
        setEditing({ r, c, initial, mode: typed !== null ? 'enter' : 'edit', source })
        if (barRef.current) barRef.current.value = initial
    }

    useEffect(() => {
        if (!editing || editing.source !== 'cell') return
        const input = editorRef.current
        if (!input) return
        input.focus()
        const end = input.value.length
        input.setSelectionRange(end, end)
    }, [editing])

    function currentEditValue() {
        if (!editing) return ''
        return editing.source === 'bar' ? barRef.current?.value ?? '' : editorRef.current?.value ?? ''
    }

    function commitEdit(dr = 0, dc = 0) {
        if (!editing) return
        const { r, c } = editing
        const value = currentEditValue()
        setEditing(null)
        perf.untilPaint('edit → paint')
        timed('edit', () => engine.setCell(r, c, value))
        moveTo(r + dr, c + dc)
        gridRef.current?.focus()
    }

    function cancelEdit() {
        setEditing(null)
        if (barRef.current) barRef.current.value = engine.getCell(active.r, active.c).raw
        gridRef.current?.focus()
    }

    function onEditorKeyDown(e) {
        e.stopPropagation()
        const arrows = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(e.shiftKey ? -1 : 1, 0) }
        else if (e.key === 'Tab') { e.preventDefault(); commitEdit(0, e.shiftKey ? -1 : 1) }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
        else if (arrows[e.key] && editing?.mode === 'enter') { e.preventDefault(); commitEdit(...arrows[e.key]) }
    }

    // Keep the formula bar and the in-cell editor showing the same text,
    // without React state per keystroke.
    function onEditorInput(e) {
        if (barRef.current) barRef.current.value = e.target.value
    }

    function onBarInput(e) {
        if (!editing) startEdit(active.r, active.c, null, 'bar')
        if (editorRef.current) editorRef.current.value = e.target.value
    }

    function onBarKeyDown(e) {
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(1, 0) }
        else if (e.key === 'Tab') { e.preventDefault(); commitEdit(0, 1) }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
    }

    function onBarFocus() {
        if (!editing) startEdit(active.r, active.c, null, 'bar')
    }

    // ── Commands ──

    const applyStyle = (patch) => timed('format', () => engine.setStyle(selectionRange(), patch))

    function clearSelection() {
        timed('clear', () => engine.clearRange(selectionRange()))
    }

    function fillDown() {
        if (selection.r2 === selection.r1) return
        timed('fill', () => engine.fill({ ...selectionRange(), r2: selection.r1 }, selectionRange()))
    }

    function fillRight() {
        if (selection.c2 === selection.c1) return
        timed('fill', () => engine.fill({ ...selectionRange(), c2: selection.c1 }, selectionRange()))
    }

    function selectUsed() {
        const used = engine.getUsedRange()
        if (used) select(rangeSelection(used))
    }

    function sortColumn(c) {
        const sel = isMultiCell(selection) && selection.kind === 'cells' ? selectionRange() : null
        timed('sort', () => engine.sortByColumn(c, sel))
    }

    function undo() { if (editing) return; timed('undo', () => engine.undo()) }
    function redo() { if (editing) return; timed('redo', () => engine.redo()) }

    function insertRows() {
        const count = selection.kind === 'rows' ? selection.r2 - selection.r1 + 1 : 1
        engine.insertRows(selection.r1, count)
    }
    function deleteRows() {
        const count = selection.kind === 'rows' ? selection.r2 - selection.r1 + 1 : 1
        engine.deleteRows(selection.r1, count)
    }
    function insertColumns() {
        const count = selection.kind === 'cols' ? selection.c2 - selection.c1 + 1 : 1
        engine.insertColumns(selection.c1, count)
    }
    function deleteColumns() {
        const count = selection.kind === 'cols' ? selection.c2 - selection.c1 + 1 : 1
        engine.deleteColumns(selection.c1, count)
    }

    async function loadSample(loader, name) {
        setEditing(null)
        const t0 = performance.now()
        await loader(engine)
        perf.record(name, performance.now() - t0)
        select(cellSelection(0, 0), true)
    }

    // ── Keyboard (grid focused, not editing) ──

    function onGridKeyDown(e) {
        if (editing) return
        const ctrl = e.metaKey || e.ctrlKey
        const key = e.key
        const rowLayout = gridRef.current.rowLayout()
        const colLayout = gridRef.current.colLayout()
        const { r, c } = e.shiftKey ? selection.focus : selection.active
        const handled = () => e.preventDefault()

        if (ctrl) {
            const k = key.toLowerCase()
            if (k === 'a') { handled(); selectUsed() }
            else if (k === 'b') { handled(); applyStyle({ bold: !activeStyle.bold }) }
            else if (k === 'i') { handled(); applyStyle({ italic: !activeStyle.italic }) }
            else if (k === 'u') { handled(); applyStyle({ underline: !activeStyle.underline }) }
            else if (k === 'd') { handled(); fillDown() }
            else if (k === 'r') { handled(); fillRight() }
            else if (key === 'Home') { handled(); moveTo(0, 0, e.shiftKey) }
            else if (key === 'End') {
                handled()
                const used = engine.getUsedRange()
                if (used) moveTo(used.r2, used.c2, e.shiftKey)
            } else if (key.startsWith('Arrow')) {
                handled()
                const d = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key]
                const to = jump(r, c, ...d)
                moveTo(to.r, to.c, e.shiftKey)
            }
            return
        }
        switch (key) {
            case 'ArrowDown': handled(); moveTo(rowLayout.step(r, 1), c, e.shiftKey); break
            case 'ArrowUp': handled(); moveTo(rowLayout.step(r, -1), c, e.shiftKey); break
            case 'ArrowRight': handled(); moveTo(r, colLayout.step(c, 1), e.shiftKey); break
            case 'ArrowLeft': handled(); moveTo(r, colLayout.step(c, -1), e.shiftKey); break
            case 'PageDown': handled(); moveTo(r + gridRef.current.pageRows(), c, e.shiftKey); break
            case 'PageUp': handled(); moveTo(r - gridRef.current.pageRows(), c, e.shiftKey); break
            case 'Home': handled(); moveTo(r, 0, e.shiftKey); break
            case 'Tab': handled(); moveTo(selection.active.r, colLayout.step(selection.active.c, e.shiftKey ? -1 : 1)); break
            case 'Enter':
            case 'F2': handled(); startEdit(selection.active.r, selection.active.c); break
            case 'Delete':
            case 'Backspace': handled(); clearSelection(); break
            default:
                if (key.length === 1 && !e.altKey) {
                    handled()
                    startEdit(selection.active.r, selection.active.c, key)
                }
        }
    }

    // Copy / paste as tab-separated text (one undo step for a paste).
    function onCopy(e) {
        if (editing) return
        const rows = []
        for (let r = selection.r1; r <= Math.min(selection.r2, selection.r1 + 10000); r++) {
            if (engine.isRowHidden(r)) continue
            const row = []
            for (let c = selection.c1; c <= selection.c2; c++) row.push(engine.getCell(r, c).raw)
            rows.push(row.join('\t'))
        }
        e.clipboardData.setData('text/plain', rows.join('\n'))
        e.preventDefault()
    }

    function onPaste(e) {
        if (editing) return
        const text = e.clipboardData.getData('text/plain')
        if (!text) return
        e.preventDefault()
        const matrix = parseTsv(text)
        timed('paste', () => engine.setCells(selection.active.r, selection.active.c, matrix))
        select(makeSelection(selection.active, {
            r: selection.active.r + matrix.length - 1,
            c: selection.active.c + Math.max(...matrix.map(row => row.length)) - 1,
        }))
    }

    // ── Name box ──

    function onNameKeyDown(e) {
        if (e.key === 'Enter') {
            e.preventDefault()
            const range = parseRangeAddress(e.target.value, engine.rows, engine.cols)
            if (range && range.r2 < engine.rows && range.c2 < engine.cols) {
                const sel = makeSelection({ r: range.r1, c: range.c1 }, { r: range.r2, c: range.c2 })
                setSelection(sel)
                gridRef.current?.scrollIntoView(range.r1, range.c1)
                gridRef.current?.focus()
            } else {
                e.target.select()
            }
        } else if (e.key === 'Escape') {
            gridRef.current?.focus()
        }
    }

    // ── Derived view state ──

    const table = engine.getTableRange()
    const filterStatus = engine.getFilterStatus()
    const showFilters = (filterMode || filterStatus.active) && table
    const filterButtons = showFilters
        ? {
            lastCol: table.c2,
            active: new Set(Array.from({ length: table.c2 + 1 }, (_, c) => c).filter(c => engine.getFilter(c))),
        }
        : null

    const selectionLabel = isMultiCell(selection) ? rangeAddress(selection) : cellAddress(active.r, active.c)
    const activeRaw = engine.getCell(active.r, active.c).raw

    return (
        <div className="app-wrapper">
            <Toolbar
                engine={engine}
                style={activeStyle}
                onStyle={applyStyle}
                onUndo={undo}
                onRedo={redo}
                onInsertRow={insertRows}
                onDeleteRow={deleteRows}
                onInsertColumn={insertColumns}
                onDeleteColumn={deleteColumns}
                onClear={clearSelection}
                filterMode={filterMode}
                onToggleFilters={() => setFilterMode(m => !m)}
                onClearFilters={() => engine.clearFilters()}
                onFreezeRow={() => engine.setFreeze({ rows: engine.frozenRows > 0 ? 0 : 1 })}
                onFreezeCol={() => engine.setFreeze({ cols: engine.frozenCols > 0 ? 0 : 1 })}
                onLoadSmall={() => loadSample(loadSampleSmall, 'load sales.tsv')}
                onLoadLarge={() => loadSample(loadSampleLarge, 'load sales-large.tsv')}
                extra={(
                    <div className="toolbar-group">
                        <button className={`toolbar-btn ${aiOpen ? 'active' : ''}`} onClick={() => setAiOpen(o => !o)} title="Ask your data (Ctrl+K)">✦ Ask AI</button>
                    </div>
                )}
            />

            <div className="formula-bar">
                <input
                    key={`name-${selectionLabel}`}
                    ref={nameRef}
                    className="name-box"
                    defaultValue={selectionLabel}
                    onKeyDown={onNameKeyDown}
                    onFocus={e => e.target.select()}
                    aria-label="Name box"
                    spellCheck={false}
                />
                <span className="fx">fx</span>
                <input
                    key={`bar-${active.r}-${active.c}-${version}`}
                    ref={barRef}
                    className="formula-bar-input"
                    defaultValue={editing ? editing.initial : activeRaw}
                    onInput={onBarInput}
                    onKeyDown={onBarKeyDown}
                    onFocus={onBarFocus}
                    aria-label="Formula bar"
                    spellCheck={false}
                />
            </div>

            <div className="workspace">
                <div className="grid-host" onKeyDown={onGridKeyDown} onCopy={onCopy} onPaste={onPaste}>
                    <Grid
                        gridRef={gridRef}
                        engine={engine}
                        selection={selection}
                        onSelect={select}
                        editing={editing}
                        editorRef={editorRef}
                        onEditorKeyDown={onEditorKeyDown}
                        onEditorInput={onEditorInput}
                        onStartEdit={(r, c) => startEdit(r, c)}
                        filterButtons={filterButtons}
                        onOpenFilter={(col, anchor) => setFilterMenu({ col, anchor })}
                        onSort={sortColumn}
                    />
                </div>
                {aiOpen && (
                    <AiPanel
                        engine={engine}
                        provider={provider}
                        selection={selection}
                        onClose={() => { setAiOpen(false); gridRef.current?.focus() }}
                        onSelectRange={range => { select(rangeSelection(range), true); gridRef.current?.focus() }}
                    />
                )}
            </div>

            <StatusBar engine={engine} version={version} selection={selection} filterStatus={filterStatus} onClearFilters={() => engine.clearFilters()} />

            {filterMenu && (
                <FilterMenu
                    key={filterMenu.col}
                    engine={engine}
                    col={filterMenu.col}
                    anchor={filterMenu.anchor}
                    onClose={() => { setFilterMenu(null); gridRef.current?.focus() }}
                />
            )}
        </div>
    )
}
