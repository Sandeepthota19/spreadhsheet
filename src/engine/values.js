// ─────────────────────────────────────────────────────────────
//  Value interpretation shared by the engine, sort, filters,
//  number formats and the AI executor. Pure functions, no state.
//
//  The rules follow AI_CONTRACT.md §3.2 so that every feature
//  reads messy text ("$1,200.00", "10%", " West ") the same way.
// ─────────────────────────────────────────────────────────────

const NUMBER_BODY = /^-?\d+(\.\d+)?$/

/**
 * Text key: trimmed, lower-cased. Used for equality, grouping and filters.
 * @param {unknown} v
 * @returns {string}
 */
export function norm(v) {
    if (v === null || v === undefined) return ''
    return String(v).trim().toLowerCase()
}

/**
 * Lenient number reading: `$1,200.00` → 1200, `10%` → 0.1, `N/A` → null.
 * Numbers pass through; anything that is not a plain decimal after
 * stripping `$ , %` and whitespace is not a number (null).
 * @param {unknown} v
 * @returns {number|null}
 */
export function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (v === null || v === undefined || typeof v === 'boolean') return null
    const s = String(v).trim()
    if (s === '') return null
    const isPercent = s.endsWith('%')
    const body = s.replace(/[$,%\s]/g, '')
    if (!NUMBER_BODY.test(body)) return null
    const n = Number(body)
    return isPercent ? n / 100 : n
}

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december']

function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function pad2(n) {
    return n < 10 ? '0' + n : String(n)
}

/**
 * Parse one of the three sample date shapes. Returns the parts plus the
 * shape so that callers (the fill handle) can write a date back the same way.
 *   iso  2024-01-15 (also 2024-1-5)
 *   us   1/15/2024
 *   dmy  15 Jan 2024 (any English month name of three or more letters)
 * @param {unknown} v
 * @returns {{y:number, m:number, d:number, shape:'iso'|'us'|'dmy', text:string}|null}
 */
export function parseDateParts(v) {
    if (v === null || v === undefined || typeof v === 'number') return null
    const s = String(v).trim()
    let y, m, d, shape
    let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (match) {
        y = +match[1]; m = +match[2]; d = +match[3]; shape = 'iso'
    } else if ((match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
        m = +match[1]; d = +match[2]; y = +match[3]; shape = 'us'
    } else if ((match = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/))) {
        const name = match[2].toLowerCase()
        const index = MONTHS.findIndex(full => full.startsWith(name) && (name.length >= 3))
        if (index < 0) return null
        d = +match[1]; m = index + 1; y = +match[3]; shape = 'dmy'
    } else {
        return null
    }
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
    return { y, m, d, shape, text: s }
}

/**
 * ISO day `YYYY-MM-DD` for any of the three accepted shapes, else null.
 * @param {unknown} v
 * @returns {string|null}
 */
export function toDate(v) {
    const p = parseDateParts(v)
    return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null
}

/** Days since 1970-01-01 for a parsed date (used for sorting and date steps). */
export function dateToSerial(p) {
    return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000)
}

/** Inverse of dateToSerial. */
export function serialToDateParts(serial) {
    const dt = new Date(serial * 86400000)
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

export { pad2 }

/**
 * The totals-row label test from AI_CONTRACT.md §3.1.
 * @param {string} firstFilledCell
 */
export function isTotalsLabel(firstFilledCell) {
    return /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(String(firstFilledCell ?? '').trim())
}

/**
 * Does a row of display strings read as a totals row? Contract §4 rule 2:
 * the label test, or a summary line (a non-numeric label first, then
 * numbers, at least one column empty, at least two filled cells, not all
 * cells filled).
 * @param {string[]} cells display text of the row across the used columns
 */
export function looksLikeTotalsRow(cells) {
    const filled = []
    for (let i = 0; i < cells.length; i++) {
        if (String(cells[i] ?? '').trim() !== '') filled.push(i)
    }
    if (filled.length === 0) return false
    if (isTotalsLabel(cells[filled[0]])) return true
    if (filled.length < 2 || filled.length === cells.length) return false
    if (toNum(cells[filled[0]]) !== null) return false
    for (let k = 1; k < filled.length; k++) {
        if (toNum(cells[filled[k]]) === null) return false
    }
    return true
}
