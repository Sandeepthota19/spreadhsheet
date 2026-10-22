// ─────────────────────────────────────────────────────────────
//  Sheet context: the ONLY view of the data a model gets.
//  Headers, an inferred type per column, a few examples, five
//  sample rows, the row count and the selection. Never the full
//  data (AI_CONTRACT.md §1). Pure.
//
//  Shape (exactly what is sent):
//    { range, rowCount, columns: [{ name, index, type, examples }],
//      sampleRows, selection, hasTotalsRow }
// ─────────────────────────────────────────────────────────────
import { toNum, toDate } from '../engine/values.js'
import { isBlankRow, locateBody } from './queryExecutor.js'

const SAMPLE_ROWS = 5
const EXAMPLES = 3
const ID_VALUE = /^[A-Z]{2,}-?\d+$/i
// "Order ID", "order_id", "OrderId", "Invoice #", but not "Paid"
const isIdHeader = (h) => /(?:^|[\s_.-])id$/i.test(h) || /[a-z]Id$/.test(h) || /(?:^|\s)#$/.test(h)

const share = (values, test) => {
    let hits = 0
    for (const v of values) if (test(v)) hits++
    return hits / values.length
}

/**
 * Infer a column type from its header and body values (blanks ignored):
 * id, date, currency, percent, number or text.
 * @param {string} header
 * @param {string[]} values
 * @returns {'id'|'date'|'currency'|'percent'|'number'|'text'}
 */
export function inferColumnType(header, values) {
    const h = String(header ?? '').trim()
    const filled = values.map(v => String(v ?? '').trim()).filter(v => v !== '')
    if (isIdHeader(h)) return 'id'
    if (filled.length === 0) return 'text'
    if (filled.every(v => ID_VALUE.test(v)) && new Set(filled.map(v => v.toLowerCase())).size === filled.length) return 'id'
    if (share(filled, v => toDate(v) !== null) >= 0.8) return 'date'
    const numeric = share(filled, v => toNum(v) !== null)
    if (numeric >= 0.8 && share(filled, v => v.includes('$')) >= 0.5) return 'currency'
    if (numeric >= 0.8 && share(filled, v => v.endsWith('%')) >= 0.5) return 'percent'
    if (numeric >= 0.8) return 'number'
    return 'text'
}

/** 0-based column index → letters (0 → A, 26 → AA). */
function colLetter(c) {
    let s = ''
    for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
    return s
}

/**
 * Build the sheet context sent to the model.
 * @param {{ header: string[], rows: string[][] }} table header = row 1 of the used range, rows = rows 2..last used row
 * @param {{ range?: string, selection?: string|null }} [options] A1 range of the used range and current selection
 * @returns {{ range: string, rowCount: number,
 *             columns: Array<{name:string, index:number, type:string, examples:string[]}>,
 *             sampleRows: string[][], selection: string|null, hasTotalsRow: boolean }}
 */
export function buildSheetContext(table, { range, selection = null } = {}) {
    const header = (table?.header ?? []).map(h => String(h ?? '').trim())
    const rows = table?.rows ?? []
    const { end, totalsIndex } = locateBody(rows, true)

    const body = []
    for (let r = 0; r < end; r++) if (!isBlankRow(rows[r])) body.push(rows[r])

    const columns = header.map((name, index) => {
        const values = body.map(row => String(row[index] ?? ''))
        const examples = []
        const seen = new Set()
        for (const v of values) {
            const t = v.trim()
            if (t === '' || seen.has(t)) continue
            seen.add(t)
            examples.push(t)
            if (examples.length === EXAMPLES) break
        }
        return { name, index, type: inferColumnType(name, values), examples }
    })

    const width = header.length
    return {
        range: range ?? (width ? `A1:${colLetter(width - 1)}${rows.length + 1}` : 'A1'),
        rowCount: body.length,
        columns,
        sampleRows: body.slice(0, SAMPLE_ROWS).map(row => header.map((_, i) => String(row[i] ?? ''))),
        selection: selection ?? null,
        hasTotalsRow: totalsIndex >= 0,
    }
}
