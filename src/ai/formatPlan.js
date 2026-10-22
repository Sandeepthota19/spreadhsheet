// ─────────────────────────────────────────────────────────────
//  format_sheet planner (AI_CONTRACT.md §4).
//
//  Turns a validated format_sheet action into a concrete change
//  list (cell styles, column widths, frozen rows) without touching
//  the sheet. The caller applies the list as ONE undo step, or
//  nothing at all when the result is NO_CHANGES / OUT_OF_RANGE.
//  Pure: the sheet is read through the accessor object passed in,
//  and text measurement is injected so this runs without a DOM.
// ─────────────────────────────────────────────────────────────
import { looksLikeTotalsRow } from '../engine/values.js'
import { formatNumberDisplay } from '../engine/numberFormat.js'
import { DEFAULT_STYLE, STYLE_KEYS, mergeStyle, sameStyle } from '../engine/style.js'

const MIN_WIDTH = 30
const MAX_WIDTH = 600
const AUTOFIT_MIN = 40
const AUTOFIT_PADDING = 16

/** Keep only known style keys from a (validated) style patch. */
function cleanPatch(style, { dropNumberFormat = false } = {}) {
    const patch = {}
    if (!style) return patch
    for (const key of STYLE_KEYS) {
        if (style[key] !== undefined && !(dropNumberFormat && key === 'numberFormat')) patch[key] = style[key]
    }
    return patch
}

/**
 * @typedef {{bold:boolean, italic:boolean, underline:boolean, bg:string, color:string,
 *            align:'left'|'center'|'right', fontSize:number, numberFormat:string}} CellStyle
 * @typedef {{ rowCount:number, colCount:number, getStyle:(r:number,c:number)=>Partial<CellStyle>|undefined,
 *             getText:(r:number,c:number)=>string, frozenRows:number, getColWidth:(c:number)=>number }} SheetView
 * @typedef {{ result:'OK'|'NO_CHANGES'|'OUT_OF_RANGE', message:string,
 *             styles:Array<{r:number,c:number,style:CellStyle}>, widths:Array<{c:number,width:number}>,
 *             frozenRows:number|undefined }} FormatPlan
 */

/**
 * Plan a format_sheet action over the used range (0-based r, c; row 0 is the header).
 * @param {object} action validated format_sheet action
 * @param {SheetView} sheet
 * @param {(text:string, style:CellStyle)=>number} measureText pixel width of `text` in `style`
 * @returns {FormatPlan}
 */
export function planFormat(action, sheet, measureText) {
    const { rowCount, colCount } = sheet
    const empty = (result, message) => ({ result, message, styles: [], widths: [], frozenRows: undefined })

    // §4.5: a freeze that would cover every used row is refused outright.
    const freeze = action.freezeRows
    if (typeof freeze === 'number' && freeze >= rowCount) {
        return empty('OUT_OF_RANGE', `Cannot freeze ${freeze} rows: the sheet only uses ${rowCount} row${rowCount === 1 ? '' : 's'}, so every row would be frozen. Nothing was changed.`)
    }

    // Working copy: only touched cells live in `next`; others read through.
    const original = (r, c) => mergeStyle(DEFAULT_STYLE, sheet.getStyle(r, c))
    const next = new Map()
    const key = (r, c) => r * colCount + c
    const current = (r, c) => next.get(key(r, c)) ?? original(r, c)
    const patchCell = (r, c, patch) => next.set(key(r, c), mergeStyle(current(r, c), patch))
    const patchRect = (r0, r1, c0, c1, patch) => {
        if (Object.keys(patch).length === 0) return
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) patchCell(r, c, patch)
    }
    const inCols = (c) => Number.isInteger(c) && c >= 0 && c < colCount
    const lastRow = rowCount - 1
    const notes = []

    if (rowCount > 0 && colCount > 0) {
        // §4.3 order: clear → body → columns → totals → header (last).
        if (action.clearFormatting) {
            for (let r = 0; r < rowCount; r++) for (let c = 0; c < colCount; c++) next.set(key(r, c), DEFAULT_STYLE)
        }
        if (rowCount > 1) {
            patchRect(1, lastRow, 0, colCount - 1, cleanPatch(action.bodyStyle))
            for (const entry of action.columns ?? []) {
                if (inCols(entry.col)) patchRect(1, lastRow, entry.col, entry.col, cleanPatch(entry.style))
            }
            if (action.totalsStyle) {
                const texts = []
                for (let c = 0; c < colCount; c++) texts.push(sheet.getText(lastRow, c))
                if (looksLikeTotalsRow(texts)) patchRect(lastRow, lastRow, 0, colCount - 1, cleanPatch(action.totalsStyle))
                else notes.push('the last row is not a totals row, so the totals style was skipped')
            }
        }
        // The header is never number-formatted.
        patchRect(0, 0, 0, colCount - 1, cleanPatch(action.headerStyle, { dropNumberFormat: true }))
    }

    const styles = []
    for (const [k, style] of next) {
        const r = Math.floor(k / colCount)
        const c = k % colCount
        if (!sameStyle(style, original(r, c))) styles.push({ r, c, style })
    }

    // Widths: explicit widths first, auto-fit last (it wins).
    const widthOf = new Map()
    for (const entry of action.columnWidths ?? []) {
        const w = entry.width
        if (inCols(entry.col) && Number.isFinite(w) && w >= MIN_WIDTH && w <= MAX_WIDTH) widthOf.set(entry.col, w)
    }
    if (action.autoFitColumns && rowCount > 0) {
        const cache = new Map()
        const measure = (text, style) => {
            if (text === '') return 0
            const k = `${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}${style.fontSize}|${text}`
            let w = cache.get(k)
            if (w === undefined) {
                w = measureText(text, style)
                cache.set(k, w)
            }
            return w
        }
        for (let c = 0; c < colCount; c++) {
            let max = 0
            for (let r = 0; r < rowCount; r++) {
                const style = current(r, c)
                const shown = formatNumberDisplay(sheet.getText(r, c), r === 0 ? 'general' : style.numberFormat)
                const w = measure(shown, style)
                if (w > max) max = w
            }
            widthOf.set(c, Math.min(MAX_WIDTH, Math.max(AUTOFIT_MIN, Math.ceil(max + AUTOFIT_PADDING))))
        }
    }
    const widths = []
    for (const [c, width] of [...widthOf].sort((a, b) => a[0] - b[0])) {
        if (width !== sheet.getColWidth(c)) widths.push({ c, width })
    }

    const frozenRows = typeof freeze === 'number' && freeze !== sheet.frozenRows ? freeze : undefined

    if (styles.length === 0 && widths.length === 0 && frozenRows === undefined) {
        return empty('NO_CHANGES', 'Nothing to change' + (notes.length ? `: ${notes.join('; ')}.` : '.'))
    }
    const parts = []
    if (styles.length) parts.push(`styled ${styles.length} cell${styles.length === 1 ? '' : 's'}`)
    if (widths.length) parts.push(`resized ${widths.length} column${widths.length === 1 ? '' : 's'}`)
    if (frozenRows !== undefined) parts.push(frozenRows === 0 ? 'unfroze rows' : `froze ${frozenRows} row${frozenRows === 1 ? '' : 's'}`)
    const message = parts.join(', ').replace(/^./, ch => ch.toUpperCase()) + (notes.length ? ` (${notes.join('; ')})` : '') + '.'
    return { result: 'OK', message, styles, widths, frozenRows }
}
