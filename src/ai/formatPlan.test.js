import { describe, it, expect } from 'vitest'
import { planFormat } from './formatPlan.js'
import { parseModelResponse } from './validate.js'
import { describeFormat } from './describe.js'
import { DEFAULT_STYLE } from '../engine/style.js'
import { formatNumberDisplay } from '../engine/numberFormat.js'
import { loadFixtureRows, loadEval } from '../test/fixtures.js'

const golden = loadEval('format-prompts.json')
const action = (id) => golden.cases.find(c => c.id === id).action

/** In-memory sheet over fixture rows: styles, frozen rows and widths can be preset. */
function fakeSheet(rows, { styles = {}, frozenRows = 0, widths = {} } = {}) {
    const colCount = Math.max(...rows.map(r => r.length))
    return {
        rowCount: rows.length,
        colCount,
        getStyle: (r, c) => styles[`${r},${c}`],
        getText: (r, c) => rows[r]?.[c] ?? '',
        frozenRows,
        getColWidth: (c) => widths[c] ?? 100,
    }
}

// Deterministic stand-in for canvas measureText.
const measureText = (text, style) => Math.round(text.length * (style.bold ? 8 : 7) * style.fontSize / 13)

/** Apply a plan to a copy of the sheet and expose cell checks in A1 terms. */
function applied(sheet, plan) {
    const styles = new Map(plan.styles.map(s => [`${s.r},${s.c}`, s.style]))
    const ref = (a1) => {
        const m = a1.match(/^([A-Z]+)(\d+)$/)
        let c = 0
        for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64
        return [Number(m[2]) - 1, c - 1]
    }
    const style = (a1) => {
        const [r, c] = ref(a1)
        return styles.get(`${r},${c}`) ?? { ...DEFAULT_STYLE, ...sheet.getStyle(r, c) }
    }
    const display = (a1) => {
        const [r, c] = ref(a1)
        return formatNumberDisplay(sheet.getText(r, c), style(a1).numberFormat)
    }
    return { style, display, frozenRows: plan.frozenRows ?? sheet.frozenRows }
}

const sales = loadFixtureRows('sales.tsv')

// Golden-set disagreement with the fixture itself: f03 expects J22 to display
// "" ("blank stays blank"), but in fixtures/sales.tsv row 22 is ORD-1020
// ($3,344.00); the blank Total is ORD-1021 on row 23 (the blank row 19 shifts
// everything by one). We check the intent on J23 and assert what J22 really
// shows, rather than weakening the check.
const FIXTURE_ERRATA = {
    'f03:J22': { cell: 'J23', display: '', actual: '$3,344.00' },
}

/** Run the golden expectations that can be checked at the planner level. */
function checkExpectations(id, sheet, plan) {
    const view = applied(sheet, plan)
    for (const e of golden.cases.find(c => c.id === id).expect) {
        if (e.result) expect(plan.result, id).toBe(e.result)
        if (e.cell && e.style) expect(view.style(e.cell), `${id} ${e.cell}`).toMatchObject(e.style)
        const erratum = e.cell && FIXTURE_ERRATA[`${id}:${e.cell}`]
        if (erratum) {
            expect(view.display(e.cell), `${id} ${e.cell} (erratum)`).toBe(erratum.actual)
            expect(view.display(erratum.cell), `${id} ${erratum.cell} (erratum)`).toBe(erratum.display)
        } else if (e.cell && e.display !== undefined) {
            expect(view.display(e.cell), `${id} ${e.cell}`).toBe(e.display)
        }
        if (e.cell && e.raw !== undefined) expect(sheet.getText(...[Number(e.cell.slice(1)) - 1, e.cell.charCodeAt(0) - 65])).toBe(e.raw)
        if (e.frozenRows !== undefined) expect(view.frozenRows, id).toBe(e.frozenRows)
        if (e.undoSteps !== undefined && !e.note) expect(plan.result, `${id} must be one undo step`).toBe('OK')
    }
}

