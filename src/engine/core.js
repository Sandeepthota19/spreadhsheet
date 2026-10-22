// ─────────────────────────────────────────────────────────────
//  Spreadsheet engine. Pure: no React, no DOM.
//
//  Data model (see DESIGN_NOTES.md for the full picture)
//    • Rows and columns have stable ids (identity.js). Positions are
//      derived; insert/delete/sort only edit the id order.
//    • cells   Map<key, Cell>   key = rowId * COL_STRIDE + colId
//              Cell = { raw: string|null, f: Formula|null, v: value }
//    • styles  Map<key, Style>  only non-default styles are stored
//    • Formula = { tpl, refs }: a shared parsed template plus this
//      cell's references bound to row/column ids. Text is rendered
//      from the ids' current positions, so references follow rows.
//    • Every mutation goes through a transaction that records
//      invertible ops; one transaction = one undo step.
//    • Recalculation is incremental: only the transitive dependents
//      of changed cells are re-evaluated, in dependency order, with
//      an explicit stack (no recursion limits on long chains).
// ─────────────────────────────────────────────────────────────

import { cellAddress, columnLabel, normaliseRange, rangeAddress } from './address.js'
import { parseFormula, evaluateTemplate, formatNumber, isError, ERR } from './formula.js'
import { toNum, norm, looksLikeTotalsRow } from './values.js'
import { createIdentityAxis } from './identity.js'
import { makeSeries } from './fill.js'
import { sortKey, compareKeys, EMPTY_ROW_KEY, compileFilter, isActiveFilter } from './sortFilter.js'
import { DEFAULT_STYLE, mergeStyle, sameStyle, isDefaultStyle } from './style.js'

export { DEFAULT_STYLE }

const MAX_UNDO_HISTORY = 100
const COL_STRIDE = 65536
// Styling more cells than this in one go is clamped to the used rows.
const MAX_STYLE_CELLS = 500000

export const DEFAULT_COL_WIDTH = 100
export const DEFAULT_ROW_HEIGHT = 24

const mod = (a, n) => ((a % n) + n) % n

