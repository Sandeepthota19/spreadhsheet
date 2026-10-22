// ─────────────────────────────────────────────────────────────
//  Plain-English descriptions of validated actions, for result
//  cards ("what did the model ask for?") and the format preview.
//  Pure string building; never computes a data value.
// ─────────────────────────────────────────────────────────────
import { MAX_RESULT_ROWS } from './contract.js'

const FN_NAMES = {
    sum: 'Sum', avg: 'Average', count: 'Count', countDistinct: 'Distinct count', min: 'Minimum', max: 'Maximum',
}

const OP_TEXT = {
    eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
    contains: 'contains', startsWith: 'starts with', endsWith: 'ends with',
}

const quote = (s) => `“${s}”`

function joinAnd(items) {
    if (items.length <= 1) return items.join('')
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]
}

function describeFilter(f) {
    if (f.op === 'isEmpty') return `${f.column} is empty`
    if (f.op === 'notEmpty') return `${f.column} is not empty`
    const op = OP_TEXT[f.op] ?? f.op
    const value = typeof f.value === 'number' ? String(f.value) : (op.length > 1 ? quote(f.value ?? '') : (f.value ?? '(blank)'))
    return `${f.column} ${op} ${value}`
}

/**
 * One or two sentences describing a query plan, e.g.
 * "Sum of Total as “Total Sales”, grouped by Region, sorted by Total Sales (high → low), top 3."
 * @param {object} plan validated query plan
 * @returns {string}
 */
export function describeQuery(plan) {
    if (!plan || plan.type !== 'query') return 'Not a query.'
    const aggregates = plan.aggregates ?? []
    const groupBy = plan.groupBy ?? []
    const parts = []

    if (aggregates.length) {
        parts.push(aggregates.map(a => {
            const base = `${FN_NAMES[a.fn] ?? a.fn} of ${a.column}`
            return a.as ? `${base} as ${quote(a.as)}` : base
        }).join(', '))
    } else if (groupBy.length) {
        parts.push(`Distinct values of ${joinAnd(groupBy)}`)
    } else {
        parts.push(plan.columns?.length ? `Rows showing ${joinAnd(plan.columns)}` : 'Rows with all columns')
    }
    if (plan.filters?.length) parts.push(`where ${plan.filters.map(describeFilter).join(' and ')}`)
    if (aggregates.length && groupBy.length) parts.push(`grouped by ${joinAnd(groupBy)}`)

    if (plan.sort?.length) {
        const aliases = new Set(aggregates.map(a => (a.as ?? '').toLowerCase()))
        parts.push('sorted by ' + plan.sort.map(s => {
            const desc = s.dir === 'desc'
            const numeric = aliases.has(String(s.column).toLowerCase())
            const dir = numeric ? (desc ? 'high → low' : 'low → high') : (desc ? 'descending' : 'ascending')
            return `${s.column} (${dir})`
        }).join(', then '))
    }
    if (plan.limit !== undefined) {
        const n = Math.min(plan.limit, MAX_RESULT_ROWS)
        const capped = plan.limit > MAX_RESULT_ROWS ? ` (capped from ${plan.limit})` : ''
        parts.push(plan.sort?.length ? `top ${n}${capped}` : `first ${n} row${n === 1 ? '' : 's'}${capped}`)
    }
    let text = parts.join(', ') + '.'
    if (plan.excludeTotalsRow === false) text += ' The totals row is included.'
    return text
}

// ── format preview ──────────────────────────────────────────

const COLOUR_NAMES = {
    '#f0f0f0': 'grey', '#eeeeee': 'grey', '#d9d9d9': 'grey', '#cccccc': 'grey', '#808080': 'grey',
    '#cce5ff': 'blue', '#0000ff': 'blue', '#1a73e8': 'blue',
    '#ffff99': 'yellow', '#ffff00': 'yellow', '#fff2cc': 'yellow',
    '#d9ead3': 'green', '#00ff00': 'green', '#c6efce': 'green',
    '#f4cccc': 'red', '#ff0000': 'red', '#ffc7ce': 'red',
    '#ffffff': 'white', white: 'white', '#000000': 'black', '#202124': 'default colour',
}

const colourName = (hex) => COLOUR_NAMES[String(hex).toLowerCase()] ?? String(hex)

const ALIGN_TEXT = { left: 'left-aligned', center: 'centred', right: 'right-aligned' }

const colLetter = (c) => {
    let s = ''
    for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
    return s
}

function styleWords(style = {}, { withFormat = true } = {}) {
    const words = []
    if (style.bold !== undefined) words.push(style.bold ? 'bold' : 'not bold')
    if (style.italic !== undefined) words.push(style.italic ? 'italic' : 'not italic')
    if (style.underline !== undefined) words.push(style.underline ? 'underlined' : 'no underline')
    if (style.bg !== undefined) words.push(style.bg === 'white' ? 'no fill' : colourName(style.bg))
    if (style.color !== undefined) words.push(`${colourName(style.color)} text`)
    if (style.align !== undefined) words.push(ALIGN_TEXT[style.align] ?? style.align)
    if (style.fontSize !== undefined) words.push(`size ${style.fontSize}`)
    if (withFormat && style.numberFormat !== undefined) words.push(`${style.numberFormat} format`)
    return words
}

function describeColumns(columns) {
    if (columns.length === 1) {
        const { col, style } = columns[0]
        return `column ${colLetter(col)}: ${styleWords(style).join(', ') || 'no change'}`
    }
    // Several columns: name the kinds of change, not every value.
    const words = new Set()
    const formats = new Set()
    for (const { style } of columns) {
        for (const w of styleWords(style, { withFormat: false })) words.add(w)
        if (style?.numberFormat) formats.add(style.numberFormat)
    }
    if (formats.size === 1) words.add(`${[...formats][0]} format`)
    else if (formats.size > 1) words.add('number formats')
    return `${columns.length} columns: ${[...words].join(', ') || 'no change'}`
}

/**
 * Short preview of a format_sheet action, e.g.
 * "header: bold, grey, centred; 4 columns: right-aligned, number formats; freeze 1 row; totals row: bold; auto-fit columns".
 * @param {object} action validated format_sheet action
 * @returns {string}
 */
export function describeFormat(action) {
    if (!action || action.type !== 'format_sheet') return 'Not a formatting action.'
    const parts = []
    if (action.clearFormatting) parts.push('clear all formatting')
    if (action.headerStyle) {
        const words = styleWords(action.headerStyle, { withFormat: false })
        if (words.length) parts.push(`header: ${words.join(', ')}`)
    }
    if (action.bodyStyle) {
        const words = styleWords(action.bodyStyle)
        if (words.length) parts.push(`body: ${words.join(', ')}`)
    }
    if (action.columns?.length) parts.push(describeColumns(action.columns))
    if (typeof action.freezeRows === 'number') {
        parts.push(action.freezeRows === 0 ? 'unfreeze rows' : `freeze ${action.freezeRows} row${action.freezeRows === 1 ? '' : 's'}`)
    }
    if (action.totalsStyle) {
        const words = styleWords(action.totalsStyle)
        if (words.length) parts.push(`totals row: ${words.join(', ')}`)
    }
    if (action.columnWidths?.length) {
        parts.push(action.columnWidths.map(w => `column ${colLetter(w.col)} width ${w.width}px`).join(', '))
    }
    if (action.autoFitColumns) parts.push('auto-fit columns')
    return parts.length ? parts.join('; ') : 'no changes requested'
}
