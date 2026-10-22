// The virtualized grid: one <canvas> painted from the engine for the
// visible window only, inside a scroll container whose spacer has the
// sheet's full size. React state here is per grid, never per cell;
// scrolling repaints imperatively without a React render.
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createAxisLayout } from '../grid/axisLayout.js'
import { createViewport, ROW_HEADER_WIDTH, COL_HEADER_HEIGHT } from '../grid/geometry.js'
import { drawGrid } from '../grid/draw.js'
import { makeSelection, fillTarget } from './selection.js'
import { perf } from './perf.js'

export function Grid({ engine, version, selection, onSelect, editing, editorRef, onEditorKeyDown, onEditorInput,
    onStartEdit, gridRef }) {
    const containerRef = useRef(null)
    const canvasRef = useRef(null)
    const [size, setSize] = useState({ width: 800, height: 500 })
    const modeRef = useRef(null)
    const frameRef = useRef(0)

    const rowLayout = useMemo(
        () => createAxisLayout(engine.rows, r => engine.getRowHeight(r)),
        // version changes on every engine transaction (sizes, filters, structure)
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [engine, version],
    )
    const colLayout = useMemo(
        () => createAxisLayout(engine.cols, c => engine.getColWidth(c)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [engine, version],
    )

    // Everything paint() needs, refreshed every render so the imperative
    // scroll path always sees current props.
    const stateRef = useRef(null)
    useLayoutEffect(() => {
        stateRef.current = { engine, selection, editing, rowLayout, colLayout, size }
    })

    function viewport() {
        const s = stateRef.current
        const el = containerRef.current
        return createViewport({
            rowLayout: s.rowLayout, colLayout: s.colLayout,
            frozenRows: s.engine.frozenRows, frozenCols: s.engine.frozenCols,
            scrollTop: el ? el.scrollTop : 0, scrollLeft: el ? el.scrollLeft : 0,
            width: s.size.width, height: s.size.height,
        })
    }

    function paint() {
        frameRef.current = 0
        const canvas = canvasRef.current
        const s = stateRef.current
        if (!canvas || !s) return
        const t0 = performance.now()
        const dpr = window.devicePixelRatio || 1
        const { width, height } = s.size
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr)
            canvas.height = Math.round(height * dpr)
        }
        const ctx = canvas.getContext('2d')
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const vp = viewport()
        const mode = modeRef.current
        drawGrid(ctx, {
            vp,
            engine: s.engine,
            selection: s.selection,
            editing: s.editing,
            fillPreview: mode?.type === 'fill' ? mode.target : null,
        })
        positionEditor(vp)
        perf.recordFrame(performance.now() - t0)
    }

    function schedulePaint() {
        if (!frameRef.current) frameRef.current = requestAnimationFrame(paint)
    }

    function positionEditor(vp) {
        const input = editorRef.current
        const s = stateRef.current
        if (!input || !s.editing) return
        const rect = vp.rangeRect({ r1: s.editing.r, c1: s.editing.c, r2: s.editing.r, c2: s.editing.c })
        input.style.left = rect.x + 'px'
        input.style.top = rect.y + 'px'
        input.style.minWidth = rect.w + 'px'
        input.style.height = rect.h + 'px'
    }

    // Repaint synchronously after every render so the canvas matches React state.
    useLayoutEffect(() => { paint() })

    useEffect(() => {
        const el = containerRef.current
        const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    // ── Imperative API for the app (keyboard navigation, name box) ──

    useImperativeHandle(gridRef, () => ({
        focus() { containerRef.current?.focus() },
        /** Scroll the minimum amount to bring a cell fully into view. */
        scrollIntoView(r, c) {
            const el = containerRef.current
            const vp = viewport()
            const s = stateRef.current
            if (r >= vp.frozenRows) {
                const top = s.rowLayout.offsetOf(r)
                const bottom = top + s.rowLayout.sizeOf(r)
                const viewTop = el.scrollTop + vp.frozenH
                const viewBottom = el.scrollTop + s.size.height - COL_HEADER_HEIGHT
                if (top < viewTop) el.scrollTop = top - vp.frozenH
                else if (bottom > viewBottom) el.scrollTop = bottom - (s.size.height - COL_HEADER_HEIGHT)
            }
            if (c >= vp.frozenCols) {
                const left = s.colLayout.offsetOf(c)
                const right = left + s.colLayout.sizeOf(c)
                const viewLeft = el.scrollLeft + vp.frozenW
                const viewRight = el.scrollLeft + s.size.width - ROW_HEADER_WIDTH
                if (left < viewLeft) el.scrollLeft = left - vp.frozenW
                else if (right > viewRight) el.scrollLeft = right - (s.size.width - ROW_HEADER_WIDTH)
            }
            schedulePaint()
        },
        rowLayout: () => stateRef.current.rowLayout,
        colLayout: () => stateRef.current.colLayout,
    }))

    // ── Pointer handling ──

    function pointerPos(e) {
        const rect = canvasRef.current.getBoundingClientRect()
        return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    function cellFromPos(vp, x, y) {
        const { rowLayout: rl, colLayout: cl } = stateRef.current
        const r = vp.rowAtY(Math.max(COL_HEADER_HEIGHT, Math.min(y, vp.height - 1)))
        const c = vp.colAtX(Math.max(ROW_HEADER_WIDTH, Math.min(x, vp.width - 1)))
        return { r: Math.max(0, Math.min(rl.count - 1, r)), c: Math.max(0, Math.min(cl.count - 1, c)) }
    }

    function onFillHandle(vp, x, y) {
        const sel = stateRef.current.selection
        if (!sel || stateRef.current.editing) return false
        const rect = vp.rangeRect(sel)
        return Math.abs(x - (rect.x + rect.w)) <= 5 && Math.abs(y - (rect.y + rect.h)) <= 5
    }

    function onPointerDown(e) {
        if (e.button !== 0) return
        const { x, y } = pointerPos(e)
        const vp = viewport()
        const s = stateRef.current
        const sel = s.selection
        containerRef.current.focus({ preventScroll: true })

        if (onFillHandle(vp, x, y)) {
            modeRef.current = { type: 'fill', source: sel, target: null }
            canvasRef.current.setPointerCapture(e.pointerId)
            return
        }
        const hit = vp.hitTest(x, y)
        switch (hit.area) {
            case 'cell': {
                const { r, c } = hit
                if (e.detail >= 2) { onStartEdit(r, c, null); return }
                const next = e.shiftKey && sel ? makeSelection(sel.anchor, { r, c }) : makeSelection({ r, c })
                onSelect(next)
                modeRef.current = { type: 'select', anchor: next.anchor }
                break
            }
            case 'colHeader': {
                const rows = s.rowLayout.count
                const anchorCol = e.shiftKey && sel ? sel.anchor.c : hit.c
                onSelect(makeSelection({ r: 0, c: anchorCol }, { r: rows - 1, c: hit.c }, 'cols'))
                modeRef.current = { type: 'selectCols', anchorCol }
                break
            }
            case 'rowHeader': {
                const cols = s.colLayout.count
                const anchorRow = e.shiftKey && sel ? sel.anchor.r : hit.r
                onSelect(makeSelection({ r: anchorRow, c: 0 }, { r: hit.r, c: cols - 1 }, 'rows'))
                modeRef.current = { type: 'selectRows', anchorRow }
                break
            }
            case 'corner':
                onSelect(makeSelection({ r: 0, c: 0 }, { r: s.rowLayout.count - 1, c: s.colLayout.count - 1 }, 'all'))
                return
        }
        canvasRef.current.setPointerCapture(e.pointerId)
    }

    function updateDrag(x, y) {
        const mode = modeRef.current
        const vp = viewport()
        const s = stateRef.current
        const p = cellFromPos(vp, x, y)
        if (mode.type === 'select') {
            onSelect(makeSelection(mode.anchor, p))
        } else if (mode.type === 'selectCols') {
            onSelect(makeSelection({ r: 0, c: mode.anchorCol }, { r: s.rowLayout.count - 1, c: p.c }, 'cols'))
        } else if (mode.type === 'selectRows') {
            onSelect(makeSelection({ r: mode.anchorRow, c: 0 }, { r: p.r, c: s.colLayout.count - 1 }, 'rows'))
        } else if (mode.type === 'fill') {
            mode.target = fillTarget(mode.source, p)
            schedulePaint()
        }
    }

    // Auto-scroll while dragging past the edge of the grid.
    const autoScrollRef = useRef(null)
    function autoScroll(x, y) {
        const el = containerRef.current
        const s = stateRef.current
        const dx = x < ROW_HEADER_WIDTH ? -20 : x > s.size.width ? 20 : 0
        const dy = y < COL_HEADER_HEIGHT ? -20 : y > s.size.height ? 20 : 0
        if (autoScrollRef.current) cancelAnimationFrame(autoScrollRef.current.id)
        autoScrollRef.current = null
        if (!dx && !dy) return
        const tick = () => {
            if (!modeRef.current) return
            el.scrollTop += dy
            el.scrollLeft += dx
            updateDrag(x, y)
            autoScrollRef.current = { id: requestAnimationFrame(tick) }
        }
        autoScrollRef.current = { id: requestAnimationFrame(tick) }
    }

    function onPointerMove(e) {
        const { x, y } = pointerPos(e)
        const mode = modeRef.current
        if (mode) {
            updateDrag(x, y)
            if (mode.type === 'select' || mode.type === 'fill' || mode.type === 'selectCols' || mode.type === 'selectRows') autoScroll(x, y)
            return
        }
        const vp = viewport()
        const canvas = canvasRef.current
        let cursor = 'cell'
        if (onFillHandle(vp, x, y)) cursor = 'crosshair'
        else {
            const hit = vp.hitTest(x, y)
            if (hit.area === 'colHeader' || hit.area === 'rowHeader' || hit.area === 'corner') cursor = 'default'
        }
        canvas.style.cursor = cursor
    }

    function onPointerUp() {
        const mode = modeRef.current
        modeRef.current = null
        if (autoScrollRef.current) cancelAnimationFrame(autoScrollRef.current.id)
        autoScrollRef.current = null
        if (!mode) return
        if (mode.type === 'fill' && mode.target) {
            const t0 = performance.now()
            engine.fill(mode.source, mode.target)
            perf.record('fill', performance.now() - t0)
            onSelect(makeSelection({ r: mode.target.r1, c: mode.target.c1 }, { r: mode.target.r2, c: mode.target.c2 }))
        }
        schedulePaint()
    }

    const totalWidth = ROW_HEADER_WIDTH + colLayout.total
    const totalHeight = COL_HEADER_HEIGHT + rowLayout.total

    return (
        <div className="grid-scroll" ref={containerRef} tabIndex={0} onScroll={schedulePaint} data-testid="grid">
            <div className="grid-sticky">
                <canvas
                    ref={canvasRef}
                    className="grid-canvas"
                    style={{ width: size.width, height: size.height }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                />
                {editing && (
                    <input
                        ref={editorRef}
                        className="cell-editor"
                        defaultValue={editing.initial}
                        onKeyDown={onEditorKeyDown}
                        onInput={onEditorInput}
                        spellCheck={false}
                        autoComplete="off"
                        style={editorStyle(engine.getStyle(editing.r, editing.c))}
                    />
                )}
            </div>
            <div style={{ width: totalWidth, height: totalHeight }} />
        </div>
    )
}

function editorStyle(style) {
    return {
        fontWeight: style.bold ? 'bold' : 'normal',
        fontStyle: style.italic ? 'italic' : 'normal',
        fontSize: style.fontSize + 'px',
        color: style.color,
        background: style.bg === 'white' ? '#ffffff' : style.bg,
        textAlign: style.align,
    }
}
