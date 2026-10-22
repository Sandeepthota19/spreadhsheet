// ─────────────────────────────────────────────────────────────
//  A1-style addresses. Rows and columns are 0-based positions
//  everywhere in the engine; only these helpers speak "A1".
// ─────────────────────────────────────────────────────────────

/** 0 → A, 25 → Z, 26 → AA */
export function columnLabel(col) {
    let label = ''
    let n = col + 1
    while (n > 0) {
        n--
        label = String.fromCharCode(65 + (n % 26)) + label
        n = Math.floor(n / 26)
    }
    return label
}

/** A → 0, AA → 26. Case-insensitive. */
export function columnIndex(letters) {
    let index = 0
    const upper = letters.toUpperCase()
    for (let i = 0; i < upper.length; i++) index = index * 26 + (upper.charCodeAt(i) - 64)
    return index - 1
}

/** (0, 0) → "A1" */
export function cellAddress(row, col) {
    return columnLabel(col) + (row + 1)
}

/**
 * "AZ5000" or "$B$2" → { row, col, absRow, absCol }, else null.
 * @param {string} text
 */
export function parseCellAddress(text) {
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(String(text).trim())
    if (!m) return null
    const row = parseInt(m[4], 10) - 1
    if (row < 0) return null
    return { row, col: columnIndex(m[2]), absCol: m[1] === '$', absRow: m[3] === '$' }
}

/**
 * "B2:D10", "B2" or "D10:B2" → normalised { r1, c1, r2, c2 }, else null.
 * Also accepts whole columns ("C:C") and rows ("3:5") given grid bounds.
 */
export function parseRangeAddress(text, rowCount = Infinity, colCount = Infinity) {
    const s = String(text).trim().toUpperCase()
    const parts = s.split(':')
    if (parts.length === 1) {
        const a = parseCellAddress(parts[0])
        return a ? { r1: a.row, c1: a.col, r2: a.row, c2: a.col } : null
    }
    if (parts.length !== 2) return null
    const a = parseCellAddress(parts[0])
    const b = parseCellAddress(parts[1])
    if (a && b) return normaliseRange({ r1: a.row, c1: a.col, r2: b.row, c2: b.col })
    if (/^[A-Z]{1,3}$/.test(parts[0]) && /^[A-Z]{1,3}$/.test(parts[1]) && Number.isFinite(rowCount)) {
        return normaliseRange({ r1: 0, c1: columnIndex(parts[0]), r2: rowCount - 1, c2: columnIndex(parts[1]) })
    }
    if (/^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && Number.isFinite(colCount)) {
        return normaliseRange({ r1: +parts[0] - 1, c1: 0, r2: +parts[1] - 1, c2: colCount - 1 })
    }
    return null
}

/** Make r1 <= r2 and c1 <= c2. */
export function normaliseRange({ r1, c1, r2, c2 }) {
    return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) }
}

/** { r1, c1, r2, c2 } → "B2:D10" (or "B2" for one cell) */
export function rangeAddress({ r1, c1, r2, c2 }) {
    const a = cellAddress(r1, c1)
    return r1 === r2 && c1 === c2 ? a : a + ':' + cellAddress(r2, c2)
}
