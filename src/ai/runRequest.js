// ─────────────────────────────────────────────────────────────
//  One AI round trip: prompt → provider → validated action.
//  The UI calls this and never sees which vendor (or the mock)
//  answered. Nothing here executes or applies the action.
// ─────────────────────────────────────────────────────────────
import { buildSystemPrompt } from './prompt.js'
import { parseModelResponse } from './validate.js'

/**
 * Ask the provider for one action and validate it.
 * Provider failures become `PROVIDER_ERROR` with `detail` = "<code>: <message>".
 * @param {{ provider: import('./provider.js').Provider, prompt: string, context: object,
 *           history?: Array<{role:'user'|'assistant', content:string}> }} args
 * @returns {Promise<{ok: true, action: object, rawText: string} |
 *                   {ok: false, error: string, detail: string, rawText: string|null}>}
 */
export async function runAiRequest({ provider, prompt, context, history = [] }) {
    const system = buildSystemPrompt(context)
    let rawText
    try {
        // `user` is the user's words only: the mock matches it verbatim.
        const response = await provider.complete({ system, user: prompt, history })
        rawText = response?.text ?? ''
    } catch (err) {
        const code = err?.code ?? 'PROVIDER_UNKNOWN'
        return { ok: false, error: 'PROVIDER_ERROR', detail: `${code}: ${err?.message ?? String(err)}`, rawText: null }
    }
    const parsed = parseModelResponse(rawText)
    if (!parsed.ok) return { ...parsed, rawText }
    return { ok: true, action: parsed.action, rawText }
}
