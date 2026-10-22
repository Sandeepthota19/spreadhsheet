import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { makeSeries } from './fill.js'
import { loadFixtureRows } from '../test/fixtures.js'

const values = (seeds, ks) => {
    const series = makeSeries(seeds)
    return ks.map(k => {
        const r = series(k)
        return r.raw !== undefined ? r.raw : seeds[r.seed]
    })
}

function salesEngine() {
    const engine = createEngine(100, 20)
    engine.setCells(0, 0, loadFixtureRows('sales.tsv'), 'load')
    return engine
}

describe('fill series', () => {
    it('copies a single number and continues 1, 2', () => {
        expect(values(['5'], [1, 2])).toEqual(['5', '5'])
        expect(values(['1', '2'], [2, 3, -1])).toEqual(['3', '4', '0'])
        expect(values(['0.5', '1.0'], [2])).toEqual(['1.5'])
    })

    it('increments text ending in a number and keeps zero padding', () => {
        expect(values(['Item 1'], [1, 2])).toEqual(['Item 2', 'Item 3'])
        expect(values(['Q4'], [1])).toEqual(['Q5'])
        expect(values(['2024-W01'], [1, 9])).toEqual(['2024-W02', '2024-W10'])
        expect(values(['W009'], [991])).toEqual(['W1000'])
        expect(values(['ORD-1001', 'ORD-1002'], [2, 3, 4])).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
    })

    it('steps dates by the seed delta and keeps each seed format', () => {
        expect(values(['2024-01-15'], [1, 17])).toEqual(['2024-01-16', '2024-02-01'])
        expect(values(['1/15/2024', '1/22/2024'], [2])).toEqual(['1/29/2024'])
        expect(values(['15 Jan 2024'], [1])).toEqual(['16 Jan 2024'])
        expect(values(['31 January 2024'], [1])).toEqual(['1 February 2024'])
    })

    it('cycles weekday and month names preserving case', () => {
        expect(values(['Mon'], [1, 6, 7])).toEqual(['Tue', 'Sun', 'Mon'])
        expect(values(['FRIDAY'], [1])).toEqual(['SATURDAY'])
        expect(values(['jan', 'mar'], [2])).toEqual(['may'])
        expect(values(['Dec'], [1])).toEqual(['Jan'])
    })

    it('repeats plain text and mixed seeds', () => {
        expect(values(['a', 'b'], [2, 3, 4])).toEqual(['a', 'b', 'a'])
        expect(values(['1', 'x'], [2])).toEqual(['1'])
    })
})

describe('fill handle on sales.tsv (acceptance)', () => {
    it('A2:A3 dragged to A6 continues the order ids; one undo restores', () => {
        const engine = salesEngine()
        // The fixture already holds ORD-1003..1005 in A4:A6; scribble over them
        // first so the fill and its undo are both observable.
        engine.setCells(3, 0, [['x'], ['y'], ['z']])
        engine.fill({ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 0, r2: 5, c2: 0 })
        expect([3, 4, 5].map(r => engine.getCell(r, 0).raw)).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
        expect(engine.undoLabel()).toBe('Fill')
        engine.undo()
        expect([3, 4, 5].map(r => engine.getCell(r, 0).raw)).toEqual(['x', 'y', 'z'])
    })

    it('relative references shift, $ references stay pinned, row insert keeps them right', () => {
        const engine = salesEngine()
        engine.setCell(1, 10, '=G2*H2')
        engine.setCell(1, 11, '=$G$2*H2')
        engine.fill({ r1: 1, c1: 10, r2: 1, c2: 11 }, { r1: 1, c1: 10, r2: 31, c2: 11 })
        expect(engine.getCell(31, 10).raw).toBe('=G32*H32')
        expect(engine.getCell(31, 11).raw).toBe('=$G$2*H32')
        expect(engine.getCell(1, 10).computed).toBe(4800)
        engine.insertRow(9)
        expect(engine.getCell(32, 11).raw).toBe('=$G$2*H33')
        expect(engine.getCell(32, 10).raw).toBe('=G33*H33')
    })

    it('mixed references: $A1 pins the column, A$1 pins the row', () => {
        const engine = createEngine(20, 10)
        engine.setCell(0, 2, '=$A1+A$1')
        engine.fill({ r1: 0, c1: 2, r2: 0, c2: 2 }, { r1: 0, c1: 2, r2: 2, c2: 3 })
        // The fill is vertical (rows grow), so only rows change.
        expect(engine.getCell(2, 2).raw).toBe('=$A3+A$1')
        engine.fill({ r1: 0, c1: 2, r2: 0, c2: 2 }, { r1: 0, c1: 2, r2: 0, c2: 4 })
        expect(engine.getCell(0, 4).raw).toBe('=$A1+C$1')
    })

    it('B2:B4 (three date formats) filled to B8 keeps each seed format', () => {
        const engine = salesEngine()
        engine.fill({ r1: 1, c1: 1, r2: 3, c2: 1 }, { r1: 1, c1: 1, r2: 7, c2: 1 })
        const out = [4, 5, 6, 7].map(r => engine.getCell(r, 1).raw)
        expect(out[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/) // like B2 2024-01-03
        expect(out[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/) // like B3 2024-01-05
        expect(out[2]).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/) // like B4 1/8/2024
        expect(out[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(out).toEqual(['2024-01-11', '2024-01-13', '1/16/2024', '2024-01-18'])
    })

    it('filled cells inherit the seed style and dragging back clears', () => {
        const engine = createEngine(20, 5)
        engine.setCell(0, 0, '1')
        engine.setStyle({ r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true })
        engine.fill({ r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 })
        expect(engine.getStyle(3, 0).bold).toBe(true)
        engine.fill({ r1: 0, c1: 0, r2: 3, c2: 0 }, { r1: 0, c1: 0, r2: 1, c2: 0 })
        expect(engine.getCell(2, 0).raw).toBe('')
        expect(engine.getCell(1, 0).raw).toBe('1')
    })

    it('fills upward with a decreasing series', () => {
        const engine = createEngine(20, 5)
        engine.setCell(5, 0, 'Item 5')
        engine.fill({ r1: 5, c1: 0, r2: 5, c2: 0 }, { r1: 3, c1: 0, r2: 5, c2: 0 })
        expect(engine.getCell(3, 0).raw).toBe('Item 3')
    })

    it('fills 5,000 formula cells well inside the 200 ms budget', () => {
        const engine = createEngine(6000, 20)
        engine.setCells(0, 0, Array.from({ length: 5001 }, (_, i) => [String(i), String(i * 2)]))
        engine.setCell(0, 2, '=A1*B1')
        const t0 = performance.now()
        engine.fill({ r1: 0, c1: 2, r2: 0, c2: 2 }, { r1: 0, c1: 2, r2: 5000, c2: 2 })
        const ms = performance.now() - t0
        console.log(`fill 5,000 formula cells: ${ms.toFixed(1)} ms`)
        expect(engine.getCell(5000, 2).computed).toBe(5000 * 10000)
        expect(ms).toBeLessThan(200)
    })
})
