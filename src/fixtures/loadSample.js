// Loads a fixture TSV into the engine starting at A1.
// The whole load is one engine transaction, so one undo removes it.
import salesSmall from '../../fixtures/sales.tsv?raw'

export function parseTsv(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.map(line => line.split('\t'))
}

function loadTsv(engine, text, label) {
    const rows = parseTsv(text)
    const cols = Math.max(...rows.map(r => r.length))
    engine.ensureCapacity(rows.length + 20, cols + 5)
    engine.setCells(0, 0, rows, label)
    return { rows: rows.length, cols }
}

/** 33 lines: header, 31 messy data rows, totals row. */
export function loadSampleSmall(engine) {
    return loadTsv(engine, salesSmall, 'Load sales.tsv')
}

/**
 * ~3,000 lines of the same kind of data. Loaded on demand so the large
 * file is not part of the bundle that has to parse before first paint.
 */
export async function loadSampleLarge(engine) {
    const { default: salesLarge } = await import('../../fixtures/sales-large.tsv?raw')
    return loadTsv(engine, salesLarge, 'Load sales-large.tsv')
}
