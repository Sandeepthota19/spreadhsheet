// Regression tests for defects found in the original engine, plus
// structural behaviour (insert/delete, sizes, #REF!, recalculation).
import { describe, it, expect } from 'vitest'
import { createEngine, DEFAULT_COL_WIDTH } from './core.js'

describe('defects in the original engine', () => {
    it('a range followed by an operator parses (=SUM(A1:A2)*2 was #PARSE!)', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '10')
        engine.setCell(1, 0, '20')
        engine.setCell(2, 0, '=SUM(A1:A2)*2')
        expect(engine.getCell(2, 0).computed).toBe(60)
    })

    it('a cell inside a range triggers recalculation (only endpoints were tracked)', () => {
        const engine = createEngine(10, 10)
        engine.setCells(0, 0, [['1'], ['2'], ['3'], ['4']])
        engine.setCell(5, 0, '=SUM(A1:A4)')
        engine.setCell(1, 0, '20')
        expect(engine.getCell(5, 0).computed).toBe(28)
    })

    it('dates are not read as numbers (2024-01-03 was 2024)', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '2024-01-03')
        engine.setCell(1, 0, '1/8/2024')
        expect(engine.getCell(0, 0).computed).toBe('2024-01-03')
        expect(engine.getDisplay(1, 0)).toBe('1/8/2024')
    })

    it('a reference to a deleted row becomes #REF! instead of silently pointing at the next row', () => {
        const engine = createEngine(10, 10)
        engine.setCells(0, 0, [['1'], ['2'], ['3']])
        engine.setCell(0, 1, '=A2*10')
        engine.deleteRow(1)
        expect(engine.getCell(0, 1).raw).toBe('=#REF!*10')
        expect(engine.getCell(0, 1).error).toBe('#REF!')
        engine.undo()
        expect(engine.getCell(0, 1).raw).toBe('=A2*10')
        expect(engine.getCell(0, 1).computed).toBe(20)
    })

    it('AVG ignores blanks instead of counting them as zero', () => {
        const engine = createEngine(10, 10)
        engine.setCells(0, 0, [['2'], [''], ['4']])
        engine.setCell(4, 0, '=AVG(A1:A3)')
        expect(engine.getCell(4, 0).computed).toBe(3)
    })

    it('a long dependency chain does not overflow the stack', () => {
        const engine = createEngine(20001, 2)
        engine.setCell(0, 0, '1')
        engine.setCell(1, 0, '=A1+1')
        engine.fill({ r1: 1, c1: 0, r2: 1, c2: 0 }, { r1: 1, c1: 0, r2: 20000, c2: 0 })
        expect(engine.getCell(20000, 0).computed).toBe(20001)
        engine.setCell(0, 0, '10')
        expect(engine.getCell(20000, 0).computed).toBe(20010)
    })

    it('unary minus and division by zero', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '=-2*3')
        engine.setCell(0, 1, '=1/0')
        expect(engine.getCell(0, 0).computed).toBe(-6)
        expect(engine.getCell(0, 1).error).toBe('#DIV/0!')
    })
})

describe('structure', () => {
    it('ranges grow when rows are inserted inside them and shrink on delete', () => {
        const engine = createEngine(20, 5)
        engine.setCells(0, 0, [['1'], ['2'], ['3'], ['4']])
        engine.setCell(10, 0, '=SUM(A1:A4)')
        engine.insertRow(2)
        expect(engine.getCell(11, 0).raw).toBe('=SUM(A1:A5)')
        engine.deleteRows(0, 2)
        expect(engine.getCell(9, 0).raw).toBe('=SUM(A1:A3)')
        expect(engine.getCell(9, 0).computed).toBe(7)
        engine.undo()
        engine.undo()
        expect(engine.getCell(10, 0).raw).toBe('=SUM(A1:A4)')
    })

    it('column sizes move with their columns; a new column gets the default width', () => {
        const engine = createEngine(10, 10)
        engine.setColWidths([{ c: 3, width: 300 }])
        engine.insertColumn(3)
        expect(engine.getColWidth(3)).toBe(DEFAULT_COL_WIDTH)
        expect(engine.getColWidth(4)).toBe(300)
        engine.undo()
        expect(engine.getColWidth(3)).toBe(300)
    })

    it('row heights and styles move with their rows', () => {
        const engine = createEngine(10, 10)
        engine.setRowHeights([{ r: 2, height: 40 }])
        engine.setStyle({ r1: 2, c1: 0, r2: 2, c2: 0 }, { bold: true })
        engine.insertRow(0)
        expect(engine.getRowHeight(3)).toBe(40)
        expect(engine.getStyle(3, 0).bold).toBe(true)
        engine.deleteRow(3)
        expect(engine.getStyle(3, 0).bold).toBe(false)
        engine.undo()
        expect(engine.getStyle(3, 0).bold).toBe(true)
    })

    it('edits recalculate only dependent cells', () => {
        const engine = createEngine(1000, 5)
        engine.setCells(0, 0, Array.from({ length: 500 }, (_, i) => [String(i)]))
        engine.setCell(0, 1, '=A1*2')
        engine.fill({ r1: 0, c1: 1, r2: 0, c2: 1 }, { r1: 0, c1: 1, r2: 499, c2: 1 })
        engine.setCell(10, 0, '100')
        expect(engine.getCell(10, 1).computed).toBe(200)
        expect(engine.getCell(11, 1).computed).toBe(22)
    })

    it('clear and style a range as one undo step each', () => {
        const engine = createEngine(10, 10)
        engine.setCells(0, 0, [['a', 'b'], ['c', 'd']])
        engine.setStyle({ r1: 0, c1: 0, r2: 1, c2: 1 }, { italic: true })
        engine.clearRange({ r1: 0, c1: 0, r2: 1, c2: 1 })
        expect(engine.getCell(1, 1).raw).toBe('')
        engine.undo()
        expect(engine.getCell(1, 1).raw).toBe('d')
        engine.undo()
        expect(engine.getStyle(0, 0).italic).toBe(false)
    })

    it('number formats change the display, never the stored value', () => {
        const engine = createEngine(10, 10)
        engine.setCells(0, 0, [['$1,200.00', '0.1', 'n/a', '15 Jan 2024']])
        engine.setStyle({ r1: 0, c1: 0, r2: 0, c2: 0 }, { numberFormat: 'number' })
        engine.setStyle({ r1: 0, c1: 1, r2: 0, c2: 2 }, { numberFormat: 'percent' })
        engine.setStyle({ r1: 0, c1: 3, r2: 0, c2: 3 }, { numberFormat: 'date' })
        expect(engine.getDisplay(0, 0)).toBe('1,200.00')
        expect(engine.getDisplay(0, 1)).toBe('10%')
        expect(engine.getDisplay(0, 2)).toBe('n/a')
        expect(engine.getDisplay(0, 3)).toBe('2024-01-15')
        expect(engine.getCell(0, 0).raw).toBe('$1,200.00')
    })
})
