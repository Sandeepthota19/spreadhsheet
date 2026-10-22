// ─────────────────────────────────────────────────────────────
//  Pull the first JSON object out of raw model text.
//
//  Models wrap JSON in prose and code fences. Rather than guess
//  with a regex, we scan for the first `{` and walk forward with a
//  string-aware brace matcher until the object balances, then
//  JSON.parse exactly that slice. Pure, no state.
// ─────────────────────────────────────────────────────────────

/**
 * Find the end index (inclusive) of the balanced object starting at
 * `start` (which must be a `{`). Braces inside strings are ignored.
 * @returns {number} -1 when the object never closes
 */
function matchObject(text, start) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
            if (ch === '\\') i++                 // skip the escaped character
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}

function tryParse(text) {
    try {
        return { parsed: true, value: JSON.parse(text) }
    } catch {
        return { parsed: false }
    }
}

function describeKind(v) {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'an array'
    return `a ${typeof v}`
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Extract and parse the first balanced top-level JSON object in `text`.
 * Handles bare JSON, ```json / ``` fences and prose around the object.
 * Arrays, numbers and other non-object JSON are rejected.
 * @param {unknown} text raw model output
 * @returns {{ok: true, value: object} | {ok: false, error: 'INVALID_RESPONSE', detail: string}}
 */
export function extractJson(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, error: 'INVALID_RESPONSE', detail: 'The model returned an empty response.' }
    }
    const trimmed = text.trim()
    // If the whole text (or the body of its first code fence) is valid JSON,
    // that is the answer; this is also how a bare array or number is refused
    // instead of having an object fished out of it.
    const fence = trimmed.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/)
    for (const candidate of fence ? [trimmed, fence[1].trim()] : [trimmed]) {
        const whole = tryParse(candidate)
        if (whole.parsed) {
            if (isPlainObject(whole.value)) return { ok: true, value: whole.value }
            return { ok: false, error: 'INVALID_RESPONSE', detail: `Expected a JSON object, got ${describeKind(whole.value)}.` }
        }
    }
    if (!trimmed.includes('{')) {
        return { ok: false, error: 'INVALID_RESPONSE', detail: 'No JSON object found in the model response.' }
    }

    let lastError = ''
    let from = trimmed.indexOf('{')
    // A stray `{` in prose (e.g. "use {braces}") must not hide a real
    // object later on, so try each candidate start in order.
    while (from !== -1) {
        const end = matchObject(trimmed, from)
        if (end === -1) {
            // A stray `{` in prose never closes; try the next one.
            lastError = lastError || 'Unbalanced braces: the JSON object never closes.'
            from = trimmed.indexOf('{', from + 1)
            continue
        }
        const slice = trimmed.slice(from, end + 1)
        try {
            const value = JSON.parse(slice)
            if (isPlainObject(value)) return { ok: true, value }
            lastError = 'The JSON is not an object.'
        } catch (err) {
            lastError = `Invalid JSON: ${err.message}`
        }
        // Only top-level candidates: resume after the object that failed.
        from = trimmed.indexOf('{', end + 1)
    }
    return { ok: false, error: 'INVALID_RESPONSE', detail: lastError || 'No JSON object found in the model response.' }
}
