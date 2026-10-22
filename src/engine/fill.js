// ─────────────────────────────────────────────────────────────
//  Fill-handle series detection. Pure.
//
//  Given the seed cells of one line (a column when filling down/up,
//  a row when filling right/left), `makeSeries(seeds)` returns a
//  function valueAt(k) for any offset k from the first seed
//  (k < 0 when dragging up/left, k >= seeds.length past the end).
//
//  valueAt returns { raw } for a literal, or { seed } meaning
//  "copy seed #seed" — the engine does the copy so that formulas
//  are shifted and styles carried over.
// ─────────────────────────────────────────────────────────────

import { parseDateParts, dateToSerial, serialToDateParts, pad2, MONTHS } from './values.js'
import { formatNumber } from './formula.js'

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/
const TEXT_NUMBER = /^(.*?)(\d+)$/

const NAME_LISTS = [
    { id: 'day', items: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
    { id: 'dy', items: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
    { id: 'month', items: MONTHS },
    { id: 'mon', items: MONTHS.map(m => m.slice(0, 3)) },
]

const mod = (a, n) => ((a % n) + n) % n

function caseOf(text) {
    if (text === text.toUpperCase() && text !== text.toLowerCase()) return 'upper'
    if (text === text.toLowerCase()) return 'lower'
    return 'title'
}

function applyCase(word, kind) {
    if (kind === 'upper') return word.toUpperCase()
    if (kind === 'lower') return word.toLowerCase()
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

/** Classify one seed's raw text for series purposes. */
export function classifySeed(raw) {
    const text = raw ?? ''
    if (text.startsWith('=')) return { kind: 'formula' }
    if (PLAIN_NUMBER.test(text.trim())) {
        const decimals = (text.split('.')[1] || '').length
        return { kind: 'number', value: Number(text), decimals }
    }
    const date = parseDateParts(text)
    if (date) {
        return {
            kind: 'date',
            serial: dateToSerial(date),
            shape: date.shape,
            // Remember how the seed was written so the series writes back the same way.
            padded: /(^|\D)0\d/.test(text),
            monthWord: date.shape === 'dmy' ? text.trim().split(/\s+/)[1] : null,
        }
    }
    const lower = text.trim().toLowerCase()
    for (const list of NAME_LISTS) {
        const index = list.items.indexOf(lower)
        if (index >= 0) return { kind: 'name', list: list.id, items: list.items, index, case: caseOf(text.trim()) }
    }
    const m = TEXT_NUMBER.exec(text)
    if (m) return { kind: 'textNumber', prefix: m[1], value: parseInt(m[2], 10), width: m[2].length, zeroPadded: m[2].length > 1 && m[2][0] === '0' }
    return { kind: 'text' }
}

function writeDate(serial, seed) {
    const { y, m, d } = serialToDateParts(serial)
    const p = (n) => (seed.padded ? pad2(n) : String(n))
    if (seed.shape === 'iso') return `${y}-${p(m)}-${p(d)}`
    if (seed.shape === 'us') return `${p(m)}/${p(d)}/${y}`
    const word = seed.monthWord
    const full = MONTHS[m - 1]
    const name = word && word.length > 3 ? full : full.slice(0, 3)
    return `${p(d)} ${applyCase(name, caseOf(word || 'Jan'))} ${y}`
}

// Average step between first and last seed; seeds 1,2 → 1; 2024-01-03, 01-05, 01-08 → 2.5 days.
function averageStep(values) {
    return values.length < 2 ? 1 : (values[values.length - 1] - values[0]) / (values.length - 1)
}

// Least-squares line through (k, value) — the spreadsheet "linear trend" for numbers.
function linearTrend(values) {
    const n = values.length
    let sx = 0, sy = 0, sxx = 0, sxy = 0
    for (let k = 0; k < n; k++) { sx += k; sy += values[k]; sxx += k * k; sxy += k * values[k] }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    return { intercept: (sy - slope * sx) / n, slope }
}

/**
 * Build the series for one line of seeds.
 * @param {string[]} seeds raw text of the seed cells, in fill order
 * @returns {(k:number) => ({ raw: string } | { seed: number })}
 */
export function makeSeries(seeds) {
    const n = seeds.length
    const copy = (k) => ({ seed: mod(k, n) })
    const info = seeds.map(classifySeed)
    const kind = info[0].kind
    if (!info.every(s => s.kind === kind)) return copy

    if (kind === 'number') {
        if (n === 1) return copy
        const { intercept, slope } = linearTrend(info.map(s => s.value))
        const decimals = Math.max(...info.map(s => s.decimals))
        return (k) => {
            if (k >= 0 && k < n) return { seed: k }
            const v = intercept + slope * k
            return { raw: decimals > 0 ? v.toFixed(decimals) : formatNumber(v) }
        }
    }

    if (kind === 'date') {
        const step = averageStep(info.map(s => s.serial))
        const start = info[0].serial
        return (k) => {
            if (k >= 0 && k < n) return { seed: k }
            return { raw: writeDate(start + Math.round(k * step), info[mod(k, n)]) }
        }
    }

    if (kind === 'name') {
        if (!info.every(s => s.list === info[0].list)) return copy
        const step = Math.round(averageStep(info.map(s => s.index))) || 1
        const { items, index } = info[0]
        return (k) => {
            if (k >= 0 && k < n) return { seed: k }
            return { raw: applyCase(items[mod(index + k * step, items.length)], info[mod(k, n)].case) }
        }
    }

    if (kind === 'textNumber') {
        if (!info.every(s => s.prefix === info[0].prefix)) return copy
        const step = Math.round(averageStep(info.map(s => s.value))) || (n === 1 ? 1 : 0)
        const first = info[0]
        return (k) => {
            if (k >= 0 && k < n) return { seed: k }
            const value = Math.abs(first.value + k * step)
            const digits = first.zeroPadded ? String(value).padStart(first.width, '0') : String(value)
            return { raw: first.prefix + digits }
        }
    }

    return copy
}
