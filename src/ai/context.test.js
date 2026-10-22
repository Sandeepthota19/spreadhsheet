import { describe, it, expect } from 'vitest'
import { buildSheetContext, inferColumnType } from './context.js'
import { buildSystemPrompt } from './prompt.js'
import { describeQuery, describeFormat } from './describe.js'
import { createHttpProvider } from './provider.js'
import { loadFixtureTable, loadEval } from '../test/fixtures.js'

const small = loadFixtureTable('sales.tsv')

describe('buildSheetContext', () => {
    const ctx = buildSheetContext(small, { range: 'A1:J33', selection: 'C2:C10' })

    it('has exactly the documented shape', () => {
        expect(Object.keys(ctx)).toEqual(['range', 'rowCount', 'columns', 'sampleRows', 'selection', 'hasTotalsRow'])
        expect(ctx).toMatchObject({ range: 'A1:J33', rowCount: 30, selection: 'C2:C10', hasTotalsRow: true })
        expect(ctx.sampleRows).toHaveLength(5)
        expect(ctx.sampleRows[0][0]).toBe('ORD-1001')
    })

    it('infers the sample column types', () => {
        expect(ctx.columns.map(c => c.type)).toEqual(['id', 'date', 'text', 'text', 'text', 'text', 'number', 'currency', 'percent', 'currency'])
        expect(ctx.columns[1]).toEqual({ name: 'Date', index: 1, type: 'date', examples: ['2024-01-03', '2024-01-05', '1/8/2024'] })
    })

    it('defaults range and selection', () => {
        const c = buildSheetContext(small)
        expect(c.range).toBe('A1:J33')
        expect(c.selection).toBeNull()
    })

    it('never sends the full data', () => {
        const large = loadFixtureTable('sales-large.tsv')
        const json = JSON.stringify(buildSheetContext(large))
        expect(json.length).toBeLessThan(3000)
        expect(json).not.toContain('ORD-12974')
    })
})

describe('inferColumnType', () => {
    it('detects ids by header or by distinct code-like values', () => {
        expect(inferColumnType('Invoice #', ['1', '2'])).toBe('id')
        expect(inferColumnType('Code', ['AB-1', 'AB-2', 'CD3'])).toBe('id')
        expect(inferColumnType('Code', ['AB-1', 'AB-1'])).toBe('text')
        expect(inferColumnType('Paid', ['yes', 'no'])).toBe('text')
    })

    it('uses the 80% / 50% thresholds and ignores blanks', () => {
        expect(inferColumnType('Qty', ['1', '2', '3', '4', 'N/A', '', ''])).toBe('number')
        expect(inferColumnType('Qty', ['1', '2', 'x', 'y'])).toBe('text')
        expect(inferColumnType('Price', ['$1', '$2', '3', '4'])).toBe('currency')
        expect(inferColumnType('Rate', ['10%', '5%', '0.1', '0.2'])).toBe('percent')
        expect(inferColumnType('Empty', ['', ' '])).toBe('text')
    })
})

describe('buildSystemPrompt', () => {
    it('contains the task, schemas, rules, context and answer format', () => {
        const ctx = buildSheetContext(small)
        const p = buildSystemPrompt(ctx)
        expect(p).toContain('"const":"query"')
        expect(p).toContain('"const":"format_sheet"')
        expect(p).toContain('"const":"clarify"')
        expect(p).toContain(JSON.stringify(ctx))
        expect(p).toMatch(/0-based/)
        expect(p.trim().endsWith('Answer with a single JSON object and nothing else.')).toBe(true)
    })
})

