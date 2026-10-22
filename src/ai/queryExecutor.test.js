import { describe, it, expect } from 'vitest'
import { executeQuery, locateBody } from './queryExecutor.js'
import { parseModelResponse } from './validate.js'
import { createMockProvider } from './mockProvider.js'
import { runAiRequest } from './runRequest.js'
import { buildSheetContext } from './context.js'
import { loadFixtureTable, loadEval } from '../test/fixtures.js'

const large = loadFixtureTable('sales-large.tsv')
const small = loadFixtureTable('sales.tsv')
const golden = loadEval('queries.json')

/** Validate like the app does, then execute. */
function runPlanText(text, table) {
    const parsed = parseModelResponse(text)
    if (!parsed.ok) return { error: parsed.error, detail: parsed.detail }
    return executeQuery(parsed.action, table)
}

const close = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 0.01 : a === b)
const sameRow = (a, b) => a.length === b.length && a.every((v, i) => close(v, b[i]))

/** AI_CONTRACT.md §5 comparison. */
function expectMatches(actual, expected, plan) {
    if (expected.error) {
        expect(actual.error).toBe(expected.error)
        if (expected.detail) expect(actual.detail).toBe(expected.detail)
        return
    }
    expect(actual.error).toBeUndefined()
    expect(actual.columns).toEqual(expected.columns)
    expect(actual.rowCount).toBe(expected.rowCount)
    expect(actual.truncated).toBe(expected.truncated)
    if (expected.rows) {
        expect(actual.rows).toHaveLength(expected.rows.length)
        if (plan.sort?.length) {
            expected.rows.forEach((row, i) => expect(sameRow(actual.rows[i], row), `row ${i}: ${JSON.stringify(actual.rows[i])} vs ${JSON.stringify(row)}`).toBe(true))
        } else {
            // Order only matters when the plan sorts: match as a multiset.
            const left = [...actual.rows]
            for (const row of expected.rows) {
                const k = left.findIndex(r => sameRow(r, row))
                expect(k, `missing row ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(0)
                left.splice(k, 1)
            }
        }
    }
    if (expected.rowsPreview) {
        // Previews are the first 10 rows; unsorted row results keep sheet order.
        expected.rowsPreview.forEach((row, i) => expect(sameRow(actual.rows[i], row), `preview row ${i}`).toBe(true))
    }
}

describe('golden queries over sales-large.tsv', () => {
    for (const c of golden.cases) {
        it(`${c.id}: ${c.prompt}`, () => {
            expectMatches(runPlanText(JSON.stringify(c.plan), large), c.expect, c.plan)
        })
    }
})

describe('golden queries through the mock provider (prose and fences)', () => {
    it('every golden prompt round-trips: mock text → parse → validate → execute', async () => {
        const provider = createMockProvider()
        const texts = await Promise.all(golden.cases.map(c => provider.complete({ system: '', user: c.prompt })))
        const shapes = new Set()
        golden.cases.forEach((c, i) => {
            const text = texts[i].text
            shapes.add(text.startsWith('{') ? 'bare' : text.startsWith('```') ? 'fence' : 'prose')
            expectMatches(runPlanText(text, large), c.expect, c.plan)
        })
        // The mock varies its wrapping; make sure more than one shape was exercised.
        expect(shapes.size).toBeGreaterThan(1)
    })

    it('runAiRequest returns validated actions and READ_ONLY for the mutation', async () => {
        const provider = createMockProvider()
        const context = buildSheetContext(large, {})
        const results = await Promise.all(golden.cases.map(c => runAiRequest({ provider, prompt: c.prompt, context })))
        golden.cases.forEach((c, i) => {
            const r = results[i]
            if (c.expect.error === 'READ_ONLY') {
                expect(r).toMatchObject({ ok: false, error: 'READ_ONLY' })
            } else {
                expect(r.ok).toBe(true)
                expect(r.action).toEqual(c.plan)
                expectMatches(executeQuery(r.action, large), c.expect, c.plan)
            }
            expect(typeof r.rawText).toBe('string')
        })
    })

    it('runAiRequest turns provider failures into PROVIDER_ERROR', async () => {
        const provider = { name: 'x', complete: async () => { throw Object.assign(new Error('Rate limited'), { code: 'PROVIDER_RATE_LIMIT' }) } }
        const r = await runAiRequest({ provider, prompt: 'hi', context: {} })
        expect(r).toEqual({ ok: false, error: 'PROVIDER_ERROR', detail: 'PROVIDER_RATE_LIMIT: Rate limited', rawText: null })
    })
})