describe('golden format prompts at the planner level (sales.tsv)', () => {
    it('every golden action validates', () => {
        for (const c of golden.cases) expect(parseModelResponse(JSON.stringify(c.action)).ok, c.id).toBe(true)
    })

    for (const id of ['f01', 'f02', 'f03', 'f05', 'f07', 'f08', 'f09']) {
        it(id, () => {
            const sheet = fakeSheet(sales)
            checkExpectations(id, sheet, planFormat(action(id), sheet, measureText))
        })
    }

    it('f01: header wins, totals bold, auto-fit uses formatted text, freeze 1', () => {
        const sheet = fakeSheet(sales)
        const plan = planFormat(action('f01'), sheet, measureText)
        expect(plan.result).toBe('OK')
        const view = applied(sheet, plan)
        expect(view.style('J1')).toMatchObject({ bold: true, bg: '#f0f0f0', align: 'center', numberFormat: 'general' })
        expect(view.style('J33')).toMatchObject({ bold: true, align: 'right', numberFormat: 'currency' })
        expect(view.style('A2')).toEqual(DEFAULT_STYLE)
        expect(plan.frozenRows).toBe(1)
        expect(plan.widths).toHaveLength(10)
        // No style entry for cells outside the used range or unchanged cells.
        expect(plan.styles.every(s => s.c < 10 && s.r < 33)).toBe(true)
        expect(plan.styles.some(s => s.r === 1 && s.c === 0)).toBe(false)
        expect(describeFormat(action('f01'))).toBe('header: bold, grey, centred; 4 columns: right-aligned, number formats; freeze 1 row; totals row: bold; auto-fit columns')
    })

    it('f04: unfreeze is a change only when something is frozen', () => {
        const frozen = fakeSheet(sales, { frozenRows: 1 })
        const plan = planFormat(action('f04'), frozen, measureText)
        expect(plan).toMatchObject({ result: 'OK', frozenRows: 0, styles: [], widths: [] })
        expect(planFormat(action('f04'), fakeSheet(sales), measureText).result).toBe('NO_CHANGES')
    })

    it('f06: clear formatting resets styled cells and is NO_CHANGES on a clean sheet', () => {
        const styled = fakeSheet(sales, { styles: { '0,0': { bold: true, bg: '#f0f0f0' }, '1,7': { numberFormat: 'currency' } } })
        const plan = planFormat(action('f06'), styled, measureText)
        expect(plan.result).toBe('OK')
        expect(plan.styles).toHaveLength(2)
        checkExpectations('f06', styled, plan)
        expect(planFormat(action('f06'), fakeSheet(sales), measureText).result).toBe('NO_CHANGES')
    })

    it('f07: a column outside the used range is NO_CHANGES', () => {
        expect(planFormat(action('f07'), fakeSheet(sales), measureText)).toMatchObject({ result: 'NO_CHANGES', styles: [], widths: [] })
    })

    it('f08: freezing every used row is OUT_OF_RANGE and nothing else applies', () => {
        const sheet = fakeSheet(sales)
        const plan = planFormat({ ...action('f08'), headerStyle: { bold: true }, autoFitColumns: true }, sheet, measureText)
        expect(plan).toMatchObject({ result: 'OUT_OF_RANGE', styles: [], widths: [], frozenRows: undefined })
        expect(plan.message).toMatch(/50/)
        expect(planFormat({ type: 'format_sheet', freezeRows: 33 }, sheet, measureText).result).toBe('OUT_OF_RANGE')
        expect(planFormat({ type: 'format_sheet', freezeRows: 32 }, sheet, measureText).frozenRows).toBe(32)
    })

    it('f10: totalsStyle is dropped when the last row is an ordinary order', () => {
        const withoutTotals = fakeSheet(sales.slice(0, -1))
        const plan = planFormat(action('f10'), withoutTotals, measureText)
        expect(plan).toMatchObject({ result: 'NO_CHANGES', styles: [] })
        expect(plan.message).toMatch(/not a totals row/)
    })
})

