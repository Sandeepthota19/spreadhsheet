// ─────────────────────────────────────────────────────────────
//  System prompt for the model. Vendor-neutral plain text.
//
//  Where the sheet context goes: AI_CONTRACT.md §1 suggests the user
//  turn, but the mock provider matches `user` verbatim against the
//  golden prompts, so the context lives in the SYSTEM prompt and the
//  user turn is exactly what the user typed. The model sees the same
//  information either way.
// ─────────────────────────────────────────────────────────────
import {
    QUERY_PLAN_SCHEMA, FORMAT_SHEET_SCHEMA, CLARIFY_SCHEMA, MAX_RESULT_ROWS,
    FILTER_OPS, AGGREGATE_FNS,
} from './contract.js'

/**
 * Build the system prompt: task, schemas, rules, sheet context, answer format.
 * @param {object} context output of buildSheetContext
 * @returns {string}
 */
export function buildSystemPrompt(context) {
    return [
        'You translate a spreadsheet user\'s request into exactly ONE JSON action for a spreadsheet app.',
        'You never compute numbers yourself: the app executes your plan over the real data and shows the results.',
        '',
        'Allowed actions (JSON Schema, draft-07 style):',
        `- query (read-only analysis plan): ${JSON.stringify(QUERY_PLAN_SCHEMA)}`,
        `- format_sheet (formatting intent): ${JSON.stringify(FORMAT_SHEET_SCHEMA)}`,
        `- clarify (ask the user a question): ${JSON.stringify(CLARIFY_SCHEMA)}`,
        '',
        'Rules:',
        '1. Use column names exactly as they appear in the sheet context below (verbatim spelling).',
        '2. If the request needs a column that does not exist, or could mean more than one column, answer with a clarify action instead of guessing.',
        '3. query is read-only. Requests to delete, edit, insert or otherwise change data cannot be done: answer with a clarify action that says so.',
        `4. Filter ops: ${FILTER_OPS.join(', ')}. Filters combine with AND. Dates in filter values use YYYY-MM-DD.`,
        `5. Aggregate fns: ${AGGREGATE_FNS.join(', ')}. Set "as" to a short readable output name. Sort entries name OUTPUT columns (a groupBy column, an aggregate "as" name, or a source column for row results).`,
        `6. limit is a positive integer, at most ${MAX_RESULT_ROWS}. For "top N" questions sort and set limit N.`,
        '7. The totals row (if hasTotalsRow) is excluded from queries by default; only set excludeTotalsRow to false if the user explicitly asks to include it.',
        '8. format_sheet: "col" indices are 0-based (column A is 0) and must be within the used range. Row 1 is the header, the rows below are the body, and totalsStyle targets the last row only when it is a totals row.',
        '9. freezeRows: a number freezes that many top rows (0 unfreezes); leave it out when the user did not mention freezing. Never freeze as many rows as the sheet uses.',
        '10. Only include fields the user asked for. Do not add fields that are not in the schema.',
        '',
        'Sheet context (headers, inferred types, examples and up to five sample rows; not the full data):',
        JSON.stringify(context),
        '',
        'Answer with a single JSON object and nothing else.',
    ].join('\n')
}
