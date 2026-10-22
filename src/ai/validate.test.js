import { describe, it, expect } from 'vitest'
import { validateSchema, validateAction, parseModelResponse } from './validate.js'

describe('validateSchema', () => {
    it('checks types, including integer and type arrays', () => {
        expect(validateSchema({ type: 'integer' }, 3)).toEqual([])
        expect(validateSchema({ type: 'integer' }, 3.5)[0]).toMatch(/^\$: must be integer/)
        expect(validateSchema({ type: ['integer', 'null'] }, null)).toEqual([])
        expect(validateSchema({ type: ['string', 'number'] }, true)).toHaveLength(1)
        expect(validateSchema({ type: 'object' }, [])).toHaveLength(1)
        expect(validateSchema({ type: 'array' }, [])).toEqual([])
    })

    it('checks const, enum, minimum, maximum, pattern', () => {
        expect(validateSchema({ const: 'a' }, 'b')).toHaveLength(1)
        expect(validateSchema({ enum: ['x', 'y'] }, 'z')[0]).toBe('$: must be one of x, y (got "z")')
        expect(validateSchema({ type: 'integer', minimum: 1, maximum: 5 }, 0)).toHaveLength(1)
        expect(validateSchema({ type: 'integer', minimum: 1, maximum: 5 }, 6)).toHaveLength(1)
        expect(validateSchema({ type: 'string', pattern: '^#[0-9a-f]{6}$' }, '#fff')).toHaveLength(1)
    })

    it('checks required, additionalProperties and nested paths', () => {
        const schema = {
            type: 'object', additionalProperties: false, required: ['a'],
            properties: { a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string' } } } } },
        }
        expect(validateSchema(schema, {})).toEqual(['$: missing required property "a"'])
        expect(validateSchema(schema, { a: [], z: 1 })).toEqual(['$: unknown property "z"'])
        expect(validateSchema(schema, { a: [{ b: 'ok' }, { b: 2 }] })).toEqual(['$.a[1].b: must be string (got 2)'])
    })
})

describe('validateAction', () => {
    it('accepts the three action types', () => {
        expect(validateAction({ type: 'query', groupBy: ['Region'] }).ok).toBe(true)
        expect(validateAction({ type: 'format_sheet', freezeRows: null }).ok).toBe(true)
        expect(validateAction({ type: 'clarify', question: 'Which column?' }).ok).toBe(true)
    })

    it('rejects non-objects as INVALID_RESPONSE', () => {
        expect(validateAction([1]).error).toBe('INVALID_RESPONSE')
        expect(validateAction('query').error).toBe('INVALID_RESPONSE')
    })

    it('rejects unknown action types as READ_ONLY', () => {
        const r = validateAction({ type: 'mutation', action: 'deleteRows' })
        expect(r).toMatchObject({ ok: false, error: 'READ_ONLY' })
        expect(r.detail).toContain('mutation')
    })

    it('maps a bad filter op to UNKNOWN_OP with the path in the detail', () => {
        const r = validateAction({ type: 'query', filters: [{ column: 'Total', op: 'between', value: 1 }] })
        expect(r.error).toBe('UNKNOWN_OP')
        expect(r.detail).toContain('$.filters[0].op: must be one of eq, neq')
        expect(r.detail).toContain('"between"')
    })

    it('maps a bad aggregate fn to UNKNOWN_FN', () => {
        const r = validateAction({ type: 'query', aggregates: [{ fn: 'median', column: 'Total' }] })
        expect(r.error).toBe('UNKNOWN_FN')
        expect(r.detail).toContain('$.aggregates[0].fn')
    })

    it('reports every other schema failure as INVALID_RESPONSE, joined with "; "', () => {
        const r = validateAction({ type: 'query', limit: 0, extra: true })
        expect(r.error).toBe('INVALID_RESPONSE')
        expect(r.detail).toBe('$.limit: must be >= 1 (got 0); $: unknown property "extra"')
        expect(validateAction({ type: 'clarify' }).detail).toContain('missing required property "question"')
        expect(validateAction({ type: 'format_sheet', headerStyle: { bg: 'blue' } }).detail).toContain('$.headerStyle.bg: must match')
        expect(validateAction({ type: 'format_sheet', freezeRows: -1 }).detail).toContain('$.freezeRows: must be >= 0')
    })
})

describe('parseModelResponse', () => {
    it('extracts and validates in one step', () => {
        expect(parseModelResponse('```json\n{"type":"query","limit":5}\n```').action).toEqual({ type: 'query', limit: 5 })
        expect(parseModelResponse('no json here').error).toBe('INVALID_RESPONSE')
        expect(parseModelResponse('{"type":"mutation"}').error).toBe('READ_ONLY')
    })
})
