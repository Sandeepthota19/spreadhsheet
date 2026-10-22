// ─────────────────────────────────────────────────────────────
//  Canvas painter for the grid. Draws only what the viewport
//  covers: the four panes (corner, frozen rows, frozen columns,
//  body), the headers, the selection and the fill handle.
//  Reads the engine; never writes to it. No React.
// ─────────────────────────────────────────────────────────────

import { columnLabel } from '../engine/address.js'
import { ROW_HEADER_WIDTH, COL_HEADER_HEIGHT, FILTER_BUTTON } from './geometry.js'

export const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

const COLORS = {
    grid: '#e2e3e3',
    headerBg: '#f8f9fa',
    headerText: '#5f6368',
    headerSelected: '#d3e3fd',
    headerSelectedText: '#0b57d0',
    frozenLine: '#bdc1c6',
    selection: '#1a73e8',
    selectionFill: 'rgba(26, 115, 232, 0.10)',
    error: '#d93025',
    filter: '#1a73e8',
}

const PADDING = 4

export function fontFor(style) {
    return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize}px ${FONT_FAMILY}`
}

const widthCache = new Map()
function textWidth(ctx, font, text) {
    const key = font + '\u0000' + text
    let w = widthCache.get(key)
    if (w === undefined) {
        if (widthCache.size > 20000) widthCache.clear()
        ctx.font = font
        w = ctx.measureText(text).width
        widthCache.set(key, w)
    }
    return w
}

function drawCells(ctx, s, rows, cols) {
    const { vp, engine } = s
    const { rowLayout, colLayout } = vp
    // backgrounds
    for (let r = rows.first; r <= rows.last; r++) {
        if (rowLayout.isHidden(r)) continue
        const y = vp.rowY(r)
        const h = rowLayout.sizeOf(r)
        for (let c = cols.first; c <= cols.last; c++) {
            const style = engine.getStyle(r, c)
            if (style.bg && style.bg !== 'white') {
                ctx.fillStyle = style.bg
                ctx.fillRect(vp.colX(c), y, colLayout.sizeOf(c), h)
            }
        }
    }
    // grid lines
    ctx.strokeStyle = COLORS.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    const xStart = vp.colX(cols.first)
    const xEnd = vp.colX(cols.last) + colLayout.sizeOf(cols.last)
    const yStart = vp.rowY(rows.first)
    const yEnd = vp.rowY(rows.last) + rowLayout.sizeOf(rows.last)
    for (let r = rows.first; r <= rows.last; r++) {
        if (rowLayout.isHidden(r)) continue
        const y = Math.floor(vp.rowY(r) + rowLayout.sizeOf(r)) - 0.5
        ctx.moveTo(xStart, y)
        ctx.lineTo(xEnd, y)
    }
    for (let c = cols.first; c <= cols.last; c++) {
        const x = Math.floor(vp.colX(c) + colLayout.sizeOf(c)) - 0.5
        ctx.moveTo(x, yStart)
        ctx.lineTo(x, yEnd)
    }
    ctx.stroke()
    // text
    ctx.textBaseline = 'middle'
    for (let r = rows.first; r <= rows.last; r++) {
        if (rowLayout.isHidden(r)) continue
        const y = vp.rowY(r)
        const h = rowLayout.sizeOf(r)
        for (let c = cols.first; c <= cols.last; c++) {
            if (s.editing && s.editing.r === r && s.editing.c === c) continue
            const text = engine.getDisplay(r, c)
            if (text === '') continue
            const style = engine.getStyle(r, c)
            const x = vp.colX(c)
            const w = colLayout.sizeOf(c)
            const font = fontFor(style)
            const tw = textWidth(ctx, font, text)
            const reserve = s.filterButtons && r === 0 && c <= s.filterButtons.lastCol ? FILTER_BUTTON + 2 : 0
            const inner = w - PADDING * 2 - reserve
            const isError = /^#(REF!|VALUE!|DIV\/0!|NAME\?|PARSE!|CYCLE!)$/.test(text)
            ctx.font = font
            ctx.fillStyle = isError ? COLORS.error : style.color
            let tx = x + PADDING
            if (style.align === 'center') tx = x + PADDING + (inner - tw) / 2
            else if (style.align === 'right') tx = x + PADDING + inner - tw
            const clip = tw > inner
            if (clip) {
                ctx.save()
                ctx.beginPath()
                ctx.rect(x + 1, y, w - 2 - reserve, h)
                ctx.clip()
                if (style.align !== 'left') tx = x + PADDING
            }
            ctx.fillText(text, tx, y + h / 2 + 1)
            if (style.underline) {
                ctx.fillRect(tx, y + h / 2 + style.fontSize / 2, Math.min(tw, inner), 1)
            }
            if (clip) ctx.restore()
        }
    }
    // filter buttons on the header row
    if (s.filterButtons && rows.first === 0) {
        for (let c = cols.first; c <= Math.min(cols.last, s.filterButtons.lastCol); c++) {
            const x = vp.colX(c) + colLayout.sizeOf(c) - FILTER_BUTTON - 2
            const y = vp.rowY(0) + (rowLayout.sizeOf(0) - FILTER_BUTTON) / 2
            const active = s.filterButtons.active.has(c)
            ctx.fillStyle = active ? COLORS.filter : '#ffffff'
            ctx.strokeStyle = active ? COLORS.filter : '#9aa0a6'
            ctx.beginPath()
            ctx.rect(x + 0.5, y + 0.5, FILTER_BUTTON - 1, FILTER_BUTTON - 1)
            ctx.fill()
            ctx.stroke()
            ctx.fillStyle = active ? '#ffffff' : '#5f6368'
            ctx.beginPath()
            ctx.moveTo(x + 4, y + 6)
            ctx.lineTo(x + FILTER_BUTTON - 4, y + 6)
            ctx.lineTo(x + FILTER_BUTTON / 2, y + 11)
            ctx.closePath()
            ctx.fill()
        }
    }
}

function drawSelection(ctx, s) {
    const { vp, selection } = s
    if (!selection) return
    const rect = vp.rangeRect(selection)
    const active = vp.rangeRect({ r1: selection.active.r, c1: selection.active.c, r2: selection.active.r, c2: selection.active.c })
    const single = selection.r1 === selection.r2 && selection.c1 === selection.c2
    if (!single) {
        ctx.fillStyle = COLORS.selectionFill
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(active.x, active.y, active.w, active.h)
        // repaint the active cell so its content survives the clear
        drawCells(ctx, s, { first: selection.active.r, last: selection.active.r }, { first: selection.active.c, last: selection.active.c })
    }
    ctx.strokeStyle = COLORS.selection
    ctx.lineWidth = 2
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1)
    if (!s.editing) {
        ctx.fillStyle = COLORS.selection
        ctx.fillRect(rect.x + rect.w - 4, rect.y + rect.h - 4, 7, 7)
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1
        ctx.strokeRect(rect.x + rect.w - 4.5, rect.y + rect.h - 4.5, 8, 8)
    }
    if (s.fillPreview) {
        const p = vp.rangeRect(s.fillPreview)
        ctx.setLineDash([4, 3])
        ctx.strokeStyle = '#5f6368'
        ctx.lineWidth = 1
        ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1)
        ctx.setLineDash([])
    }
}

function paneClip(ctx, x, y, w, h) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, Math.max(0, w), Math.max(0, h))
    ctx.clip()
}

function drawPane(ctx, s, rows, cols, clip) {
    if (rows.last < rows.first || cols.last < cols.first) return
    paneClip(ctx, ...clip)
    drawCells(ctx, s, rows, cols)
    drawSelection(ctx, s)
    ctx.restore()
}

function drawHeaders(ctx, s) {
    const { vp, selection } = s
    const { rowLayout, colLayout } = vp
    const selCols = selection ? [selection.c1, selection.c2] : [-1, -1]
    const selRows = selection ? [selection.r1, selection.r2] : [-1, -1]
    ctx.textBaseline = 'middle'
    ctx.font = `12px ${FONT_FAMILY}`

    const colRanges = [
        { first: 0, last: vp.frozenCols - 1, clip: [ROW_HEADER_WIDTH, 0, vp.frozenW, COL_HEADER_HEIGHT] },
        { ...vp.bodyCols, clip: [vp.bodyLeft, 0, vp.width - vp.bodyLeft, COL_HEADER_HEIGHT] },
    ]
    for (const range of colRanges) {
        if (range.last < range.first) continue
        paneClip(ctx, ...range.clip)
        for (let c = range.first; c <= range.last; c++) {
            const x = vp.colX(c)
            const w = colLayout.sizeOf(c)
            const selected = c >= selCols[0] && c <= selCols[1]
            ctx.fillStyle = selected ? COLORS.headerSelected : COLORS.headerBg
            ctx.fillRect(x, 0, w, COL_HEADER_HEIGHT)
            ctx.strokeStyle = COLORS.grid
            ctx.beginPath()
            ctx.moveTo(Math.floor(x + w) - 0.5, 0)
            ctx.lineTo(Math.floor(x + w) - 0.5, COL_HEADER_HEIGHT)
            ctx.stroke()
            ctx.fillStyle = selected ? COLORS.headerSelectedText : COLORS.headerText
            const label = columnLabel(c)
            ctx.fillText(label, x + (w - ctx.measureText(label).width) / 2, COL_HEADER_HEIGHT / 2 + 1)
            const sorted = s.sortState && s.sortState.col === c
            if (sorted || s.hoverCol === c) {
                ctx.fillStyle = sorted ? COLORS.selection : '#9aa0a6'
                ctx.fillText(sorted ? (s.sortState.dir === 'asc' ? '▲' : '▼') : '⇅', x + w - 14, COL_HEADER_HEIGHT / 2 + 1)
            }
        }
        ctx.restore()
    }

    const rowRanges = [
        { first: 0, last: vp.frozenRows - 1, clip: [0, COL_HEADER_HEIGHT, ROW_HEADER_WIDTH, vp.frozenH] },
        { ...vp.bodyRows, clip: [0, vp.bodyTop, ROW_HEADER_WIDTH, vp.height - vp.bodyTop] },
    ]
    for (const range of rowRanges) {
        if (range.last < range.first) continue
        paneClip(ctx, ...range.clip)
        for (let r = range.first; r <= range.last; r++) {
            if (rowLayout.isHidden(r)) continue
            const y = vp.rowY(r)
            const h = rowLayout.sizeOf(r)
            const selected = r >= selRows[0] && r <= selRows[1]
            ctx.fillStyle = selected ? COLORS.headerSelected : COLORS.headerBg
            ctx.fillRect(0, y, ROW_HEADER_WIDTH, h)
            ctx.strokeStyle = COLORS.grid
            ctx.beginPath()
            ctx.moveTo(0, Math.floor(y + h) - 0.5)
            ctx.lineTo(ROW_HEADER_WIDTH, Math.floor(y + h) - 0.5)
            ctx.stroke()
            // a gap in the numbering (hidden rows above) gets a double line
            if (r > 0 && rowLayout.isHidden(r - 1)) {
                ctx.strokeStyle = COLORS.selection
                ctx.beginPath()
                ctx.moveTo(0, y + 1.5)
                ctx.lineTo(ROW_HEADER_WIDTH, y + 1.5)
                ctx.stroke()
            }
            ctx.fillStyle = selected ? COLORS.headerSelectedText : COLORS.headerText
            const label = String(r + 1)
            ctx.fillText(label, (ROW_HEADER_WIDTH - ctx.measureText(label).width) / 2, y + h / 2 + 1)
        }
        ctx.restore()
    }

    ctx.fillStyle = COLORS.headerBg
    ctx.fillRect(0, 0, ROW_HEADER_WIDTH, COL_HEADER_HEIGHT)
    ctx.strokeStyle = COLORS.frozenLine
    ctx.beginPath()
    ctx.moveTo(0, COL_HEADER_HEIGHT - 0.5)
    ctx.lineTo(vp.width, COL_HEADER_HEIGHT - 0.5)
    ctx.moveTo(ROW_HEADER_WIDTH - 0.5, 0)
    ctx.lineTo(ROW_HEADER_WIDTH - 0.5, vp.height)
    ctx.stroke()
}

/**
 * Paint one frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ vp, engine, selection, editing, fillPreview, filterButtons, sortState, hoverCol, resizeGuide }} s
 */
export function drawGrid(ctx, s) {
    const { vp } = s
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, vp.width, vp.height)
    const frozenRows = { first: 0, last: vp.frozenRows - 1 }
    const frozenCols = { first: 0, last: vp.frozenCols - 1 }
    drawPane(ctx, s, vp.bodyRows, vp.bodyCols, [vp.bodyLeft, vp.bodyTop, vp.width - vp.bodyLeft, vp.height - vp.bodyTop])
    drawPane(ctx, s, frozenRows, vp.bodyCols, [vp.bodyLeft, COL_HEADER_HEIGHT, vp.width - vp.bodyLeft, vp.frozenH])
    drawPane(ctx, s, vp.bodyRows, frozenCols, [ROW_HEADER_WIDTH, vp.bodyTop, vp.frozenW, vp.height - vp.bodyTop])
    drawPane(ctx, s, frozenRows, frozenCols, [ROW_HEADER_WIDTH, COL_HEADER_HEIGHT, vp.frozenW, vp.frozenH])
    // frozen pane separators
    ctx.strokeStyle = COLORS.frozenLine
    ctx.lineWidth = 2
    ctx.beginPath()
    if (vp.frozenRows > 0) {
        ctx.moveTo(0, vp.bodyTop - 1)
        ctx.lineTo(vp.width, vp.bodyTop - 1)
    }
    if (vp.frozenCols > 0) {
        ctx.moveTo(vp.bodyLeft - 1, 0)
        ctx.lineTo(vp.bodyLeft - 1, vp.height)
    }
    ctx.stroke()
    ctx.lineWidth = 1
    drawHeaders(ctx, s)
    if (s.resizeGuide) {
        ctx.strokeStyle = COLORS.selection
        ctx.beginPath()
        if (s.resizeGuide.axis === 'col') {
            ctx.moveTo(s.resizeGuide.pos + 0.5, 0)
            ctx.lineTo(s.resizeGuide.pos + 0.5, vp.height)
        } else {
            ctx.moveTo(0, s.resizeGuide.pos + 0.5)
            ctx.lineTo(vp.width, s.resizeGuide.pos + 0.5)
        }
        ctx.stroke()
    }
}

/** Text width in px for a style, for auto-fit. */
export function measureText(ctx, text, style) {
    return textWidth(ctx, fontFor(style), text)
}
