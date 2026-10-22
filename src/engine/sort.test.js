import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { loadFixtureRows } from '../test/fixtures.js'

function salesEngine(name = 'sales.tsv') {
    const rows = loadFixtureRows(name)
    const engine = createEngine(rows.length + 50, 20)
    engine.setCells(0, 0, rows, 'load')
    return engine
}

const column = (engine, c, r1, r2) => {
    const out = []
    for (let r = r1; r <= r2; r++) out.push(engine.getCell(r, c).raw)
    return out
}

const J = 9, K = 10, G = 6, C = 2

describe('sort (acceptance on sales.tsv)', () => {
    it('sorts by Total descending; formulas follow their rows; totals pinned; blank row last', () => {
        const engine = salesEngine()
        engine.setCell(1, K, '=J2/G2')
        engine.fill({ r1: 1, c1: K, r2: 1, c2: K }, { r1: 1, c1: K, r2: 31, c2: K })
        expect(engine.sortByColumn(J)).toBe('asc')
        expect(engine.sortByColumn(J)).toBe('desc')
        expect(engine.getCell(1, 0).raw).toBe('ORD-1025')
        expect(engine.getCell(1, K).computed).toBe(1080)
        expect(engine.getCell(1, K).raw).toBe('=J2/G2')
        expect(engine.getCell(32, 0).raw).toBe('Total')
        // the empty row (only K's formula, no data) sorts to the very bottom of the block
        expect(engine.getCell(31, 0).raw).toBe('')
        expect(engine.getCell(30, 0).raw).toBe('ORD-1021') // blank Total, but a real row
        // third click: original order
        expect(engine.sortByColumn(J)).toBe('none')
        expect(engine.getCell(1, 0).raw).toBe('ORD-1001')
        expect(engine.getCell(18, 0).raw).toBe('')
    })

    it('a range spanning the whole block is unchanged; single refs follow rows', () => {
        const engine = salesEngine()
        // Row 1 is the header and never moves, so formulas there are a stable vantage point.
        engine.setCell(0, 11, '=SUM(G2:G32)')
        engine.setCell(0, 12, '=A2')
        const before = engine.getCell(0, 11).computed
        engine.sortByColumn(G)
        expect(engine.getCell(0, 11).raw).toBe('=SUM(G2:G32)')
        expect(engine.getCell(0, 11).computed).toBe(before)
        // A2 (ORD-1001) moved; the reference went with it.
        expect(engine.getCell(0, 12).raw).not.toBe('=A2')
        expect(engine.getCell(0, 12).computed).toBe('ORD-1001')
    })

    it('styles move with their rows', () => {
        const engine = salesEngine()
        engine.setStyle({ r1: 1, c1: 0, r2: 1, c2: 9 }, { bold: true }) // ORD-1001
        engine.sortByColumn(J)
        engine.sortByColumn(J)
        let row = -1
        for (let r = 1; r < 32; r++) if (engine.getCell(r, 0).raw === 'ORD-1001') row = r
        expect(engine.getStyle(row, 0).bold).toBe(true)
        expect(engine.getStyle(1, 0).bold).toBe(false)
    })

    it('compares numbers before text, dates as dates, text case-insensitively, stable', () => {
        const engine = createEngine(20, 3)
        engine.setCells(0, 0, [['h'], ['b'], ['10'], ['apple'], ['2'], [''], ['Banana'], ['x']])
        engine.setCells(0, 1, [['k'], ['1'], ['1'], ['1'], ['1'], ['1'], ['1'], ['1']])
        engine.sortByColumn(0)
        expect(column(engine, 0, 1, 7)).toEqual(['2', '10', 'apple', 'b', 'Banana', 'x', ''])
        const dates = createEngine(10, 2)
        dates.setCells(0, 0, [['d'], ['15 Jan 2024'], ['2024-01-03'], ['1/8/2024']])
        dates.sortByColumn(0)
        expect(column(dates, 0, 1, 3)).toEqual(['2024-01-03', '1/8/2024', '15 Jan 2024'])
    })

    it('cycles asc → desc → original even when empty rows move to the bottom', () => {
        const engine = createEngine(20, 3)
        engine.setCells(0, 0, [['k', 'v'], ['b', '1'], ['', ''], ['c', '2'], ['a', '3']])
        expect(engine.sortByColumn(0)).toBe('asc')
        expect(column(engine, 0, 1, 4)).toEqual(['a', 'b', 'c', ''])
        expect(engine.sortByColumn(0)).toBe('desc')
        expect(column(engine, 0, 1, 4)).toEqual(['c', 'b', 'a', ''])
        expect(engine.sortByColumn(0)).toBe('none')
        expect(column(engine, 0, 1, 4)).toEqual(['b', '', 'c', 'a'])
    })

    it('one undo per sort', () => {
        const engine = salesEngine()
        engine.sortByColumn(J)
        engine.undo()
        expect(column(engine, 0, 1, 3)).toEqual(['ORD-1001', 'ORD-1002', 'ORD-1003'])
    })

    it('sorts only a multi-row selection when there is one', () => {
        const engine = createEngine(10, 3)
        engine.setCells(0, 0, [['h', 'h2'], ['3', 'c'], ['1', 'a'], ['2', 'b'], ['0', 'z']])
        engine.sortRange({ r1: 1, c1: 0, r2: 3, c2: 1 }, 0, 'asc')
        expect(column(engine, 0, 1, 4)).toEqual(['1', '2', '3', '0'])
        expect(column(engine, 1, 1, 4)).toEqual(['a', 'b', 'c', 'z'])
    })
})

