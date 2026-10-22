// The format golden set end to end: plan with the pure planner, apply
// through the engine, then check every `expect` entry against the real
// engine (styles, displayed text, raw values, frozen rows, undo steps).
import { describe, it, expect } from 'vitest'
import { createEngine } from '../engine/core.js'
import { parseCellAddress } from '../engine/address.js'
import { planFormat } from './formatPlan.js'
import { parseModelResponse } from './validate.js'
import { loadFixtureRows, loadEval } from '../test/fixtures.js'

const golden = loadEval('format-prompts.json')
const measureText = (text, style) => Math.round(text.length * (style.bold ? 8 : 7) * style.fontSize / 13)

function engineWith(name) {
    const rows = loadFixtureRows(name)
    const engine = createEngine(rows.length + 20, 20)
    engine.setCells(0, 0, rows, 'load')
    return engine
}

/** Validate the action, plan it against the engine, apply it. Returns the result code. */
function run(engine, action) {
    const parsed = parseModelResponse(JSON.stringify(action))
    expect(parsed.ok).toBe(true)
    const plan = planFormat(parsed.action, engine.getFormatSheet(), measureText)
    if (plan.result !== 'OK') return plan.result
    return engine.applyFormat(plan) ? 'OK' : 'NO_CHANGES'
}

function snapshot(engine) {
    const used = engine.getUsedRange()
    const out = []
    for (let r = 0; r <= used.r2; r++) for (let c = 0; c <= used.c2; c++) out.push(engine.getStyle(r, c))
    return { styles: out, frozen: engine.frozenRows, widths: Array.from({ length: used.c2 + 1 }, (_, c) => engine.getColWidth(c)) }
}

// f03 lists J22 as blank, but in sales.tsv the blank row 19 shifts the
// orders down: J22 is ORD-1020 ($3,344.00) and the blank Total is J23
// (ORD-1021). We check the intent (a blank stays blank) on J23.
const ERRATA = { 'f03:J22': { cell: 'J23', display: '' } }

describe('format golden set through the engine (sales.tsv)', () => {
    for (const c of golden.cases) {
        it(`${c.id}: ${c.prompt}`, () => {
            const engine = engineWith('sales.tsv')
            if (c.id === 'f10') engine.deleteRow(32) // precondition: drop the totals row
            const before = snapshot(engine)
            const undoBefore = engine.undoLabel()
            const result = run(engine, c.action)
            for (const raw of c.expect) {
                const check = ERRATA[`${c.id}:${raw.cell}`] ?? raw
                if (check.result) {
                    expect(result).toBe(check.result)
                    expect(engine.undoLabel()).toBe(undoBefore) // no undo entry
                    expect(snapshot(engine)).toEqual(before)
                    continue
                }
                if (check.frozenRows !== undefined) { expect(engine.frozenRows).toBe(check.frozenRows); continue }
                if (check.undoSteps !== undefined) {
                    if (result === 'NO_CHANGES') { expect(engine.undoLabel()).toBe(undoBefore); continue }
                    engine.undo()
                    expect(snapshot(engine)).toEqual(before)
                    engine.redo()
                    continue
                }
                const at = parseCellAddress(check.cell)
                if (check.style) {
                    const style = engine.getStyle(at.row, at.col)
                    for (const [k, v] of Object.entries(check.style)) expect(style[k], `${check.cell}.${k}`).toBe(v)
                }
                if (check.display !== undefined) expect(engine.getDisplay(at.row, at.col), check.cell).toBe(check.display)
                if (check.raw !== undefined) expect(engine.getCell(at.row, at.col).raw).toBe(check.raw)
            }
        })
    }

    it('f04 unfreezes in one undo step when something was frozen', () => {
        const engine = engineWith('sales.tsv')
        engine.setFreeze({ rows: 1 })
        expect(run(engine, { type: 'format_sheet', freezeRows: 0 })).toBe('OK')
        expect(engine.frozenRows).toBe(0)
        engine.undo()
        expect(engine.frozenRows).toBe(1)
    })

    it('f06 after f01 removes the formatting in one undo step', () => {
        const engine = engineWith('sales.tsv')
        run(engine, golden.cases[0].action)
        expect(engine.getDisplay(5, 8)).toBe('10%') // I6 holds 0.1
        expect(run(engine, golden.cases[5].action)).toBe('OK')
        expect(engine.getStyle(0, 0).bold).toBe(false)
        expect(engine.getDisplay(1, 7)).toBe('$1,200.00')
        expect(engine.getDisplay(5, 8)).toBe('0.1')
        engine.undo()
        expect(engine.getStyle(0, 0).bold).toBe(true)
        expect(engine.getDisplay(5, 8)).toBe('10%')
    })

    it('styles follow structure: insert/delete rows and columns, with undo', () => {
        const engine = engineWith('sales.tsv')
        run(engine, golden.cases[0].action) // f01
        engine.insertRow(1)
        expect(engine.getStyle(0, 0).bold).toBe(true) // header did not move
        expect(engine.getStyle(33, 0).bold).toBe(true) // totals row moved down to 34
        expect(engine.getDisplay(2, 7)).toBe('$1,200.00')
        engine.insertColumn(0)
        expect(engine.getDisplay(2, 8)).toBe('$1,200.00')
        expect(engine.getStyle(0, 1).bg).toBe('#f0f0f0')
        engine.undo()
        engine.undo()
        expect(engine.getStyle(32, 0).bold).toBe(true)
    })
})

describe('format on sales-large.tsv', () => {
    it('f01 bolds the totals row at row 2,992 and applies in under 300 ms', () => {
        const engine = engineWith('sales-large.tsv')
        const t0 = performance.now()
        const result = run(engine, golden.cases[0].action)
        const ms = performance.now() - t0
        console.log(`[perf] plan + apply f01 over sales-large.tsv: ${ms.toFixed(1)} ms`)
        expect(result).toBe('OK')
        expect(engine.getCell(2991, 0).raw).toBe('Total')
        expect(engine.getStyle(2991, 0).bold).toBe(true)
        expect(engine.getStyle(2990, 0).bold).toBe(false)
        expect(engine.getStyle(0, 0).bg).toBe('#f0f0f0')
        expect(engine.frozenRows).toBe(1)
        expect(ms).toBeLessThan(300)
    })

    it('every golden action applies to sales-large.tsv with the same result codes', () => {
        for (const c of golden.cases) {
            const engine = engineWith('sales-large.tsv')
            if (c.id === 'f10') engine.deleteRow(2991)
            const result = run(engine, c.action)
            // On an unformatted, unfrozen sheet "unfreeze" and "remove all formatting" change
            // nothing; freezing 50 rows is fine on a 2,992-row sheet.
            const special = { f04: 'NO_CHANGES', f06: 'NO_CHANGES', f08: 'OK' }
            const expected = special[c.id] ?? c.expect.find(e => e.result)?.result ?? 'OK'
            expect(result, c.id).toBe(expected)
        }
    })
})
