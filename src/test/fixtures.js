// Test-only helpers: read fixtures from disk (node), without the
// `?raw` imports that src/fixtures/loadSample.js needs under Vite.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Same rules as parseTsv in src/fixtures/loadSample.js. */
export function parseTsv(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.map(line => line.split('\t'))
}

/** All lines of a fixture TSV as string[][] (header included). */
export function loadFixtureRows(name) {
    return parseTsv(readFileSync(ROOT + 'fixtures/' + name, 'utf8'))
}

/** `{ header, rows }` table for the executor and context builder. */
export function loadFixtureTable(name) {
    const all = loadFixtureRows(name)
    return { header: all[0], rows: all.slice(1) }
}

/** Parsed JSON fixture from fixtures/ai-eval. */
export function loadEval(name) {
    return JSON.parse(readFileSync(ROOT + 'fixtures/ai-eval/' + name, 'utf8'))
}