const q = (plan, table = small) => executeQuery({ type: 'query', ...plan }, table)

describe('executor on messy data (sales.tsv)', () => {
    it('groups " West " and "west" with "West" under the first-seen label', () => {
        const r = q({ groupBy: ['region'], aggregates: [{ fn: 'sum', column: 'total' }, { fn: 'count', column: 'Order ID' }] })
        expect(r.columns).toEqual(['Region', 'sum(Total)', 'count(Order ID)'])
        expect(r.rows).toContainEqual(['West', 15787.9, 8])
        expect(r.rows).toContainEqual(['East', 23304.36, 8])
        expect(r.rows).toHaveLength(4)
        expect(q({ filters: [{ column: 'Region', op: 'eq', value: ' WEST' }], aggregates: [{ fn: 'count', column: 'Region' }] }).rows).toEqual([[8]])
    })

    it('treats N/A as not a number but as a non-empty cell', () => {
        const r = q({
            filters: [{ column: 'Region', op: 'eq', value: 'South' }],
            aggregates: [{ fn: 'sum', column: 'Units' }, { fn: 'count', column: 'Units' }, { fn: 'avg', column: 'Units' }],
        })
        expect(r.rows).toEqual([[91, 7, 15.17]])
    })

    it('reads 10% and 0.1 as the same number', () => {
        const pct = q({ filters: [{ column: 'Discount', op: 'eq', value: '10%' }], columns: ['Order ID', 'Discount'] })
        const dec = q({ filters: [{ column: 'Discount', op: 'eq', value: 0.1 }], columns: ['Order ID', 'Discount'] })
        expect(pct.rowCount).toBe(8)
        expect(dec.rows).toEqual(pct.rows)
        expect(pct.rows).toContainEqual(['ORD-1005', '0.1'])
    })

    it('compares all three date shapes as dates', () => {
        const day = q({ filters: [{ column: 'Date', op: 'gte', value: '2024-01-15' }, { column: 'Date', op: 'lte', value: '15 January 2024' }], columns: ['Order ID', 'Date'] })
        expect(day.rows).toEqual([['ORD-1005', '2024-01-15'], ['ORD-1006', '15 Jan 2024']])
        const before = q({ filters: [{ column: 'Date', op: 'lt', value: '1/9/2024' }], columns: ['Order ID'] })
        expect(before.rows).toEqual([['ORD-1001'], ['ORD-1002'], ['ORD-1003']])
        // A date value never matches a non-date cell.
        expect(q({ filters: [{ column: 'Region', op: 'gt', value: '2024-01-01' }], aggregates: [{ fn: 'count', column: 'Region' }] }).rows).toEqual([[0]])
    })

    it('excludes the totals row by default and includes it on request', () => {
        const aggs = [{ fn: 'count', column: 'Order ID' }, { fn: 'countDistinct', column: 'Order ID' }, { fn: 'sum', column: 'Units' }, { fn: 'sum', column: 'Total' }]
        expect(q({ aggregates: aggs }).rows).toEqual([[30, 29, 431, 74431.12]])
        expect(q({ excludeTotalsRow: false, aggregates: aggs }).rows).toEqual([[31, 30, 862, 148862.24]])
        expect(locateBody(small.rows)).toEqual({ end: 31, totalsIndex: 31 })
    })

    it('skips the blank row', () => {
        const r = q({})
        expect(r.rowCount).toBe(30)
        expect(r.rows.some(row => row.every(v => v.trim() === ''))).toBe(false)
    })

    it('clamps the limit to 500 and reports truncation', () => {
        expect(q({ limit: 100000 })).toMatchObject({ rowCount: 30, truncated: false })
        expect(q({ limit: 2 })).toMatchObject({ rowCount: 2, truncated: true })
        expect(q({ limit: 100000 }, large)).toMatchObject({ rowCount: 500, truncated: true })
        expect(q({}, large)).toMatchObject({ rowCount: 500, truncated: true })
    })

    it('compares numbers numerically across formats for eq', () => {
        const r = q({ filters: [{ column: 'Unit Price', op: 'eq', value: 79 }], columns: ['Order ID', 'Unit Price'] })
        expect(r.rows).toEqual([['ORD-1006', '79'], ['ORD-1015', '$79.00'], ['ORD-1022', '$79.00']])
    })

    it('fails numeric comparisons when either side is not a number', () => {
        expect(q({ filters: [{ column: 'Units', op: 'gt', value: 'lots' }], aggregates: [{ fn: 'count', column: 'Units' }] }).rows).toEqual([[0]])
        expect(q({ filters: [{ column: 'Units', op: 'gte', value: 0 }], aggregates: [{ fn: 'count', column: 'Units' }] }).rows).toEqual([[29]])
    })

    it('handles contains / endsWith / isEmpty / notEmpty / neq', () => {
        const count = (filters) => q({ filters, aggregates: [{ fn: 'count', column: 'Order ID' }] }).rows[0][0]
        expect(count([{ column: 'Product', op: 'contains', value: 'DESK' }])).toBe(7)
        expect(count([{ column: 'Sales Rep', op: 'endsWith', value: 'nair' }])).toBe(6)
        expect(count([{ column: 'Discount', op: 'isEmpty' }])).toBe(2)
        expect(count([{ column: 'Total', op: 'notEmpty' }])).toBe(29)
        expect(count([{ column: 'Region', op: 'neq', value: 'west' }])).toBe(22)
    })

    it('sorts numbers before text, stable, multi-key', () => {
        const asc = q({ columns: ['Order ID', 'Units'], sort: [{ column: 'units' }] })
        expect(asc.rows.slice(0, 3)).toEqual([['ORD-1013', '2'], ['ORD-1027', '2'], ['ORD-1005', '3']])
        expect(asc.rows.at(-1)).toEqual(['ORD-1021', 'N/A'])
        const multi = q({ groupBy: ['Category', 'Region'], aggregates: [{ fn: 'count', column: 'Order ID', as: 'n' }], sort: [{ column: 'category' }, { column: 'n', dir: 'desc' }] })
        expect(multi.rows[0][0]).toBe('Accessories')
        for (let i = 1; i < multi.rows.length; i++) {
            const [a, b] = [multi.rows[i - 1], multi.rows[i]]
            expect(a[0].toLowerCase() <= b[0].toLowerCase()).toBe(true)
            if (a[0] === b[0]) expect(a[2] >= b[2]).toBe(true)
        }
    })

    it('returns one row for aggregates over zero matches, null for numeric fns', () => {
        const r = q({ filters: [{ column: 'Region', op: 'eq', value: 'Mars' }], aggregates: [{ fn: 'count', column: 'Total' }, { fn: 'sum', column: 'Total' }, { fn: 'max', column: 'Total' }] })
        expect(r).toEqual({ columns: ['count(Total)', 'sum(Total)', 'max(Total)'], rows: [[0, null, null]], rowCount: 1, truncated: false })
    })

    it('returns distinct groups for groupBy without aggregates', () => {
        const r = q({ groupBy: ['Region'], sort: [{ column: 'Region' }] })
        expect(r.rows).toEqual([['East'], ['North'], ['South'], ['West']])
    })

    it('reports unknown columns, unknown sort columns and non-query plans', () => {
        expect(q({ filters: [{ column: 'Territory', op: 'eq', value: 'x' }] })).toEqual({ error: 'UNKNOWN_COLUMN', detail: 'UNKNOWN_COLUMN:Territory' })
        expect(q({ columns: ['Order ID', 'Nope'] }).error).toBe('UNKNOWN_COLUMN')
        expect(q({ groupBy: ['Region'], aggregates: [{ fn: 'sum', column: 'Total', as: 'S' }], sort: [{ column: 'Total' }] }))
            .toEqual({ error: 'UNKNOWN_SORT_COLUMN', detail: 'UNKNOWN_SORT_COLUMN:Total' })
        expect(executeQuery({ type: 'format_sheet' }, small).error).toBe('READ_ONLY')
        expect(executeQuery({ type: 'query', filters: [{ column: 'Total', op: 'between' }] }, small).error).toBe('UNKNOWN_OP')
        expect(executeQuery({ type: 'query', aggregates: [{ fn: 'median', column: 'Total' }] }, small).error).toBe('UNKNOWN_FN')
    })

    it('returns raw, untrimmed cell text for row results', () => {
        const r = q({ filters: [{ column: 'Order ID', op: 'eq', value: 'ORD-1005' }], columns: ['Region'] })
        expect(r.rows).toEqual([['West ']])
    })
})

