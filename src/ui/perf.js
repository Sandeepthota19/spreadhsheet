// Tiny in-app performance recorder: canvas frame times, the first
// paint, and the duration of named actions (sort, fill, ...). The
// status bar shows these so budgets can be read off a production build.

const FRAME_WINDOW = 120
const frames = []
const actions = {}
const listeners = new Set()
let firstPaint = null
let firstPaintFromApp = null

export const perf = {
    recordFrame(ms) {
        if (firstPaint === null) {
            firstPaint = performance.now()
            firstPaintFromApp = firstPaint - (window.__appStart ?? 0)
        }
        frames.push(ms)
        if (frames.length > FRAME_WINDOW) frames.shift()
    },
    record(name, ms) {
        actions[name] = ms
        for (const l of listeners) l()
    },
    stats() {
        let sum = 0
        let max = 0
        for (const f of frames) { sum += f; if (f > max) max = f }
        return {
            firstPaint,
            firstPaintFromApp,
            avgFrame: frames.length ? sum / frames.length : 0,
            maxFrame: max,
            frames: frames.length,
            actions: { ...actions },
        }
    },
    subscribe(l) {
        listeners.add(l)
        return () => listeners.delete(l)
    },
}

/** Time a synchronous action and record it under `name`. */
export function timed(name, fn) {
    const t0 = performance.now()
    const result = fn()
    perf.record(name, performance.now() - t0)
    return result
}
