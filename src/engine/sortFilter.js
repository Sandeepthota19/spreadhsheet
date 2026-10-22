// ─────────────────────────────────────────────────────────────
//  Sort keys and filter predicates. Pure.
// ─────────────────────────────────────────────────────────────

import { norm, toNum, parseDateParts, dateToSerial } from './values.js'

// Tier order for ascending sort: numbers, dates, text, errors, then blanks.
// Descending reverses the non-blank tiers; blanks always stay last and
// completely empty rows go after rows that merely have a blank key.
const TIER = { number: 0, date: 1, text: 2, error: 3, blank: 4, emptyRow: 5 }

/**
 * Sort key for one cell.
 * @param {unknown} value computed value (number | string | CellError | null)
 * @param {boolean} isError
 */
export function sortKey(value, isError) {
    if (isError) return { tier: TIER.error, s: String(value) }
    if (value === null || value === undefined) return { tier: TIER.blank }
    if (typeof value === 'number') return { tier: TIER.number, n: value }
    const text = String(value)
    if (text.trim() === '') return { tier: TIER.blank }
    const n = toNum(text)
    if (n !== null) return { tier: TIER.number, n }
    const date = parseDateParts(text)
    if (date) return { tier: TIER.date, n: dateToSerial(date) }
    return { tier: TIER.text, s: norm(text) }
}

export const EMPTY_ROW_KEY = Object.freeze({ tier: TIER.emptyRow })

/**
 * Compare two sort keys. Stability is the caller's job (tie-break on index).
 * @param {'asc'|'desc'} dir
 */
export function compareKeys(a, b, dir) {
    const aBlank = a.tier >= TIER.blank
    const bBlank = b.tier >= TIER.blank
    if (aBlank || bBlank) return a.tier - b.tier
    const sign = dir === 'desc' ? -1 : 1
    if (a.tier !== b.tier) return sign * (a.tier - b.tier)
    if (a.n !== undefined) return sign * (a.n - b.n)
    return sign * (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)
}

export const FILTER_CONDITIONS = Object.freeze(['contains', 'gt', 'lt', 'isEmpty', 'notEmpty'])

/**
 * A column filter: `values` is the list of allowed normalised values
 * ('' stands for blanks) or null for "all"; `condition` is optional.
 * @typedef {{ values: string[]|null, condition: { op: string, value?: string }|null }} FilterSpec
 */

/** Compile a filter spec into a predicate over a cell's display text. */
export function compileFilter(spec) {
    const allowed = spec.values ? new Set(spec.values) : null
    const cond = spec.condition
    let condTest = null
    if (cond) {
        const target = norm(cond.value)
        const targetNum = toNum(cond.value)
        const targetDate = parseDateParts(cond.value)
        const compare = (text) => {
            if (targetDate) {
                const d = parseDateParts(text)
                return d ? dateToSerial(d) - dateToSerial(targetDate) : null
            }
            const n = toNum(text)
            return n === null || targetNum === null ? null : n - targetNum
        }
        switch (cond.op) {
            case 'contains': condTest = (text) => norm(text).includes(target); break
            case 'gt': condTest = (text) => { const d = compare(text); return d !== null && d > 0 }; break
            case 'lt': condTest = (text) => { const d = compare(text); return d !== null && d < 0 }; break
            case 'isEmpty': condTest = (text) => norm(text) === ''; break
            case 'notEmpty': condTest = (text) => norm(text) !== ''; break
            default: condTest = null
        }
    }
    return (text) => {
        if (allowed && !allowed.has(norm(text))) return false
        return condTest ? condTest(text) : true
    }
}

/** True when a spec actually filters anything. */
export function isActiveFilter(spec) {
    return !!spec && (spec.values !== null || !!spec.condition)
}