// ── performance ─────────────────────────────────────────────

/** Deterministic 100,000-row table of the sales shape, messy values included. */
function generateSales(n) {
    let seed = 12345
    const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    }
    const pick = (arr) => arr[Math.floor(rand() * arr.length)]
    const regions = ['North', 'South', 'East', 'West', 'Central', 'West ', 'west', ' east']
    const reps = ['Aarav Shah', 'Priya Nair', 'Ben Carter', 'Alice Wong', 'Marco Rossi', 'Chen Wei']
    const products = [['Laptop Pro', 'Electronics'], ['Desk Chair', 'Furniture'], ['USB-C Hub', 'Accessories'], ['Office Suite', 'Software']]
    const discounts = ['10%', '0.1', '5%', '', 'n/a', '15 %']
    const rows = []
    for (let i = 0; i < n; i++) {
        const [product, category] = pick(products)
        const units = Math.floor(rand() * 60) + 1
        const price = Math.round(rand() * 120000) / 100
        const total = units * price
        const day = 1 + Math.floor(rand() * 28)
        const date = i % 3 === 0 ? `2024-02-${String(day).padStart(2, '0')}` : i % 3 === 1 ? `2/${day}/2024` : `${day} Feb 2024`
        rows.push([`ORD-${100000 + i}`, date, pick(regions), pick(reps), product, category,
            i % 997 === 0 ? 'N/A' : String(units), `$${price.toFixed(2)}`, pick(discounts),
            `$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`])
        if (i % 5000 === 4999) rows.push(['', '', '', '', '', '', '', '', '', ''])
    }
    rows.push(['Total', '', '', '', '', '', '', '', '', ''])
    return { header: large.header, rows }
}

describe('performance budgets', () => {
    it('two-level group-by over 100,000 generated rows < 500 ms', () => {
        const table = generateSales(100000)
        const plan = { type: 'query', groupBy: ['Region', 'Category'], aggregates: [{ fn: 'sum', column: 'Total', as: 'Total Sales' }], sort: [{ column: 'Region' }, { column: 'Total Sales', dir: 'desc' }] }
        const t0 = performance.now()
        const r = executeQuery(plan, table)
        const ms = performance.now() - t0
        console.log(`[perf] 2-level group-by over ${table.rows.length} rows: ${ms.toFixed(1)} ms`)
        expect(r.rowCount).toBe(20) // 5 regions × 4 categories after normalisation
        expect(ms).toBeLessThan(500)
    })

    it('each golden plan over sales-large.tsv < 50 ms', () => {
        const timings = []
        for (const c of golden.cases) {
            const t0 = performance.now()
            runPlanText(JSON.stringify(c.plan), large)
            const ms = performance.now() - t0
            timings.push(`${c.id}=${ms.toFixed(1)}`)
            expect(ms, c.id).toBeLessThan(50)
        }
        console.log(`[perf] golden plans over sales-large (ms, first run, incl. parse+validate): ${timings.join(' ')}`)
    })
})
