import { describe, it, expect } from 'vitest'
import { extractJson } from './extractJson.js'

describe('extractJson', () => {
    it('parses bare JSON', () => {
        expect(extractJson('{"type":"query"}')).toEqual({ ok: true, value: { type: 'query' } })
    })

    it('parses ```json fences with prose around them', () => {
        const text = 'Here is the plan:\n\n```json\n{ "type": "query", "limit": 3 }\n```\n\nLet me know.'
        expect(extractJson(text).value).toEqual({ type: 'query', limit: 3 })
    })

    it('parses bare ``` fences', () => {
        expect(extractJson('```\n{"type":"clarify","question":"Which?"}\n```').value.question).toBe('Which?')
    })

    it('handles prose with no fences before and after', () => {
        expect(extractJson('Sure! {"a": 1} Hope that helps.').value).toEqual({ a: 1 })
    })

    it('ignores braces and escaped quotes inside strings', () => {
        const text = 'Answer: {"type":"clarify","question":"Use } or { and \\"quotes\\"?"} trailing }'
        expect(extractJson(text).value.question).toBe('Use } or { and "quotes"?')
    })

    it('picks the first balanced top-level object', () => {
        const text = '{"first": {"nested": true}} and then {"second": 2}'
        expect(extractJson(text).value).toEqual({ first: { nested: true } })
    })

    it('skips a stray brace in prose that is not JSON', () => {
        expect(extractJson('Use the {x} placeholder.\n{"type":"query"}').value).toEqual({ type: 'query' })
    })

    it('rejects arrays, numbers and strings', () => {
        for (const text of ['[{"type":"query"}]', '42', '"hello"', 'null']) {
            const r = extractJson(text)
            expect(r.ok).toBe(false)
            expect(r.error).toBe('INVALID_RESPONSE')
        }
        expect(extractJson('[1,2]').detail).toMatch(/array/)
    })

    it('rejects invalid JSON with a detail', () => {
        const r = extractJson('{"type": "query",}')
        expect(r).toMatchObject({ ok: false, error: 'INVALID_RESPONSE' })
        expect(r.detail).toMatch(/Invalid JSON/)
    })

    it('rejects text without JSON, unbalanced objects and empty text', () => {
        expect(extractJson('I cannot help with that.').ok).toBe(false)
        expect(extractJson('{"type": "query"').ok).toBe(false)
        expect(extractJson('').ok).toBe(false)
        expect(extractJson(undefined).ok).toBe(false)
    })
})