export function createEngine(initialRows = 50, initialCols = 50) {
    const rowAxis = createIdentityAxis(initialRows)
    const colAxis = createIdentityAxis(initialCols)
    const cells = new Map()
    const styles = new Map()
    const colWidths = new Map()
    const rowHeights = new Map()
    const view = { frozenRows: 0, frozenCols: 0, filters: new Map(), sort: null }

    // Dependency graph: single-cell references are indexed exactly;
    // formulas with ranges are checked for containment when a cell changes.
    const dependents = new Map()
    const rangeFormulas = new Set()

    const undoStack = []
    const redoStack = []
    let tx = null
    const pendingDirty = new Set()
    let structural = null
    let dataVersion = 0
    let version = 0
    const listeners = new Set()
    let usedCache = null
    let hiddenCache = null

    // ── Keys and positions ──

    const keyOf = (rowId, colId) => rowId * COL_STRIDE + colId
    const rowIdOfKey = (key) => Math.floor(key / COL_STRIDE)
    const colIdOfKey = (key) => key % COL_STRIDE
    const keyAt = (r, c) => keyOf(rowAxis.idAt(r), colAxis.idAt(c))
    const axisOf = (name) => (name === 'row' ? rowAxis : colAxis)

    function inBounds(r, c) {
        return r >= 0 && c >= 0 && r < rowAxis.length && c < colAxis.length
    }

    // ── Formulas: binding, text, bounds ──

    function bindRef(ref) {
        if (ref.kind === 'cell') {
            return { kind: 'cell', row: rowAxis.idAt(ref.row), col: colAxis.idAt(ref.col), absRow: ref.absRow, absCol: ref.absCol }
        }
        return {
            kind: 'range',
            r1: rowAxis.idAt(ref.r1), c1: colAxis.idAt(ref.c1), r2: rowAxis.idAt(ref.r2), c2: colAxis.idAt(ref.c2),
            absR1: ref.absR1, absC1: ref.absC1, absR2: ref.absR2, absC2: ref.absC2,
        }
    }

    function refPart(rowId, colId, absRow, absCol) {
        const r = rowAxis.posOf(rowId)
        const c = colAxis.posOf(colId)
        if (r < 0 || c < 0) return null
        return (absCol ? '$' : '') + columnLabel(c) + (absRow ? '$' : '') + (r + 1)
    }

    function refText(ref) {
        if (ref.kind === 'cell') return refPart(ref.row, ref.col, ref.absRow, ref.absCol) ?? '#REF!'
        const a = refPart(ref.r1, ref.c1, ref.absR1, ref.absC1)
        const b = refPart(ref.r2, ref.c2, ref.absR2, ref.absC2)
        return a && b ? a + ':' + b : '#REF!'
    }

    function formulaText(f) {
        let s = ''
        for (const p of f.tpl.pieces) s += typeof p === 'number' ? refText(f.refs[p]) : p
        return s
    }

    /** Current positional bounds of a range ref, or null when it is #REF!. */
    function rangeBounds(ref) {
        const r1 = rowAxis.posOf(ref.r1), r2 = rowAxis.posOf(ref.r2)
        const c1 = colAxis.posOf(ref.c1), c2 = colAxis.posOf(ref.c2)
        if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return null
        return { r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: Math.min(c1, c2), c2: Math.max(c1, c2) }
    }

    // ── Cells ──

    function literalValue(raw) {
        const n = toNum(raw)
        return n === null ? raw : n
    }

    /** Build a cell record from typed text. Formula refs are bound at the cell's position. */
    function buildCell(raw) {
        if (raw === null || raw === undefined || String(raw).trim() === '') return undefined
        raw = String(raw)
        if (raw.startsWith('=') && raw.length > 1) {
            try {
                const tpl = parseFormula(raw)
                return { raw: null, f: { tpl, refs: tpl.refs.map(bindRef) }, v: null }
            } catch {
                return { raw, f: null, v: ERR.PARSE }
            }
        }
        return { raw, f: null, v: literalValue(raw) }
    }

    function rawOf(cell) {
        if (!cell) return ''
        return cell.f ? formulaText(cell.f) : cell.raw
    }

    /** What the grid shows before number formatting. */
    function textOf(cell) {
        if (!cell) return ''
        const v = cell.v
        if (isError(v)) return v.code
        if (!cell.f) return cell.raw
        if (v === null || v === undefined) return ''
        return typeof v === 'number' ? formatNumber(v) : String(v)
    }

    function shiftId(axis, id, delta, abs) {
        if (abs || delta === 0) return id
        const p = axis.posOf(id)
        return p < 0 ? -1 : axis.idAt(p + delta)
    }

    function shiftRef(ref, dr, dc) {
        if (ref.kind === 'cell') {
            return { ...ref, row: shiftId(rowAxis, ref.row, dr, ref.absRow), col: shiftId(colAxis, ref.col, dc, ref.absCol) }
        }
        return {
            ...ref,
            r1: shiftId(rowAxis, ref.r1, dr, ref.absR1), c1: shiftId(colAxis, ref.c1, dc, ref.absC1),
            r2: shiftId(rowAxis, ref.r2, dr, ref.absR2), c2: shiftId(colAxis, ref.c2, dc, ref.absC2),
        }
    }

    /** Copy a cell dr rows / dc columns away: relative references move, $-pinned ones stay. */
    function copyCell(cell, dr, dc) {
        if (!cell) return undefined
        if (!cell.f) return { raw: cell.raw, f: null, v: cell.v }
        return { raw: null, f: { tpl: cell.f.tpl, refs: cell.f.refs.map(ref => shiftRef(ref, dr, dc)) }, v: null }
    }

    // ── Dependency graph ──

    function link(key, f) {
        let hasRange = false
        for (const ref of f.refs) {
            if (ref.kind !== 'cell') { hasRange = true; continue }
            if (ref.row < 0 || ref.col < 0) continue
            const k = keyOf(ref.row, ref.col)
            let set = dependents.get(k)
            if (!set) dependents.set(k, (set = new Set()))
            set.add(key)
        }
        if (hasRange) rangeFormulas.add(key)
    }

    function unlink(key, f) {
        for (const ref of f.refs) {
            if (ref.kind !== 'cell' || ref.row < 0 || ref.col < 0) continue
            const k = keyOf(ref.row, ref.col)
            const set = dependents.get(k)
            if (set) {
                set.delete(key)
                if (set.size === 0) dependents.delete(k)
            }
        }
        rangeFormulas.delete(key)
    }

    function rangeFormulaCovers(formulaKey, r, c) {
        const f = cells.get(formulaKey)?.f
        if (!f) return false
        for (const ref of f.refs) {
            if (ref.kind !== 'range') continue
            const b = rangeBounds(ref)
            if (b && r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) return true
        }
        return false
    }

    // ── Primitive writes (apply only; recording is done by the callers) ──

    function writeCell(key, cell) {
        const old = cells.get(key)
        if (old?.f) unlink(key, old.f)
        if (cell) {
            cells.set(key, cell)
            if (cell.f) link(key, cell.f)
        } else {
            cells.delete(key)
        }
        pendingDirty.add(key)
        dataVersion++
    }

    function writeStyle(key, style) {
        if (style) styles.set(key, style)
        else styles.delete(key)
    }

    function markStructural(axisName, ids) {
        if (!structural) structural = { row: [], col: [] }
        if (ids) for (const id of ids) structural[axisName].push(id)
        dataVersion++
    }

    // ── Transactions and undo ──

    function record(op) {
        if (!tx) throw new Error('engine mutation outside a transaction')
        tx.ops.push(op)
    }

    function applyOp(op, forward) {
        switch (op.t) {
            case 'cell':
                writeCell(op.key, forward ? op.after : op.before)
                break
            case 'style':
                writeStyle(op.key, forward ? op.after : op.before)
                break
            case 'insert':
                if (forward) axisOf(op.axis).insertIds(op.at, op.ids)
                else axisOf(op.axis).remove(op.at, op.ids.length)
                markStructural(op.axis, op.ids)
                break
            case 'delete':
                if (forward) axisOf(op.axis).remove(op.at, op.ids.length)
                else axisOf(op.axis).insertIds(op.at, op.ids)
                markStructural(op.axis, op.ids)
                break
            case 'permute':
                axisOf(op.axis).place(op.positions, forward ? op.after : op.before)
                markStructural(op.axis, null)
                break
            case 'size': {
                const map = op.axis === 'row' ? rowHeights : colWidths
                const value = forward ? op.after : op.before
                if (value === undefined) map.delete(op.id)
                else map.set(op.id, value)
                break
            }
            case 'view':
                view[op.field] = forward ? op.after : op.before
                break
        }
    }

    function setCellRecord(key, cell) {
        const before = cells.get(key)
        if (before === cell || (!before && !cell)) return
        tx.ops.push({ t: 'cell', key, before, after: cell })
        writeCell(key, cell)
    }

    function setStyleRecord(key, style) {
        const next = style && !isDefaultStyle(style) ? style : undefined
        const before = styles.get(key)
        if (sameStyle(before, next)) return
        tx.ops.push({ t: 'style', key, before, after: next })
        writeStyle(key, next)
    }

    function setSizeRecord(axisName, id, size) {
        const map = axisName === 'row' ? rowHeights : colWidths
        const before = map.get(id)
        if (before === size) return
        record({ t: 'size', axis: axisName, id, before, after: size })
        if (size === undefined) map.delete(id)
        else map.set(id, size)
    }

    function setViewRecord(field, value) {
        const before = view[field]
        if (before === value) return
        record({ t: 'view', field, before, after: value })
        view[field] = value
    }

    function insertAxisRecord(axisName, at, count) {
        const ids = axisOf(axisName).insert(at, count)
        record({ t: 'insert', axis: axisName, at, ids })
        markStructural(axisName, ids)
    }

    function deleteAxisRecord(axisName, at, count) {
        const ids = axisOf(axisName).remove(at, count)
        record({ t: 'delete', axis: axisName, at, ids })
        markStructural(axisName, ids)
    }

    function permuteRowsRecord(positions, before, after) {
        record({ t: 'permute', axis: 'row', positions, before, after })
        rowAxis.place(positions, after)
        markStructural('row', null)
    }

    /**
     * Run fn as one undoable step. Nested calls join the outer step.
     * Returns fn's result. A step that changed nothing leaves no undo entry.
     */
    function transact(label, fn) {
        if (tx) return fn()
        tx = { label, ops: [] }
        let result
        try {
            result = fn()
        } catch (error) {
            const failed = tx
            tx = null
            for (let i = failed.ops.length - 1; i >= 0; i--) applyOp(failed.ops[i], false)
            afterChange()
            throw error
        }
        const done = tx
        tx = null
        if (done.ops.length > 0) {
            undoStack.push(done)
            if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
            redoStack.length = 0
        }
        afterChange()
        return result
    }

    function undo() {
        if (tx || undoStack.length === 0) return false
        const entry = undoStack.pop()
        for (let i = entry.ops.length - 1; i >= 0; i--) applyOp(entry.ops[i], false)
        redoStack.push(entry)
        afterChange()
        return true
    }

    function redo() {
        if (tx || redoStack.length === 0) return false
        const entry = redoStack.pop()
        for (const op of entry.ops) applyOp(op, true)
        undoStack.push(entry)
        afterChange()
        return true
    }

    function afterChange() {
        recalculate()
        version++
        for (const listener of listeners) listener(version)
    }

    // ── Recalculation ──

    // A single evaluation context, re-pointed at each formula before it runs.
    let evalFormula = null
    const evalContext = {
        ref(i) {
            const ref = evalFormula.refs[i]
            if (rowAxis.posOf(ref.row) < 0 || colAxis.posOf(ref.col) < 0) return ERR.REF
            const cell = cells.get(keyOf(ref.row, ref.col))
            return cell ? cell.v : null
        },
        eachInRange(i, cb) {
            const b = rangeBounds(evalFormula.refs[i])
            if (!b) throw ERR.REF
            for (let r = b.r1; r <= b.r2; r++) {
                const rowId = rowAxis.idAt(r)
                for (let c = b.c1; c <= b.c2; c++) {
                    const cell = cells.get(keyOf(rowId, colAxis.idAt(c)))
                    cb(cell ? cell.v : null)
                }
            }
        },
    }

    function addDependentsOf(key, into) {
        const set = dependents.get(key)
        if (set) for (const d of set) into.add(d)
    }

    function recalculate() {
        const seeds = pendingDirty
        if (structural) {
            // Ranges are positional, so any structural change may change what they cover.
            for (const k of rangeFormulas) seeds.add(k)
            // References into removed/restored rows and columns flip to or from #REF!.
            for (const rowId of structural.row) {
                for (let c = 0; c < colAxis.length; c++) addDependentsOf(keyOf(rowId, colAxis.idAt(c)), seeds)
            }
            for (const colId of structural.col) {
                for (let r = 0; r < rowAxis.length; r++) addDependentsOf(keyOf(rowAxis.idAt(r), colId), seeds)
            }
            structural = null
        }
        if (seeds.size === 0) return

        // 1. Everything downstream of the changed cells.
        const dirty = new Set()
        const stack = [...seeds]
        pendingDirty.clear()
        const rangeList = rangeFormulas.size ? [...rangeFormulas] : null
        while (stack.length) {
            const k = stack.pop()
            if (dirty.has(k)) continue
            dirty.add(k)
            const deps = dependents.get(k)
            if (deps) for (const d of deps) if (!dirty.has(d)) stack.push(d)
            if (rangeList) {
                const r = rowAxis.posOf(rowIdOfKey(k))
                const c = colAxis.posOf(colIdOfKey(k))
                if (r >= 0 && c >= 0) {
                    for (const rf of rangeList) if (!dirty.has(rf) && rangeFormulaCovers(rf, r, c)) stack.push(rf)
                }
            }
        }

        // 2. Evaluate dirty formulas, precedents first (iterative DFS).
        const state = new Map() // 1 = on the stack, 2 = done
        for (const start of dirty) {
            if (state.has(start)) continue
            const startCell = cells.get(start)
            if (!startCell?.f) { state.set(start, 2); continue }
            state.set(start, 1)
            const frames = [{ key: start, cell: startCell, precs: null, i: 0, cycle: false }]
            while (frames.length) {
                const frame = frames[frames.length - 1]
                if (!frame.precs) frame.precs = dirtyPrecedents(frame.cell.f, dirty)
                let pushed = false
                while (frame.i < frame.precs.length) {
                    const p = frame.precs[frame.i++]
                    const s = state.get(p)
                    if (s === 2) continue
                    if (s === 1) { frame.cycle = true; continue }
                    const pc = cells.get(p)
                    if (!pc?.f) { state.set(p, 2); continue }
                    state.set(p, 1)
                    frames.push({ key: p, cell: pc, precs: null, i: 0, cycle: false })
                    pushed = true
                    break
                }
                if (pushed) continue
                if (frame.cycle) {
                    frame.cell.v = ERR.CYCLE
                } else {
                    evalFormula = frame.cell.f
                    frame.cell.v = evaluateTemplate(frame.cell.f.tpl.ast, evalContext)
                }
                state.set(frame.key, 2)
                frames.pop()
            }
        }
    }

    function dirtyPrecedents(f, dirty) {
        const out = []
        for (const ref of f.refs) {
            if (ref.kind === 'cell') {
                if (ref.row < 0 || ref.col < 0) continue
                const k = keyOf(ref.row, ref.col)
                if (dirty.has(k)) out.push(k)
                continue
            }
            const b = rangeBounds(ref)
            if (!b) continue
            const area = (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1)
            if (area <= dirty.size) {
                for (let r = b.r1; r <= b.r2; r++) {
                    const rowId = rowAxis.idAt(r)
                    for (let c = b.c1; c <= b.c2; c++) {
                        const k = keyOf(rowId, colAxis.idAt(c))
                        if (dirty.has(k)) out.push(k)
                    }
                }
            } else {
                for (const k of dirty) {
                    const r = rowAxis.posOf(rowIdOfKey(k))
                    const c = colAxis.posOf(colIdOfKey(k))
                    if (r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) out.push(k)
                }
            }
        }
        return out
    }

    // ── Reading ──

    function cellAt(r, c) {
        return inBounds(r, c) ? cells.get(keyAt(r, c)) : undefined
    }

    function getCell(r, c) {
        const cell = cellAt(r, c)
        if (!cell) return { raw: '', computed: '', error: null }
        if (isError(cell.v)) return { raw: rawOf(cell), computed: null, error: cell.v.code }
        return { raw: rawOf(cell), computed: cell.v, error: null }
    }

    function getStyle(r, c) {
        return (inBounds(r, c) && styles.get(keyAt(r, c))) || DEFAULT_STYLE
    }

    function getText(r, c) {
        return textOf(cellAt(r, c))
    }

    function getDisplay(r, c) {
        return textOf(cellAt(r, c))
    }

    /** Bounding box of non-empty cells as { r1: 0, c1: 0, r2, c2 }, or null for an empty sheet. */
    function getUsedRange() {
        if (usedCache && usedCache.dataVersion === dataVersion) return usedCache.range
        let maxR = -1
        let maxC = -1
        for (const key of cells.keys()) {
            const r = rowAxis.posOf(rowIdOfKey(key))
            if (r < 0) continue
            const c = colAxis.posOf(colIdOfKey(key))
            if (c < 0) continue
            if (r > maxR) maxR = r
            if (c > maxC) maxC = c
        }
        const range = maxR < 0 ? null : { r1: 0, c1: 0, r2: maxR, c2: maxC }
        usedCache = { dataVersion, range }
        return range
    }

    function rowTexts(r, c1, c2) {
        const out = []
        for (let c = c1; c <= c2; c++) out.push(getText(r, c))
        return out
    }

    /**
     * The table that header-click sort and filters work on: the columns
     * up to the last filled header cell in row 1, and the rows down to the
     * last row with data in those columns. A stray value far away from the
     * table does not stretch it. Falls back to the used range without a header.
     */
    let tableCache = null
    function getTableRange() {
        if (tableCache && tableCache.dataVersion === dataVersion) return tableCache.range
        const used = getUsedRange()
        let range = null
        if (used) {
            let c2 = -1
            for (let c = 0; c <= used.c2; c++) if (getText(0, c) !== '') c2 = c
            if (c2 < 0) c2 = used.c2
            let r2 = 0
            for (const key of cells.keys()) {
                const r = rowAxis.posOf(rowIdOfKey(key))
                const c = colAxis.posOf(colIdOfKey(key))
                if (r > r2 && c >= 0 && c <= c2) r2 = r
            }
            range = { r1: 0, c1: 0, r2, c2 }
        }
        tableCache = { dataVersion, range }
        return range
    }

    /** The table's last row if it reads as a totals row (contract §3.1 / §4.2), else -1. */
    function totalsRowIndex() {
        const table = getTableRange()
        if (!table || table.r2 < 1) return -1
        return looksLikeTotalsRow(rowTexts(table.r2, table.c1, table.c2)) ? table.r2 : -1
    }

    /** Visit existing cells inside a range, choosing the cheaper strategy. */
    function forEachCellInRange(range, cb) {
        const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
        if (area <= cells.size) {
            for (let r = range.r1; r <= range.r2; r++) {
                for (let c = range.c1; c <= range.c2; c++) {
                    const key = keyAt(r, c)
                    if (cells.has(key)) cb(key, r, c)
                }
            }
            return
        }
        for (const key of [...cells.keys()]) {
            const r = rowAxis.posOf(rowIdOfKey(key))
            const c = colAxis.posOf(colIdOfKey(key))
            if (r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) cb(key, r, c)
        }
    }

    function clampRange(range) {
        const n = normaliseRange(range)
        return {
            r1: Math.max(0, n.r1), c1: Math.max(0, n.c1),
            r2: Math.min(rowAxis.length - 1, n.r2), c2: Math.min(colAxis.length - 1, n.c2),
        }
    }

    // ── Editing ──

    function setCell(r, c, raw) {
        if (!inBounds(r, c)) return false
        const value = raw ?? ''
        if (rawOf(cellAt(r, c)) === value) return false
        transact(`Edit ${cellAddress(r, c)}`, () => setCellRecord(keyAt(r, c), buildCell(value)))
        return true
    }

    /** Write a block of raw values with its top-left at (r0, c0). One undo step. */
    function setCells(r0, c0, matrix, label = 'Paste') {
        const height = matrix.length
        const width = Math.max(0, ...matrix.map(row => row.length))
        rowAxis.grow(r0 + height)
        colAxis.grow(c0 + width)
        return transact(label, () => {
            for (let i = 0; i < height; i++) {
                const row = matrix[i]
                for (let j = 0; j < row.length; j++) {
                    const value = row[j] === null || row[j] === undefined ? '' : String(row[j])
                    const key = keyAt(r0 + i, c0 + j)
                    if (rawOf(cells.get(key)) !== value) setCellRecord(key, buildCell(value))
                }
            }
        })
    }

    /** Clear the content of every cell in the range (styles stay). One undo step. */
    function clearRange(range) {
        const r = clampRange(range)
        transact(`Clear ${rangeAddress(r)}`, () => {
            forEachCellInRange(r, (key) => setCellRecord(key, undefined))
        })
    }

    /** Merge a partial style into every cell of the range. One undo step. */
    function setStyle(range, patch) {
        let r = clampRange(range)
        const area = (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1)
        if (area > MAX_STYLE_CELLS) {
            const used = getUsedRange()
            r = { ...r, r2: Math.min(r.r2, used ? used.r2 : r.r1) }
        }
        transact('Format', () => {
            for (let row = r.r1; row <= r.r2; row++) {
                for (let c = r.c1; c <= r.c2; c++) {
                    const key = keyAt(row, c)
                    setStyleRecord(key, mergeStyle(styles.get(key), patch))
                }
            }
        })
    }

    // ── Fill handle ──

    /**
     * Fill from the source range into the target range. The target must
     * extend the source along one axis (down, up, right or left); a target
     * inside the source clears the cells it no longer covers (dragging back).
     * One undo step.
     */
    function fill(sourceRange, targetRange) {
        const s = clampRange(sourceRange)
        const t = clampRange(targetRange)
        return transact('Fill', () => {
            if (t.r1 >= s.r1 && t.r2 <= s.r2 && t.c1 >= s.c1 && t.c2 <= s.c2) {
                forEachCellInRange(s, (key, r, c) => {
                    if (r < t.r1 || r > t.r2 || c < t.c1 || c > t.c2) setCellRecord(key, undefined)
                })
                return
            }
            const vertical = t.r1 < s.r1 || t.r2 > s.r2
            const lines = vertical ? [s.c1, s.c2] : [s.r1, s.r2]
            const seedFrom = vertical ? s.r1 : s.c1
            const seedTo = vertical ? s.r2 : s.c2
            const from = vertical ? t.r1 : t.c1
            const to = vertical ? t.r2 : t.c2
            const n = seedTo - seedFrom + 1
            for (let line = lines[0]; line <= lines[1]; line++) {
                const at = (i) => (vertical ? [i, line] : [line, i])
                const seedKeys = []
                for (let i = seedFrom; i <= seedTo; i++) seedKeys.push(keyAt(...at(i)))
                const seedCells = seedKeys.map(k => cells.get(k))
                const series = makeSeries(seedCells.map(rawOf))
                for (let i = from; i <= to; i++) {
                    if (i >= seedFrom && i <= seedTo) continue
                    const k = i - seedFrom
                    const result = series(k)
                    const seedIndex = result.seed ?? mod(k, n)
                    const [r, c] = at(i)
                    const key = keyAt(r, c)
                    const offset = i - (seedFrom + seedIndex)
                    const cell = result.raw !== undefined
                        ? buildCell(result.raw)
                        : copyCell(seedCells[seedIndex], vertical ? offset : 0, vertical ? 0 : offset)
                    setCellRecord(key, cell)
                    setStyleRecord(key, styles.get(seedKeys[seedIndex]))
                }
            }
        })
    }

    // ── Rows and columns ──

    // When rows/cols are deleted, a range whose endpoint is deleted shrinks
    // to the surviving part; a range that is entirely deleted becomes #REF!.
    function shrinkRangesForDelete(axisName, at, count) {
        const axis = axisOf(axisName)
        const last = at + count - 1
        const [k1, k2] = axisName === 'row' ? ['r1', 'r2'] : ['c1', 'c2']
        for (const key of [...rangeFormulas]) {
            const cell = cells.get(key)
            let changed = false
            const refs = cell.f.refs.map(ref => {
                if (ref.kind !== 'range') return ref
                const p1 = axis.posOf(ref[k1])
                const p2 = axis.posOf(ref[k2])
                if (p1 < 0 || p2 < 0) return ref
                const lo = Math.min(p1, p2), hi = Math.max(p1, p2)
                if (hi < at || lo > last) return ref
                if (lo >= at && hi <= last) { changed = true; return { ...ref, [k1]: -1, [k2]: -1 } }
                const next = { ...ref }
                if (lo >= at) { next[k1] = axis.idAt(last + 1); next[k2] = axis.idAt(hi) }
                else if (hi <= last) { next[k1] = axis.idAt(lo); next[k2] = axis.idAt(at - 1) }
                else return ref
                changed = true
                return next
            })
            if (changed) setCellRecord(key, { raw: null, f: { tpl: cell.f.tpl, refs }, v: null })
        }
    }

    function insertRows(at, count = 1) {
        if (at < 0 || at > rowAxis.length || count < 1) return
        transact(count === 1 ? `Insert row ${at + 1}` : `Insert ${count} rows`, () => {
            insertAxisRecord('row', at, count)
            setViewRecord('sort', null)
        })
    }

    function deleteRows(at, count = 1) {
        if (at < 0 || at >= rowAxis.length) return
        count = Math.min(count, rowAxis.length - at)
        transact(count === 1 ? `Delete row ${at + 1}` : `Delete ${count} rows`, () => {
            shrinkRangesForDelete('row', at, count)
            for (let r = at; r < at + count; r++) {
                for (let c = 0; c < colAxis.length; c++) {
                    const key = keyAt(r, c)
                    if (cells.has(key)) setCellRecord(key, undefined)
                    if (styles.has(key)) setStyleRecord(key, undefined)
                }
            }
            deleteAxisRecord('row', at, count)
            setViewRecord('sort', null)
        })
    }

    function insertColumns(at, count = 1) {
        if (at < 0 || at > colAxis.length || count < 1) return
        transact(count === 1 ? `Insert column ${columnLabel(at)}` : `Insert ${count} columns`, () => {
            insertAxisRecord('col', at, count)
            setViewRecord('sort', null)
        })
    }

    function deleteColumns(at, count = 1) {
        if (at < 0 || at >= colAxis.length) return
        count = Math.min(count, colAxis.length - at)
        transact(count === 1 ? `Delete column ${columnLabel(at)}` : `Delete ${count} columns`, () => {
            shrinkRangesForDelete('col', at, count)
            const doomed = new Set()
            for (let c = at; c < at + count; c++) doomed.add(colAxis.idAt(c))
            forEachCellInRange({ r1: 0, r2: rowAxis.length - 1, c1: at, c2: at + count - 1 }, (key) => setCellRecord(key, undefined))
            for (const key of [...styles.keys()]) if (doomed.has(colIdOfKey(key))) setStyleRecord(key, undefined)
            if ([...view.filters.keys()].some(id => doomed.has(id))) {
                setViewRecord('filters', new Map([...view.filters].filter(([id]) => !doomed.has(id))))
            }
            deleteAxisRecord('col', at, count)
            setViewRecord('sort', null)
        })
    }

    // ── Sizes and freeze panes ──

    function getColWidth(c) {
        return colWidths.get(colAxis.idAt(c)) ?? DEFAULT_COL_WIDTH
    }

    function getRowHeight(r) {
        return rowHeights.get(rowAxis.idAt(r)) ?? DEFAULT_ROW_HEIGHT
    }

    /** Set several column widths as one undo step: [{ c, width }]. */
    function setColWidths(list, label = 'Resize column') {
        transact(label, () => {
            for (const { c, width } of list) {
                if (c < 0 || c >= colAxis.length) continue
                setSizeRecord('col', colAxis.idAt(c), width === DEFAULT_COL_WIDTH ? undefined : Math.round(width))
            }
        })
    }

    function setRowHeights(list, label = 'Resize row') {
        transact(label, () => {
            for (const { r, height } of list) {
                if (r < 0 || r >= rowAxis.length) continue
                setSizeRecord('row', rowAxis.idAt(r), height === DEFAULT_ROW_HEIGHT ? undefined : Math.round(height))
            }
        })
    }

    function setFreeze({ rows, cols } = {}) {
        transact('Freeze', () => {
            if (rows !== undefined && rows !== null) setViewRecord('frozenRows', Math.max(0, rows))
            if (cols !== undefined && cols !== null) setViewRecord('frozenCols', Math.max(0, cols))
        })
    }

    // ── Filters (a view: rows are hidden, never moved or changed) ──

    /** Rows a filter applies to: the body below the header, minus a totals row. */
    function filterBody() {
        const table = getTableRange()
        if (!table || table.r2 < 1) return null
        const totals = totalsRowIndex()
        return { r1: 1, r2: totals >= 0 ? totals - 1 : table.r2 }
    }

    function hiddenState() {
        if (hiddenCache && hiddenCache.dataVersion === dataVersion && hiddenCache.filters === view.filters) return hiddenCache
        const body = filterBody()
        const hidden = new Uint8Array(rowAxis.length)
        let total = 0
        let visible = 0
        const tests = []
        for (const [colId, spec] of view.filters) {
            const c = colAxis.posOf(colId)
            if (c >= 0 && isActiveFilter(spec)) tests.push({ c, test: compileFilter(spec) })
        }
        if (body) {
            for (let r = body.r1; r <= body.r2; r++) {
                total++
                for (const { c, test } of tests) {
                    if (!test(getText(r, c))) { hidden[r] = 1; break }
                }
                if (!hidden[r]) visible++
            }
        }
        hiddenCache = { dataVersion, filters: view.filters, hidden, total, visible, active: tests.length > 0 }
        return hiddenCache
    }

    function isRowHidden(r) {
        if (view.filters.size === 0) return false
        return hiddenState().hidden[r] === 1
    }

    /** { visible, total, active } for the status line. */
    function getFilterStatus() {
        const s = hiddenState()
        return { visible: s.visible, total: s.total, active: s.active }
    }

    function getFilter(c) {
        return view.filters.get(colAxis.idAt(c)) || null
    }

    /** Set (or clear with null) the filter on column c. One undo step. */
    function setFilter(c, spec) {
        const colId = colAxis.idAt(c)
        if (colId < 0) return
        const next = new Map(view.filters)
        if (spec && isActiveFilter(spec)) next.set(colId, { values: spec.values ? [...spec.values] : null, condition: spec.condition || null })
        else next.delete(colId)
        if (next.size === view.filters.size && !view.filters.has(colId) && !next.has(colId)) return
        transact(spec ? `Filter ${columnLabel(c)}` : `Clear filter ${columnLabel(c)}`, () => setViewRecord('filters', next))
    }

    function clearFilters() {
        if (view.filters.size === 0) return
        transact('Clear all filters', () => setViewRecord('filters', new Map()))
    }

    /**
     * Distinct values of column c over the filter body, grouped by the
     * normalised text (so "West", "West " and "west" are one entry) with
     * the first-seen label. '' is the (Blanks) entry.
     */
    function getFilterValues(c) {
        const body = filterBody()
        const groups = new Map()
        if (body) {
            for (let r = body.r1; r <= body.r2; r++) {
                const text = getText(r, c)
                const key = norm(text)
                const g = groups.get(key)
                if (g) g.count++
                else groups.set(key, { key, label: key === '' ? '(Blanks)' : text.trim(), count: 1 })
            }
        }
        return [...groups.values()].sort((a, b) => {
            if (a.key === '') return 1
            if (b.key === '') return -1
            const na = toNum(a.label), nb = toNum(b.label)
            if (na !== null && nb !== null) return na - nb
            return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
        })
    }

    // ── Sort (a physical edit) ──

    /**
     * The block a header click sorts: a multi-row selection as-is, otherwise
     * the used range below the header row with a trailing totals row pinned.
     */
    function sortBlockFor(selection) {
        const table = getTableRange()
        if (!table) return null
        if (selection) {
            const s = clampRange(selection)
            const wholeRows = s.c1 === 0 && s.c2 === colAxis.length - 1
            const wholeCols = s.r1 === 0 && s.r2 === rowAxis.length - 1
            if (s.r2 > s.r1 && !wholeRows && !wholeCols) return { ...s, wholeRows: false }
        }
        const totals = totalsRowIndex()
        const r2 = totals >= 0 ? totals - 1 : table.r2
        if (r2 < 1) return null
        return { r1: 1, r2, c1: table.c1, c2: table.c2, wholeRows: true }
    }

    // A row with no typed data. Formula cells don't count, so a blank row
    // that a filled-down formula runs through still sorts to the bottom.
    function rowIsEmpty(r, c1, c2) {
        for (let c = c1; c <= c2; c++) {
            const cell = cellAt(r, c)
            if (cell && !cell.f) return false
        }
        return true
    }

    function sortedPositions(positions, block, col, dir) {
        const keys = positions.map(r => {
            if (rowIsEmpty(r, block.c1, block.c2)) return EMPTY_ROW_KEY
            const cell = cellAt(r, col)
            return sortKey(cell ? cell.v : null, cell ? isError(cell.v) : false)
        })
        const index = positions.map((_, i) => i)
        index.sort((a, b) => compareKeys(keys[a], keys[b], dir) || a - b)
        return index
    }

    // Ranges are positional: after rows are permuted, a range keeps covering
    // the same positions (so =SUM(J2:J32) over the whole block is unchanged).
    function rebindRangesAfterPermute(endpointPositions) {
        for (const [key, refs] of endpointPositions) {
            const cell = cells.get(key)
            if (!cell?.f) continue
            let changed = false
            const next = cell.f.refs.map((ref, i) => {
                const saved = refs[i]
                if (!saved) return ref
                const r1 = rowAxis.idAt(saved[0])
                const r2 = rowAxis.idAt(saved[1])
                if (r1 === ref.r1 && r2 === ref.r2) return ref
                changed = true
                return { ...ref, r1, r2 }
            })
            if (changed) setCellRecord(key, { raw: null, f: { tpl: cell.f.tpl, refs: next }, v: null })
        }
    }

    function permuteRows(positions, nextIds) {
        const before = rowAxis.idsAt(positions)
        const endpointPositions = new Map()
        for (const key of rangeFormulas) {
            const refs = cells.get(key).f.refs.map(ref =>
                ref.kind === 'range' ? [rowAxis.posOf(ref.r1), rowAxis.posOf(ref.r2)] : null)
            endpointPositions.set(key, refs)
        }
        permuteRowsRecord(positions, before, nextIds)
        rebindRangesAfterPermute(endpointPositions)
    }

    // A block narrower than the used range can't move whole rows, so its
    // cells are moved instead (formulas shift like a copy).
    function snapshotBlock(positions, block) {
        return positions.map(r => {
            const row = []
            for (let c = block.c1; c <= block.c2; c++) {
                const key = keyAt(r, c)
                row.push({ cell: cells.get(key), style: styles.get(key), r })
            }
            return row
        })
    }

    function writeBlock(positions, block, rowsInOrder) {
        positions.forEach((r, i) => {
            rowsInOrder[i].forEach((entry, j) => {
                const key = keyAt(r, block.c1 + j)
                setCellRecord(key, copyCell(entry.cell, r - entry.r, 0))
                setStyleRecord(key, entry.style)
            })
        })
    }

    /**
     * Sort a block by column `col` in direction 'asc' | 'desc' | 'none'
     * ('none' restores the order saved when this sort cycle started).
     * Only visible rows move; hidden rows keep their positions.
     */
    function sortBlock(block, col, dir) {
        const colId = colAxis.idAt(col)
        const positions = []
        for (let r = block.r1; r <= block.r2; r++) if (!isRowHidden(r)) positions.push(r)
        if (positions.length === 0) return
        // Whole rows move (by identity) unless the block is a selection
        // narrower than the used range; then only its cells are moved.
        const used = getUsedRange()
        const fullWidth = block.wholeRows || (block.c1 <= used.c1 && block.c2 >= used.c2)
        const prev = view.sort
        const sameCycle = prev && prev.colId === colId && prev.r1 === block.r1 && prev.r2 === block.r2 &&
            prev.c1 === block.c1 && prev.c2 === block.c2 && prev.positions.join() === positions.join()
        const original = sameCycle ? prev.original
            : fullWidth ? rowAxis.idsAt(positions) : snapshotBlock(positions, block)

        if (dir === 'none') {
            if (fullWidth) permuteRows(positions, original)
            else writeBlock(positions, block, original)
            setViewRecord('sort', null)
            return
        }
        const order = sortedPositions(positions, block, col, dir)
        if (fullWidth) {
            const ids = rowAxis.idsAt(positions)
            permuteRows(positions, order.map(i => ids[i]))
        } else {
            const rows = snapshotBlock(positions, block)
            writeBlock(positions, block, order.map(i => rows[i]))
        }
        setViewRecord('sort', { colId, dir, r1: block.r1, r2: block.r2, c1: block.c1, c2: block.c2, wholeRows: !!block.wholeRows, positions, original })
    }

    /**
     * Header click: sort the block containing column `col` and cycle
     * ascending → descending → original. Returns the new direction.
     */
    function sortByColumn(col, selection = null) {
        let block = sortBlockFor(selection)
        if (!block || col < block.c1 || col > block.c2) return null
        const prev = view.sort
        const colId = colAxis.idAt(col)
        // Sorting can move empty rows to the bottom and so shrink the table;
        // a repeated click on the same column keeps working on the same block.
        const same = prev && prev.colId === colId && prev.r1 === block.r1 && prev.c1 === block.c1 &&
            prev.c2 === block.c2 && (prev.r2 === block.r2 || (prev.wholeRows && block.wholeRows))
        if (same) block = { ...block, r2: Math.max(prev.r2, block.r2) }
        const dir = !same ? 'asc' : prev.dir === 'asc' ? 'desc' : 'none'
        const label = { asc: 'ascending', desc: 'descending', none: 'original order' }[dir]
        transact(`Sort by ${columnLabel(col)} ${label}`, () => sortBlock(block, col, dir))
        return dir
    }

    /** Sort a block explicitly. One undo step. */
    function sortRange(range, col, dir = 'asc') {
        const block = clampRange(range)
        transact(`Sort ${rangeAddress(block)}`, () => sortBlock(block, col, dir))
    }

    function getSortState() {
        const s = view.sort
        if (!s) return null
        const col = colAxis.posOf(s.colId)
        return col < 0 ? null : { col, dir: s.dir, r1: s.r1, r2: s.r2, c1: s.c1, c2: s.c2 }
    }

    // ── Public API ──

    return {
        get rows() { return rowAxis.length },
        get cols() { return colAxis.length },
        get version() { return version },
        get frozenRows() { return view.frozenRows },
        get frozenCols() { return view.frozenCols },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        // reading
        getCell,
        getText,
        getDisplay,
        getStyle,
        getUsedRange,
        getTableRange,
        totalsRowIndex,
        // editing
        setCell,
        setCells,
        clearRange,
        setStyle,
        fill,
        transact,
        // structure
        insertRow: (at) => insertRows(at, 1),
        deleteRow: (at) => deleteRows(at, 1),
        insertColumn: (at) => insertColumns(at, 1),
        deleteColumn: (at) => deleteColumns(at, 1),
        insertRows,
        deleteRows,
        insertColumns,
        deleteColumns,
        // sizes and panes
        getColWidth,
        getRowHeight,
        setColWidths,
        setRowHeights,
        setFreeze,
        // filters and sort
        isRowHidden,
        getFilter,
        setFilter,
        clearFilters,
        getFilterValues,
        getFilterStatus,
        sortByColumn,
        sortRange,
        getSortState,
        // history
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        undoLabel: () => undoStack[undoStack.length - 1]?.label ?? null,
        redoLabel: () => redoStack[redoStack.length - 1]?.label ?? null,
        // Grow the grid so that at least minRows x minCols exist. Not undoable:
        // it only moves the bounds; nothing is allocated per cell.
        ensureCapacity(minRows, minCols) {
            rowAxis.grow(minRows)
            colAxis.grow(minCols)
            version++
            for (const listener of listeners) listener(version)
        },
    }
}
