// ─────────────────────────────────────────────────────────────
//  Display-only number formats (AI_CONTRACT.md §4 table).
//
//  A cell's stored value never changes; this maps the text the grid
//  would show (or a computed number) to its formatted display.
//  Anything that is not a number (resp. a date) is left alone.
//  Locale-independent on purpose: always `,` thousands and `.` decimals.
// ─────────────────────────────────────────────────────────────
import { toNum, toDate } from './values.js'

/** Round half away from zero to `places` decimals, robust to 1.005-style drift. */
function roundTo(n, places) {
    const f = 10 ** places
    return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * f) / f
}

/** `1234.5` → `1,234.50` (absolute value; the caller adds the sign). */
function fixedWithCommas(abs) {
    const [int, frac] = roundTo(abs, 2).toFixed(2).split('.')
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac
}

/**
 * Format a cell for display.
 *   number   79 → 79.00, $1,200.00 → 1,200.00
 *   currency 79 → $79.00, -5 → -$5.00
 *   percent  0.1 and 10% → 10%, 79 → 7900% (max 2 decimals, no separators)
 *   date     2024-01-15, 1/15/2024, 15 Jan 2024 → 2024-01-15
 *   general  unchanged
 * @param {string|number|null|undefined} text display text before formatting, or a computed number
 * @param {'general'|'number'|'currency'|'percent'|'date'} [numberFormat]
 * @returns {string}
 */
export function formatNumberDisplay(text, numberFormat = 'general') {
    const plain = text === null || text === undefined ? '' : String(text)
    if (!numberFormat || numberFormat === 'general') return plain
    if (numberFormat === 'date') return toDate(text) ?? plain

    const n = toNum(text)
    if (n === null) return plain
    const sign = n < 0 && roundTo(n, 2) !== 0 ? '-' : ''
    switch (numberFormat) {
    case 'number': return sign + fixedWithCommas(Math.abs(n))
    case 'currency': return sign + '$' + fixedWithCommas(Math.abs(n))
    case 'percent': {
        const pct = roundTo(n * 100, 2)
        return (Object.is(pct, -0) ? 0 : pct) + '%'
    }
    default: return plain
    }
}
