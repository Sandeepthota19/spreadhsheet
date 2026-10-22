// ─────────────────────────────────────────────────────────────
//  Read-only query executor (AI_CONTRACT.md §3).
//
//  The model only translates a question into a plan; every number
//  the user sees is computed here, deterministically, from the
//  sheet's computed display strings. Pure: no React, no DOM, no
//  engine access; the caller hands in { header, rows }.
//
//  Pipeline: resolve names → pick data rows (skip blanks, drop the
//  totals row) → filter (AND) → group + aggregate, or project →
//  sort (stable, multi-key) → limit (capped at MAX_RESULT_ROWS).
// ─────────────────────────────────────────────────────────────
import { ACTION_TYPES, MAX_RESULT_ROWS } from './contract.js'
import { norm, toNum, toDate, isTotalsLabel } from '../engine/values.js'

/**
 * @typedef {{ header: string[], rows: string[][] }} Table
 * @typedef {{ columns: string[], rows: unknown[][], rowCount: number, truncated: boolean }} QueryResult
 * @typedef {{ error: string, detail: string }} QueryError
 */

class QueryFailure extends Error {
    constructor(code, detail) {
        super(detail)
        this.code = code
        this.detail = detail
    }
}

const fail = (code, detail) => { throw new QueryFailure(code, detail) }

const cellText = (row, i) => {
    const v = row[i]
    return v === null || v === undefined ? '' : String(v)
}

function firstFilled(row) {
    for (let i = 0; i < row.length; i++) {
        const v = cellText(row, i)
        if (v.trim() !== '') return v
    }
    return ''
}

