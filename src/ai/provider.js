// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`. A provider is any object with:
//
//      complete({ system, user, history }) => Promise<{ text, provider }>
//
//  `text` is the raw model output. You are expected to extract and
//  validate JSON from it yourself: models wrap JSON in prose, in code
//  fences, or return something that is not JSON at all.
//
//  Two providers ship with the repo:
//    • mock  — deterministic, offline, answers the prompts listed in
//              fixtures/ai-eval/*.json. Used by graders. The default.
//    • http  — YOURS. Call any LLM API you like (Anthropic, OpenAI,
//              Gemini, Ollama, …) with plain fetch(). Read the endpoint,
//              key and model from the VITE_AI_* env vars (.env.example).
//
//  Do not hard-code a vendor anywhere else: everything outside this
//  file must behave identically with either provider.
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

/**
 * A provider failure with a machine-readable `code`:
 * PROVIDER_CONFIG, PROVIDER_NETWORK, PROVIDER_AUTH, PROVIDER_RATE_LIMIT,
 * PROVIDER_HTTP or PROVIDER_EMPTY. Messages are meant for the user and
 * never contain the API key.
 */
export class ProviderError extends Error {
    constructor(code, message, extra = {}) {
        super(message)
        this.name = 'ProviderError'
        this.code = code
        Object.assign(this, extra)
    }
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5'
const MAX_TOKENS = 1024

function isAnthropic(endpoint) {
    try {
        return new URL(endpoint).host.includes('anthropic.com')
    } catch {
        return String(endpoint).includes('anthropic.com')
    }
}

// The two wire formats. Each returns { url, init } for fetch and knows how
// to pull the text back out of a successful JSON body.
const WIRE = {
    anthropic: {
        build({ endpoint, apiKey, model, request }) {
            return {
                url: endpoint,
                init: {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        // The app calls the API straight from the browser.
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    body: JSON.stringify({
                        model: model || DEFAULT_ANTHROPIC_MODEL,
                        max_tokens: MAX_TOKENS,
                        system: request.system,
                        messages: [...(request.history ?? []), { role: 'user', content: request.user }],
                    }),
                },
            }
        },
        text(body) {
            const parts = Array.isArray(body?.content) ? body.content : []
            return parts.filter(p => p?.type === 'text').map(p => p.text ?? '').join('')
        },
    },
    openai: {
        build({ endpoint, apiKey, model, request }) {
            return {
                url: endpoint,
                init: {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model,
                        temperature: 0,
                        messages: [
                            { role: 'system', content: request.system },
                            ...(request.history ?? []),
                            { role: 'user', content: request.user },
                        ],
                    }),
                },
            }
        },
        text(body) {
            const content = body?.choices?.[0]?.message?.content
            return typeof content === 'string' ? content : ''
        },
    },
}

async function readBodySnippet(response) {
    try {
        const text = await response.text()
        return text.length > 300 ? text.slice(0, 300) + '…' : text
    } catch {
        return ''
    }
}

/** @returns {Provider} */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint ?? env.VITE_AI_ENDPOINT
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY
    const model = config.model ?? env.VITE_AI_MODEL
    const fetchImpl = config.fetch ?? ((...args) => globalThis.fetch(...args))

    return {
        name: 'http',
        async complete(request) {
            if (!endpoint) {
                throw new ProviderError('PROVIDER_CONFIG', 'No AI endpoint configured. Set VITE_AI_ENDPOINT in .env.local and restart the dev server.')
            }
            if (!apiKey) {
                throw new ProviderError('PROVIDER_CONFIG', 'No AI API key configured. Set VITE_AI_API_KEY in .env.local and restart the dev server.')
            }
            const wire = isAnthropic(endpoint) ? WIRE.anthropic : WIRE.openai
            const { url, init } = wire.build({ endpoint, apiKey, model, request })

            let response
            try {
                response = await fetchImpl(url, init)
            } catch (err) {
                throw new ProviderError('PROVIDER_NETWORK', `Could not reach the AI service (${err?.message || 'network error'}). Check your connection and the endpoint URL.`)
            }

            if (response.status === 401 || response.status === 403) {
                throw new ProviderError('PROVIDER_AUTH', `The AI service rejected the API key (HTTP ${response.status}). Check VITE_AI_API_KEY.`, { status: response.status })
            }
            if (response.status === 429) {
                const retryAfter = response.headers?.get?.('retry-after') ?? null
                const wait = retryAfter ? ` Try again in ${retryAfter} seconds.` : ' Wait a moment and try again.'
                throw new ProviderError('PROVIDER_RATE_LIMIT', `The AI service is rate limiting requests (HTTP 429).${wait}`, { status: 429, retryAfter })
            }
            if (!response.ok) {
                const snippet = await readBodySnippet(response)
                throw new ProviderError('PROVIDER_HTTP', `The AI service returned HTTP ${response.status}${snippet ? `: ${snippet}` : '.'}`, { status: response.status })
            }

            let body
            try {
                body = await response.json()
            } catch {
                throw new ProviderError('PROVIDER_EMPTY', 'The AI service returned a response that is not JSON.')
            }
            const text = wire.text(body)
            if (!text || !text.trim()) {
                throw new ProviderError('PROVIDER_EMPTY', 'The AI service returned no text.')
            }
            return { text, provider: 'http' }
        },
    }
}

/**
 * Pick a provider from VITE_AI_PROVIDER. Unknown values fall back to mock
 * so the app always boots.
 * @returns {Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
