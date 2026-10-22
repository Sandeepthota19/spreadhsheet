// ─────────────────────────────────────────────────────────────
//  Hand-written validator for the JSON-Schema subset used in
//  src/ai/contract.js, plus the action gate that every model
//  response passes before it may touch the executor or the
//  style system. Pure functions, no state.
//
//  Supported keywords: type (string or array), const, enum,
//  required, properties, additionalProperties: false, items,
//  minimum, maximum, pattern. `default` is documentation only.
// ─────────────────────────────────────────────────────────────
import {
    ACTION_TYPES, QUERY_PLAN_SCHEMA, FORMAT_SHEET_SCHEMA, CLARIFY_SCHEMA,
} from './contract.js'
import { extractJson } from './extractJson.js'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const TYPE_CHECKS = {
    string: (v) => typeof v === 'string',
    number: (v) => typeof v === 'number' && Number.isFinite(v),
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === 'boolean',
    object: isPlainObject,
    array: Array.isArray,
    null: (v) => v === null,
}

const show = (v) => JSON.stringify(v) ?? String(v)

// Compiled `pattern` strings, cached because the same schemas are reused.
const patternCache = new Map()
function compiled(pattern) {
    let re = patternCache.get(pattern)
    if (!re) {
        re = new RegExp(pattern)
        patternCache.set(pattern, re)
    }
    return re
}

/**
 * Validate `value` against a JSON-Schema subset.
 * A type mismatch stops checks on that node so errors stay readable.
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path] JSON path used in messages, `$` is the root
 * @returns {string[]} error strings such as `$.filters[0].op: must be one of eq, neq`
 */
export function validateSchema(schema, value, path = '$') {
    const errors = []
    if (!schema || typeof schema !== 'object') return errors

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type]
        if (!types.some(t => TYPE_CHECKS[t]?.(value))) {
            errors.push(`${path}: must be ${types.join(' or ')} (got ${show(value)})`)
            return errors
        }
    }
    if ('const' in schema && value !== schema.const) {
        errors.push(`${path}: must be ${show(schema.const)} (got ${show(value)})`)
    }
    if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`${path}: must be one of ${schema.enum.join(', ')} (got ${show(value)})`)
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            errors.push(`${path}: must be >= ${schema.minimum} (got ${value})`)
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            errors.push(`${path}: must be <= ${schema.maximum} (got ${value})`)
        }
    }
    if (typeof value === 'string' && schema.pattern && !compiled(schema.pattern).test(value)) {
        errors.push(`${path}: must match ${schema.pattern} (got ${show(value)})`)
    }
    if (isPlainObject(value)) {
        for (const key of schema.required ?? []) {
            if (!(key in value)) errors.push(`${path}: missing required property "${key}"`)
        }
        const props = schema.properties ?? {}
        for (const key of Object.keys(value)) {
            if (key in props) {
                errors.push(...validateSchema(props[key], value[key], `${path}.${key}`))
            } else if (schema.additionalProperties === false) {
                errors.push(`${path}: unknown property "${key}"`)
            }
        }
    }
    if (Array.isArray(value) && schema.items) {
        value.forEach((item, i) => errors.push(...validateSchema(schema.items, item, `${path}[${i}]`)))
    }
    return errors
}

const SCHEMA_BY_TYPE = {
    [ACTION_TYPES.QUERY]: QUERY_PLAN_SCHEMA,
    [ACTION_TYPES.FORMAT_SHEET]: FORMAT_SHEET_SCHEMA,
    [ACTION_TYPES.CLARIFY]: CLARIFY_SCHEMA,
}

/**
 * Gate a parsed model response. Order: not an object → INVALID_RESPONSE;
 * a `type` outside ACTION_TYPES → READ_ONLY; schema failure → UNKNOWN_OP
 * (bad filter op), UNKNOWN_FN (bad aggregate fn) or INVALID_RESPONSE.
 * `detail` always lists every failure.
 * @param {unknown} obj
 * @returns {{ok: true, action: object} | {ok: false, error: string, detail: string}}
 */
export function validateAction(obj) {
    if (!isPlainObject(obj)) {
        return { ok: false, error: 'INVALID_RESPONSE', detail: 'The response is not a JSON object.' }
    }
    if (typeof obj.type !== 'string') {
        return { ok: false, error: 'INVALID_RESPONSE', detail: '$: missing required property "type"' }
    }
    const schema = SCHEMA_BY_TYPE[obj.type]
    if (!schema) {
        const allowed = Object.values(ACTION_TYPES).join(', ')
        return {
            ok: false,
            error: 'READ_ONLY',
            detail: `READ_ONLY: action type "${obj.type}" is not allowed; only ${allowed} can be used.`,
        }
    }
    const errors = validateSchema(schema, obj)
    if (errors.length === 0) return { ok: true, action: obj }

    let error = 'INVALID_RESPONSE'
    if (errors.some(e => /^\$\.filters\[\d+\]\.op: must be one of/.test(e))) error = 'UNKNOWN_OP'
    else if (errors.some(e => /^\$\.aggregates\[\d+\]\.fn: must be one of/.test(e))) error = 'UNKNOWN_FN'
    return { ok: false, error, detail: errors.join('; ') }
}

/**
 * Raw model text → validated action: extractJson then validateAction.
 * @param {string} text
 * @returns {{ok: true, action: object} | {ok: false, error: string, detail: string}}
 */
export function parseModelResponse(text) {
    const extracted = extractJson(text)
    if (!extracted.ok) return extracted
    return validateAction(extracted.value)
}
