// ─────────────────────────────────────────────────────────────
//  Axis layout for the virtualized grid: prefix sums of row heights
//  (or column widths) plus binary search. Pure, no DOM.
//
//  offsets[i] is the pixel where item i starts; offsets[count] is the
//  total size. Hidden items have size 0, so they take no space and a
//  search never lands on them.
// ─────────────────────────────────────────────────────────────

/**
 * @param {number} count
 * @param {(i:number) => number} sizeOf size in px (0 for hidden)
 */
export function createAxisLayout(count, sizeOf) {
    const offsets = new Float64Array(count + 1)
    for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + sizeOf(i)

    /** Index of the item covering pixel `px` (clamped to the axis). */
    function indexAt(px) {
        if (px <= 0) return firstVisible(0)
        if (px >= offsets[count]) return lastVisible(count - 1)
        let lo = 0
        let hi = count - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (offsets[mid] <= px) lo = mid
            else hi = mid - 1
        }
        // offsets[lo] <= px; skip zero-size items that share the same start.
        while (lo < count - 1 && offsets[lo + 1] <= px) lo++
        return lo
    }

    function firstVisible(from) {
        let i = from
        while (i < count - 1 && offsets[i + 1] === offsets[i]) i++
        return i
    }

    function lastVisible(from) {
        let i = from
        while (i > 0 && offsets[i + 1] === offsets[i]) i--
        return i
    }

    return {
        count,
        total: offsets[count],
        offsetOf: (i) => offsets[Math.max(0, Math.min(i, count))],
        sizeOf: (i) => offsets[i + 1] - offsets[i],
        isHidden: (i) => offsets[i + 1] === offsets[i],
        indexAt,
        /** Next visible index after i in direction step (+1 / -1), or i if none. */
        step(i, step) {
            let j = i + step
            while (j >= 0 && j < count && offsets[j + 1] === offsets[j]) j += step
            return j >= 0 && j < count ? j : i
        },
    }
}