describe('planFormat rules', () => {
    const tiny = [['Name', 'Amount', 'Note'], ['a', '1200', 'x'], ['b', '5', '']]

    it('applies in order: clear → body → columns → totals → header', () => {
        const rows = [...tiny, ['Total', '1205', '']]
        const sheet = fakeSheet(rows, { styles: { '0,1': { italic: true } } })
        const plan = planFormat({
            type: 'format_sheet',
            clearFormatting: true,
            bodyStyle: { bg: '#eeeeee', align: 'center' },
            columns: [{ col: 1, style: { align: 'right', numberFormat: 'number' } }],
            totalsStyle: { bg: '#ffff99' },
            headerStyle: { align: 'left', bold: true, numberFormat: 'currency' },
        }, sheet, measureText)
        const view = applied(sheet, plan)
        expect(view.style('B1')).toMatchObject({ italic: false, bold: true, align: 'left', numberFormat: 'general' })
        expect(view.style('B2')).toMatchObject({ bg: '#eeeeee', align: 'right', numberFormat: 'number' })
        expect(view.style('A2')).toMatchObject({ bg: '#eeeeee', align: 'center' })
        expect(view.style('B4')).toMatchObject({ bg: '#ffff99', align: 'right', numberFormat: 'number' })
        expect(view.display('B2')).toBe('1,200.00')
    })

    it('recognises a summary-line totals row without a totals label', () => {
        const rows = [...tiny, ['All orders', '1205', '']]
        const plan = planFormat({ type: 'format_sheet', totalsStyle: { bold: true } }, fakeSheet(rows), measureText)
        expect(plan.result).toBe('OK')
        expect(plan.styles.map(s => s.r)).toEqual([3, 3, 3])
    })

    it('ignores invalid widths and widths equal to the current one', () => {
        const plan = planFormat({ type: 'format_sheet', columnWidths: [{ col: 0, width: 90 }, { col: 1, width: 100 }, { col: 9, width: 90 }, { col: 2, width: 20 }] }, fakeSheet(tiny), measureText)
        expect(plan.widths).toEqual([{ c: 0, width: 90 }])
    })

    it('auto-fits on formatted text, clamps to 40..600 and wins over explicit widths', () => {
        const rows = [['A', 'B'], ['1200', 'x'.repeat(200)]]
        const plan = planFormat({ type: 'format_sheet', columns: [{ col: 0, style: { numberFormat: 'currency' } }], columnWidths: [{ col: 0, width: 300 }], autoFitColumns: true }, fakeSheet(rows), measureText)
        // "$1,200.00" = 9 chars × 7 px + 16 padding
        expect(plan.widths).toEqual([{ c: 0, width: 79 }, { c: 1, width: 600 }])
        const narrow = planFormat({ type: 'format_sheet', autoFitColumns: true }, fakeSheet([['A'], ['1']]), measureText)
        expect(narrow.widths).toEqual([{ c: 0, width: 40 }])
    })

    it('handles a header-only sheet: no body, no totals', () => {
        const plan = planFormat({ type: 'format_sheet', bodyStyle: { bold: true }, totalsStyle: { bold: true } }, fakeSheet([['A', 'B']]), measureText)
        expect(plan.result).toBe('NO_CHANGES')
    })
})

describe('format performance', () => {
    it('f01 over sales-large.tsv plans in < 300 ms', () => {
        const rows = loadFixtureRows('sales-large.tsv')
        const sheet = fakeSheet(rows)
        const t0 = performance.now()
        const plan = planFormat(action('f01'), sheet, measureText)
        const ms = performance.now() - t0
        console.log(`[perf] planFormat f01 over ${rows.length} rows: ${ms.toFixed(1)} ms`)
        expect(plan.result).toBe('OK')
        expect(applied(sheet, plan).style('A2992')).toMatchObject({ bold: true })
        expect(ms).toBeLessThan(300)
    })
})