describe('describe', () => {
    it('describes the golden query plans in plain words', () => {
        const plans = Object.fromEntries(loadEval('queries.json').cases.map(c => [c.id, c.plan]))
        expect(describeQuery(plans.q02)).toBe('Sum of Total as “Total Sales”, grouped by Sales Rep, sorted by Total Sales (high → low), top 3.')
        expect(describeQuery(plans.q03)).toBe('Count of Order ID as “Orders”, where Region = West.')
        expect(describeQuery(plans.q15)).toBe('Rows with all columns, first 500 rows (capped from 100000).')
        expect(describeQuery(plans.q20)).toBe('Rows showing Order ID, Date, Sales Rep and Total, where Region = Central and Total > 20000, sorted by Total (descending).')
        expect(describeQuery(plans.q18)).toContain('where Discount is empty')
    })

    it('previews every golden format action', () => {
        const actions = Object.fromEntries(loadEval('format-prompts.json').cases.map(c => [c.id, c.action]))
        expect(describeFormat(actions.f02)).toBe('header: bold, blue')
        expect(describeFormat(actions.f03)).toBe('2 columns: currency format')
        expect(describeFormat(actions.f04)).toBe('unfreeze rows')
        expect(describeFormat(actions.f06)).toBe('clear all formatting')
        expect(describeFormat(actions.f07)).toBe('column Z: bold')
        expect(describeFormat(actions.f09)).toBe('totals row: yellow')
        expect(describeFormat({ type: 'format_sheet' })).toBe('no changes requested')
    })
})

describe('createHttpProvider', () => {
    const request = { system: 'SYS', user: 'hello', history: [{ role: 'assistant', content: 'prev' }] }
    const okJson = (body) => async () => ({ ok: true, status: 200, json: async () => body, headers: new Map() })

    it('speaks the Anthropic Messages format for anthropic.com hosts', async () => {
        let seen
        const fetch = async (url, init) => { seen = { url, init }; return okJson({ content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] })() }
        const p = createHttpProvider({ endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'k', model: '', fetch })
        expect(await p.complete(request)).toEqual({ text: '{"a":1}', provider: 'http' })
        const body = JSON.parse(seen.init.body)
        expect(seen.init.headers['x-api-key']).toBe('k')
        expect(seen.init.headers['anthropic-version']).toBe('2023-06-01')
        expect(body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 1024, system: 'SYS' })
        expect(body.messages).toEqual([{ role: 'assistant', content: 'prev' }, { role: 'user', content: 'hello' }])
    })

    it('speaks the OpenAI-compatible format elsewhere', async () => {
        let seen
        const fetch = async (url, init) => { seen = init; return okJson({ choices: [{ message: { content: 'hi' } }] })() }
        const p = createHttpProvider({ endpoint: 'http://localhost:11434/v1/chat/completions', apiKey: 'k', model: 'm', fetch })
        expect((await p.complete(request)).text).toBe('hi')
        expect(seen.headers.authorization).toBe('Bearer k')
        expect(JSON.parse(seen.body)).toMatchObject({ model: 'm', temperature: 0, messages: [{ role: 'system', content: 'SYS' }, { role: 'assistant', content: 'prev' }, { role: 'user', content: 'hello' }] })
    })

    it('throws coded, readable errors without leaking the key', async () => {
        const run = async (cfg) => {
            try {
                await createHttpProvider({ endpoint: 'https://x.test/v1', apiKey: 'secret-key', model: 'm', ...cfg }).complete(request)
            } catch (err) {
                expect(err.message).not.toContain('secret-key')
                return err
            }
            throw new Error('expected a failure')
        }
        const res = (status, extra = {}) => async () => ({ ok: false, status, text: async () => 'boom', headers: new Map(Object.entries(extra)) })
        expect((await run({ endpoint: '' })).code).toBe('PROVIDER_CONFIG')
        expect((await run({ apiKey: '' })).code).toBe('PROVIDER_CONFIG')
        expect((await run({ fetch: async () => { throw new TypeError('Failed to fetch') } })).code).toBe('PROVIDER_NETWORK')
        expect((await run({ fetch: res(401) })).code).toBe('PROVIDER_AUTH')
        const limited = await run({ fetch: res(429, { 'retry-after': '20' }) })
        expect(limited).toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryAfter: '20' })
        expect(limited.message).toContain('20 seconds')
        const http = await run({ fetch: res(500) })
        expect(http).toMatchObject({ code: 'PROVIDER_HTTP', status: 500 })
        expect(http.message).toContain('boom')
        expect((await run({ fetch: okJson({ choices: [] }) })).code).toBe('PROVIDER_EMPTY')
    })
})