describe('filter (acceptance on sales.tsv)', () => {
    it('Region = West matches "West", "West " and "west"; hidden rows keep their place when sorting; undo twice', () => {
        const engine = salesEngine()
        const values = engine.getFilterValues(C)
        const west = values.find(v => v.key === 'west')
        expect(west.label).toBe('West')
        expect(west.count).toBe(8)
        expect(values[values.length - 1].label).toBe('(Blanks)')
        engine.setFilter(C, { values: ['west'], condition: null })
        const status = engine.getFilterStatus()
        expect(status).toEqual({ visible: 8, total: 31, active: true })
        const hiddenBefore = []
        for (let r = 1; r <= 32; r++) if (engine.isRowHidden(r)) hiddenBefore.push([r, engine.getCell(r, 0).raw])
        engine.sortByColumn(G)
        for (const [r, id] of hiddenBefore) {
            expect(engine.isRowHidden(r)).toBe(true)
            expect(engine.getCell(r, 0).raw).toBe(id)
        }
        // visible rows are now ascending by units
        const units = []
        for (let r = 1; r <= 32; r++) if (!engine.isRowHidden(r)) units.push(Number(engine.getCell(r, G).raw))
        expect(units).toEqual([...units].sort((a, b) => a - b))
        expect(engine.isRowHidden(32)).toBe(false) // totals row stays visible
        engine.undo()
        engine.undo()
        expect(column(engine, 0, 1, 3)).toEqual(['ORD-1001', 'ORD-1002', 'ORD-1003'])
        expect(engine.getFilterStatus().active).toBe(false)
    })

    it('a stray value far below the table does not stretch the filter or sort block', () => {
        const engine = salesEngine()
        engine.ensureCapacity(6000, 60)
        engine.setCell(4999, 51, 'hello') // AZ5000
        engine.setFilter(C, { values: ['west'], condition: null })
        expect(engine.getFilterStatus()).toEqual({ visible: 8, total: 31, active: true })
        expect(engine.isRowHidden(100)).toBe(false)
        engine.sortByColumn(J)
        expect(engine.getCell(4999, 51).raw).toBe('hello')
    })

    it('hidden rows still take part in formulas', () => {
        const engine = salesEngine()
        engine.setCell(0, 11, '=SUM(G2:G32)')
        const total = engine.getCell(0, 11).computed
        engine.setFilter(C, { values: ['west'], condition: null })
        expect(engine.getCell(0, 11).computed).toBe(total)
    })

    it('combines conditions and columns with AND; clear per column and all', () => {
        const engine = salesEngine()
        engine.setFilter(C, { values: null, condition: { op: 'contains', value: 'es' } }) // West, west
        engine.setFilter(G, { values: null, condition: { op: 'gt', value: '10' } })
        expect(engine.getFilterStatus().visible).toBe(4)
        engine.setFilter(G, null)
        expect(engine.getFilterStatus().visible).toBe(8)
        engine.setFilter(8, { values: null, condition: { op: 'isEmpty' } })
        expect(engine.getFilterStatus().visible).toBe(1)
        engine.clearFilters()
        expect(engine.getFilterStatus().active).toBe(false)
    })
})

describe('sort budget', () => {
    it('sorts 10,000 rows in under 300 ms', () => {
        const base = loadFixtureRows('sales-large.tsv')
        const rows = [base[0]]
        for (let i = 1; rows.length <= 10000; i++) rows.push(base[1 + (i % (base.length - 2))])
        const engine = createEngine(10100, 20)
        engine.setCells(0, 0, rows, 'load')
        const t0 = performance.now()
        engine.sortByColumn(1) // Date
        const ms = performance.now() - t0
        console.log(`sort 10,000 rows by Date: ${ms.toFixed(1)} ms`)
        expect(ms).toBeLessThan(300)
    })

    it('sorts sales-large.tsv by Date', () => {
        const engine = salesEngine('sales-large.tsv')
        const t0 = performance.now()
        engine.sortByColumn(1)
        console.log(`sort sales-large.tsv by Date: ${(performance.now() - t0).toFixed(1)} ms`)
        expect(engine.getCell(1, 1).raw).toMatch(/2023/)
    })
})