/** Round to 2 decimals for display and golden comparison; null stays null. */
export function round2(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return null
    return Math.round((n + (n >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100
}

/**
 * §3.1: find the data rows. The totals row is the last used row when its
 * first filled cell carries a totals label. Blank rows are not removed
 * here (callers skip them while scanning, so no copy is made).
 * @param {unknown[][]} rows rows 2..last used row
 * @param {boolean} [excludeTotals]
 * @returns {{ end: number, totalsIndex: number }} scan rows [0, end); totalsIndex is -1 when there is none
 */
export function locateBody(rows, excludeTotals = true) {
    let last = rows.length - 1
    while (last >= 0 && isBlankRow(rows[last])) last--
    const totalsIndex = last >= 0 && isTotalsLabel(firstFilled(rows[last])) ? last : -1
    const end = excludeTotals && totalsIndex >= 0 ? totalsIndex : last + 1
    return { end, totalsIndex }
}

/** True when every cell of the row is empty after trim. */
export function isBlankRow(row) {
    for (let i = 0; i < row.length; i++) {
        const v = row[i]
        if (v !== null && v !== undefined && v !== '' && String(v).trim() !== '') return false
    }
    return true
}

// ── column resolution ───────────────────────────────────────

function columnResolver(header) {
    const index = new Map()
    const names = header.map(h => String(h ?? '').trim())
    names.forEach((name, i) => {
        const key = norm(name)
        if (key !== '' && !index.has(key)) index.set(key, i)
    })
    return {
        names,
        resolve(name) {
            const i = index.get(norm(name))
            if (i === undefined) fail('UNKNOWN_COLUMN', `UNKNOWN_COLUMN:${name}`)
            return i
        },
    }
}

// ── filters (§3.3) ──────────────────────────────────────────

const CMP = {
    gt: (d) => d > 0, gte: (d) => d >= 0, lt: (d) => d < 0, lte: (d) => d <= 0,
}

/** Compile one filter into a predicate over a row. */
function compileFilter(filter, col) {
    const { op } = filter
    const v = filter.value
    const vNorm = norm(v)
    switch (op) {
    case 'eq':
    case 'neq': {
        const vNum = toNum(v)
        const want = op === 'eq'
        return (row) => {
            const c = row[col]
            if (vNum !== null) {
                const cNum = toNum(c)
                if (cNum !== null) return (cNum === vNum) === want
            }
            return (norm(c) === vNorm) === want
        }
    }
    case 'gt': case 'gte': case 'lt': case 'lte': {
        const test = CMP[op]
        const vDate = toDate(v)
        if (vDate !== null) {
            return (row) => {
                const cDate = toDate(row[col])
                if (cDate === null) return false
                return test(cDate < vDate ? -1 : cDate > vDate ? 1 : 0)
            }
        }
        const vNum = toNum(v)
        if (vNum === null) return () => false
        return (row) => {
            const cNum = toNum(row[col])
            return cNum !== null && test(cNum - vNum)
        }
    }
    case 'contains': return (row) => norm(row[col]).includes(vNorm)
    case 'startsWith': return (row) => norm(row[col]).startsWith(vNorm)
    case 'endsWith': return (row) => norm(row[col]).endsWith(vNorm)
    case 'isEmpty': return (row) => norm(row[col]) === ''
    case 'notEmpty': return (row) => norm(row[col]) !== ''
    default: return fail('UNKNOWN_OP', `UNKNOWN_OP:${op}`)
    }
}

// ── aggregates (§3.4) ───────────────────────────────────────

const AGG_FNS = new Set(['sum', 'avg', 'count', 'countDistinct', 'min', 'max'])

function newAcc(fn) {
    if (fn === 'count') return { n: 0 }
    if (fn === 'countDistinct') return { set: new Set() }
    return { n: 0, sum: 0, min: Infinity, max: -Infinity }
}

function accumulate(fn, acc, raw) {
    if (fn === 'count') {
        if (norm(raw) !== '') acc.n++
    } else if (fn === 'countDistinct') {
        const k = norm(raw)
        if (k !== '') acc.set.add(k)
    } else {
        const x = toNum(raw)
        if (x === null) return
        acc.n++
        acc.sum += x
        if (x < acc.min) acc.min = x
        if (x > acc.max) acc.max = x
    }
}

function finish(fn, acc) {
    switch (fn) {
    case 'count': return acc.n
    case 'countDistinct': return acc.set.size
    case 'sum': return acc.n ? round2(acc.sum) : null
    case 'avg': return acc.n ? round2(acc.sum / acc.n) : null
    case 'min': return acc.n ? round2(acc.min) : null
    case 'max': return acc.n ? round2(acc.max) : null
    default: return null
    }
}

// ── sort (§3.5) ─────────────────────────────────────────────

/** Sort key for one value: its number (or null) and its text key. */
function sortKey(v) {
    return { num: toNum(v), text: norm(v) }
}

function compareKeys(a, b) {
    if (a.num !== null && b.num !== null) return a.num - b.num
    if (a.num !== null) return -1
    if (b.num !== null) return 1
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0
}

/** Stable multi-key sort of `rows` by the given column indices. */
function sortRows(rows, specs) {
    if (specs.length === 0) return rows
    const decorated = rows.map((row, i) => ({ row, i, keys: specs.map(s => sortKey(row[s.index])) }))
    decorated.sort((a, b) => {
        for (let k = 0; k < specs.length; k++) {
            const d = compareKeys(a.keys[k], b.keys[k])
            if (d !== 0) return specs[k].desc ? -d : d
        }
        return a.i - b.i
    })
    return decorated.map(d => d.row)
}

// ── main entry ──────────────────────────────────────────────

/**
 * Execute a validated `query` plan over a table of display strings.
 * Errors are returned, never thrown.
 * @param {object} plan a query action (see QUERY_PLAN_SCHEMA)
 * @param {Table} table header = row 1 of the used range; rows = rows 2..last used row
 * @returns {QueryResult | QueryError}
 */
export function executeQuery(plan, table) {
    try {
        return run(plan, table)
    } catch (err) {
        if (err instanceof QueryFailure) return { error: err.code, detail: err.detail }
        throw err
    }
}

function run(plan, table) {
    if (!plan || plan.type !== ACTION_TYPES.QUERY) {
        fail('READ_ONLY', `READ_ONLY: only query plans can be executed (got ${JSON.stringify(plan?.type)})`)
    }
    const header = table?.header ?? []
    const allRows = table?.rows ?? []
    const { names, resolve } = columnResolver(header)

    // Resolve every name up front so an unknown column fails before any work.
    const filters = (plan.filters ?? []).map(f => compileFilter(f, resolve(f.column)))
    const groupCols = (plan.groupBy ?? []).map(resolve)
    const aggregates = (plan.aggregates ?? []).map(a => {
        if (!AGG_FNS.has(a.fn)) fail('UNKNOWN_FN', `UNKNOWN_FN:${a.fn}`)
        const index = resolve(a.column)
        return { fn: a.fn, index, name: a.as ?? `${a.fn}(${names[index]})` }
    })
    const projection = plan.columns && plan.columns.length
        ? plan.columns.map(resolve)
        : names.map((_, i) => i)

    const { end } = locateBody(allRows, plan.excludeTotalsRow !== false)
    const matched = []
    for (let r = 0; r < end; r++) {
        const row = allRows[r]
        if (isBlankRow(row)) continue
        let ok = true
        for (let f = 0; f < filters.length; f++) {
            if (!filters[f](row)) { ok = false; break }
        }
        if (ok) matched.push(row)
    }

    let columns
    let rows
    let sortIndex      // output column name → index, for sort resolution
    if (aggregates.length || groupCols.length) {
        columns = [...groupCols.map(i => names[i]), ...aggregates.map(a => a.name)]
        rows = groupAndAggregate(matched, groupCols, aggregates)
        sortIndex = (name) => columns.findIndex(c => norm(c) === norm(name))
    } else {
        // Row results: raw, untrimmed cell text. Sort may name any source
        // column (contract §2.2), so sort full rows first, then project.
        columns = projection.map(i => names[i])
        rows = matched
        sortIndex = (name) => names.findIndex(c => norm(c) === norm(name))
    }

    const specs = (plan.sort ?? []).map(s => {
        const index = sortIndex(s.column)
        if (index < 0) fail('UNKNOWN_SORT_COLUMN', `UNKNOWN_SORT_COLUMN:${s.column}`)
        return { index, desc: s.dir === 'desc' }
    })
    rows = sortRows(rows, specs)

    const limit = Math.min(Number.isInteger(plan.limit) && plan.limit > 0 ? plan.limit : MAX_RESULT_ROWS, MAX_RESULT_ROWS)
    const truncated = rows.length > limit
    if (truncated) rows = rows.slice(0, limit)
    if (!aggregates.length && !groupCols.length) {
        rows = rows.map(row => projection.map(i => cellText(row, i)))
    }
    return { columns, rows, rowCount: rows.length, truncated }
}

function groupAndAggregate(matched, groupCols, aggregates) {
    // No groupBy: exactly one output row, even over zero matching rows.
    if (groupCols.length === 0) {
        const accs = aggregates.map(a => newAcc(a.fn))
        for (const row of matched) {
            for (let k = 0; k < aggregates.length; k++) accumulate(aggregates[k].fn, accs[k], row[aggregates[k].index])
        }
        return [aggregates.map((a, k) => finish(a.fn, accs[k]))]
    }

    const groups = new Map()
    const single = groupCols.length === 1
    for (const row of matched) {
        const key = single
            ? norm(row[groupCols[0]])
            : groupCols.map(i => norm(row[i])).join('\u0001')
        let g = groups.get(key)
        if (!g) {
            g = { label: groupCols.map(i => cellText(row, i).trim()), accs: aggregates.map(a => newAcc(a.fn)) }
            groups.set(key, g)
        }
        for (let k = 0; k < aggregates.length; k++) accumulate(aggregates[k].fn, g.accs[k], row[aggregates[k].index])
    }
    const out = []
    for (const g of groups.values()) {
        out.push([...g.label, ...aggregates.map((a, k) => finish(a.fn, g.accs[k]))])
    }
    return out
}
