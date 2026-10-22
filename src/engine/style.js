// ─────────────────────────────────────────────────────────────
//  Cell style model. A style is a frozen object with every key
//  present; the engine stores only styles that differ from the
//  default, keyed by cell identity, so they move with their rows.
// ─────────────────────────────────────────────────────────────

export const DEFAULT_STYLE = Object.freeze({
    bold: false,
    italic: false,
    underline: false,
    bg: 'white',
    color: '#202124',
    align: 'left',
    fontSize: 13,
    numberFormat: 'general',
})

export const STYLE_KEYS = Object.freeze(Object.keys(DEFAULT_STYLE))

/** Merge a partial style over a full one; unknown keys are ignored. */
export function mergeStyle(base, patch) {
    const next = { ...(base || DEFAULT_STYLE) }
    for (const k of STYLE_KEYS) if (patch && patch[k] !== undefined) next[k] = patch[k]
    return Object.freeze(next)
}

export function sameStyle(a, b) {
    const x = a || DEFAULT_STYLE
    const y = b || DEFAULT_STYLE
    if (x === y) return true
    for (const k of STYLE_KEYS) if (x[k] !== y[k]) return false
    return true
}

export function isDefaultStyle(s) {
    return sameStyle(s, DEFAULT_STYLE)
}
