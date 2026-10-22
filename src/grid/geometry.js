// ─────────────────────────────────────────────────────────────
//  Screen geometry for the canvas grid: where a cell is drawn and
//  which cell is under the pointer, given scroll position and
//  frozen panes. Pure; shared by drawing and hit testing.
// ─────────────────────────────────────────────────────────────

export const ROW_HEADER_WIDTH = 56
export const COL_HEADER_HEIGHT = 24
export const OVERSCAN = 2
export const RESIZE_GRIP = 4
export const SORT_ZONE = 18
export const FILTER_BUTTON = 16

/**
 * @param {{ rowLayout, colLayout, frozenRows:number, frozenCols:number,
 *           scrollTop:number, scrollLeft:number, width:number, height:number }} p
 */
export function createViewport(p) {
    const { rowLayout, colLayout, scrollTop, scrollLeft, width, height } = p
    const frozenRows = Math.min(p.frozenRows, rowLayout.count)
    const frozenCols = Math.min(p.frozenCols, colLayout.count)
    const frozenH = rowLayout.offsetOf(frozenRows)
    const frozenW = colLayout.offsetOf(frozenCols)
    const bodyTop = COL_HEADER_HEIGHT + frozenH
    const bodyLeft = ROW_HEADER_WIDTH + frozenW

    const colX = (c) => ROW_HEADER_WIDTH + colLayout.offsetOf(c) - (c >= frozenCols ? scrollLeft : 0)
    const rowY = (r) => COL_HEADER_HEIGHT + rowLayout.offsetOf(r) - (r >= frozenRows ? scrollTop : 0)

    const clampIndex = (i, n) => Math.max(0, Math.min(n - 1, i))
    const bodyRows = {
        first: clampIndex(rowLayout.indexAt(frozenH + scrollTop) - OVERSCAN, rowLayout.count),
        last: clampIndex(rowLayout.indexAt(scrollTop + height - COL_HEADER_HEIGHT) + OVERSCAN, rowLayout.count),
    }
    const bodyCols = {
        first: clampIndex(colLayout.indexAt(frozenW + scrollLeft) - OVERSCAN, colLayout.count),
        last: clampIndex(colLayout.indexAt(scrollLeft + width - ROW_HEADER_WIDTH) + OVERSCAN, colLayout.count),
    }
    bodyRows.first = Math.max(bodyRows.first, frozenRows)
    bodyCols.first = Math.max(bodyCols.first, frozenCols)

    function colAtX(x) {
        if (x < bodyLeft && frozenCols > 0) return colLayout.indexAt(x - ROW_HEADER_WIDTH)
        return colLayout.indexAt(x - ROW_HEADER_WIDTH + scrollLeft)
    }

    function rowAtY(y) {
        if (y < bodyTop && frozenRows > 0) return rowLayout.indexAt(y - COL_HEADER_HEIGHT)
        return rowLayout.indexAt(y - COL_HEADER_HEIGHT + scrollTop)
    }

    /** Screen rectangle of a cell range (may extend off-screen). */
    function rangeRect({ r1, c1, r2, c2 }) {
        const x = colX(c1)
        const y = rowY(r1)
        return {
            x, y,
            w: colX(c2) + colLayout.sizeOf(c2) - x,
            h: rowY(r2) + rowLayout.sizeOf(r2) - y,
        }
    }

    /**
     * What is under the pointer.
     * area: 'corner' | 'colHeader' | 'rowHeader' | 'cell'
     * plus resize hits on header borders.
     */
    function hitTest(x, y) {
        if (x < ROW_HEADER_WIDTH && y < COL_HEADER_HEIGHT) return { area: 'corner' }
        if (y < COL_HEADER_HEIGHT) {
            const c = colAtX(x)
            const right = colX(c) + colLayout.sizeOf(c)
            const left = colX(c)
            if (Math.abs(x - right) <= RESIZE_GRIP) return { area: 'colResize', c }
            if (Math.abs(x - left) <= RESIZE_GRIP && c > 0) return { area: 'colResize', c: colLayout.step(c, -1) }
            if (right - x <= SORT_ZONE) return { area: 'sort', c }
            return { area: 'colHeader', c }
        }
        if (x < ROW_HEADER_WIDTH) {
            const r = rowAtY(y)
            const bottom = rowY(r) + rowLayout.sizeOf(r)
            if (Math.abs(y - bottom) <= RESIZE_GRIP) return { area: 'rowResize', r }
            return { area: 'rowHeader', r }
        }
        return { area: 'cell', r: rowAtY(y), c: colAtX(x) }
    }

    return {
        width, height, frozenRows, frozenCols, frozenH, frozenW, bodyTop, bodyLeft,
        bodyRows, bodyCols, colX, rowY, colAtX, rowAtY, rangeRect, hitTest,
        rowLayout, colLayout,
    }
}
