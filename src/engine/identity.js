// ─────────────────────────────────────────────────────────────
//  Identity axis: the mapping between positions (what the user
//  sees as row 7 / column D) and stable ids (what cells, styles,
//  sizes and formula references are keyed by).
//
//  Inserting, deleting and sorting only edit `order`; nothing keyed
//  by id has to move. Ids are never reused, so an undo that puts an
//  id back makes every reference to it valid again.
// ─────────────────────────────────────────────────────────────

/**
 * @param {number} count initial number of positions
 */
export function createIdentityAxis(count) {
    /** position → id */
    let order = []
    /** id → position, -1 when the id is not on the axis (deleted) */
    let positions = new Int32Array(Math.max(64, count * 2)).fill(-1)
    let nextId = 0

    function ensureIdSpace(id) {
        if (id < positions.length) return
        let size = positions.length
        while (size <= id) size *= 2
        const grown = new Int32Array(size).fill(-1)
        grown.set(positions)
        positions = grown
    }

    function reindex(from, to = order.length) {
        for (let p = from; p < to; p++) positions[order[p]] = p
    }

    function newIds(n) {
        const ids = new Array(n)
        for (let i = 0; i < n; i++) ids[i] = nextId++
        ensureIdSpace(nextId)
        return ids
    }

    function insertIds(at, ids) {
        if (at >= order.length) {
            for (const id of ids) order.push(id)
        } else if (ids.length < 1000) {
            order.splice(at, 0, ...ids)
        } else {
            order = order.slice(0, at).concat(ids, order.slice(at))
        }
        for (const id of ids) ensureIdSpace(id)
        reindex(at)
    }

    function remove(at, n) {
        const ids = order.splice(at, n)
        for (const id of ids) positions[id] = -1
        reindex(at)
        return ids
    }

    insertIds(0, newIds(count))

    return {
        get length() { return order.length },
        /** id at a position, or -1 outside the axis */
        idAt(p) { return p >= 0 && p < order.length ? order[p] : -1 },
        /** position of an id, or -1 when it is not on the axis */
        posOf(id) { return id >= 0 && id < positions.length ? positions[id] : -1 },
        /** allocate fresh ids and insert them at a position */
        insert(at, n) {
            const ids = newIds(n)
            insertIds(at, ids)
            return ids
        },
        /** put known ids back (undo of delete, redo of insert) */
        insertIds,
        /** remove n positions starting at `at`; returns the removed ids */
        remove,
        /** write ids into the given positions (a permutation of what was there) */
        place(positionList, ids) {
            for (let i = 0; i < positionList.length; i++) {
                order[positionList[i]] = ids[i]
                positions[ids[i]] = positionList[i]
            }
        },
        /** ids at the given positions */
        idsAt(positionList) { return positionList.map(p => order[p]) },
        /** grow to at least n positions with fresh ids */
        grow(n) {
            if (n > order.length) insertIds(order.length, newIds(n - order.length))
        },
    }
}
