// Selection model for the UI: an anchor (where the selection started,
// also the active cell) and a focus (the moving corner). Pure helpers.

export function makeSelection(anchor, focus = anchor, kind = 'cells') {
    return {
        anchor,
        focus,
        active: anchor,
        kind,
        r1: Math.min(anchor.r, focus.r),
        c1: Math.min(anchor.c, focus.c),
        r2: Math.max(anchor.r, focus.r),
        c2: Math.max(anchor.c, focus.c),
    }
}

export function cellSelection(r, c) {
    return makeSelection({ r, c })
}

export function rangeSelection({ r1, c1, r2, c2 }, kind = 'cells') {
    return makeSelection({ r: r1, c: c1 }, { r: r2, c: c2 }, kind)
}

export function isMultiCell(sel) {
    return !!sel && (sel.r1 !== sel.r2 || sel.c1 !== sel.c2)
}

/**
 * Where a fill-handle drag ends up. Dragging outside the selection
 * extends it along the axis the pointer moved furthest on; dragging back
 * inside shrinks it (the engine clears what is no longer covered).
 */
export function fillTarget(sel, p) {
    const inRows = p.r >= sel.r1 && p.r <= sel.r2
    const inCols = p.c >= sel.c1 && p.c <= sel.c2
    if (inRows && inCols) {
        if (p.r < sel.r2) return { r1: sel.r1, c1: sel.c1, r2: p.r, c2: sel.c2 }
        if (p.c < sel.c2) return { r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: p.c }
        return null
    }
    const dr = p.r > sel.r2 ? p.r - sel.r2 : p.r < sel.r1 ? sel.r1 - p.r : 0
    const dc = p.c > sel.c2 ? p.c - sel.c2 : p.c < sel.c1 ? sel.c1 - p.c : 0
    if (dr >= dc) {
        return p.r > sel.r2
            ? { r1: sel.r1, c1: sel.c1, r2: p.r, c2: sel.c2 }
            : { r1: p.r, c1: sel.c1, r2: sel.r2, c2: sel.c2 }
    }
    return p.c > sel.c2
        ? { r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: p.c }
        : { r1: sel.r1, c1: p.c, r2: sel.r2, c2: sel.c2 }
}
