// ─────────────────────────────────────────────────────────────
//  Formula language: tokenizer, recursive-descent parser and
//  evaluator. Pure — knows nothing about how cells are stored.
//
//  A parsed formula is a *template*:
//    pieces  the source text split around references, e.g.
//            ['=', 0, '*', 1]   (numbers index into refs)
//    ast     expression tree; ref nodes point into refs by index
//    refs    the references as written, in positions:
//            { kind: 'cell',  row, col, absRow, absCol }
//            { kind: 'range', r1, c1, r2, c2, absR1, absC1, absR2, absC2 }
//
//  The engine rebinds refs to stable row/column identities, so the
//  same template can be shared by thousands of filled cells and the
//  text is re-rendered from the refs' current positions.
// ─────────────────────────────────────────────────────────────

import { columnIndex } from './address.js'
import { toNum } from './values.js'

export class CellError {
    constructor(code) { this.code = code }
    toString() { return this.code }
}

export const ERR = Object.freeze({
    REF: new CellError('#REF!'),
    VALUE: new CellError('#VALUE!'),
    DIV0: new CellError('#DIV/0!'),
    NAME: new CellError('#NAME?'),
    PARSE: new CellError('#PARSE!'),
    CYCLE: new CellError('#CYCLE!'),
})

export const isError = (v) => v instanceof CellError

const REF_SRC = '(\\$?)([A-Za-z]{1,3})(\\$?)(\\d+)'
const RANGE_RE = new RegExp('^' + REF_SRC + ':' + REF_SRC)
const CELL_RE = new RegExp('^' + REF_SRC + '(?![A-Za-z0-9_(])')
const NUMBER_RE = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*/

function cellRefFrom(m, offset) {
    return {
        absCol: m[offset] === '$',
        col: columnIndex(m[offset + 1]),
        absRow: m[offset + 2] === '$',
        row: parseInt(m[offset + 3], 10) - 1,
    }
}

// ── Tokenizer ──

function tokenize(src) {
    const tokens = []
    let i = 0
    while (i < src.length) {
        const rest = src.slice(i)
        const ch = src[i]
        let m
        if (ch === ' ' || ch === '\t') {
            let j = i
            while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++
            tokens.push({ type: 'ws', text: src.slice(i, j) })
            i = j
        } else if (ch === '"') {
            let j = i + 1
            let value = ''
            while (j < src.length) {
                if (src[j] === '"' && src[j + 1] === '"') { value += '"'; j += 2; continue }
                if (src[j] === '"') break
                value += src[j++]
            }
            if (j >= src.length) throw new SyntaxError('Unterminated string')
            tokens.push({ type: 'str', value, text: src.slice(i, j + 1) })
            i = j + 1
        } else if (rest.toUpperCase().startsWith('#REF!')) {
            // A reference that was deleted renders as #REF!; reading it back keeps the error.
            tokens.push({ type: 'err', text: '#REF!' })
            i += 5
        } else if ((m = RANGE_RE.exec(rest))) {
            const a = cellRefFrom(m, 1)
            const b = cellRefFrom(m, 5)
            tokens.push({ type: 'range', a, b, text: m[0] })
            i += m[0].length
        } else if ((m = CELL_RE.exec(rest))) {
            tokens.push({ type: 'ref', ref: cellRefFrom(m, 1), text: m[0] })
            i += m[0].length
        } else if ((m = NUMBER_RE.exec(rest))) {
            tokens.push({ type: 'num', value: parseFloat(m[0]), text: m[0] })
            i += m[0].length
        } else if ((m = IDENT_RE.exec(rest))) {
            tokens.push({ type: 'ident', value: m[0].toUpperCase(), text: m[0].toUpperCase() })
            i += m[0].length
        } else if ('+-*/^&(),'.includes(ch)) {
            tokens.push({ type: ch, text: ch })
            i++
        } else {
            throw new SyntaxError(`Unexpected character "${ch}"`)
        }
    }
    return tokens
}

// ── Parser ──

/**
 * Parse formula text (with or without the leading '=') into a template.
 * Throws SyntaxError on malformed input.
 * @param {string} text
 */
export function parseFormula(text) {
    const body = text.startsWith('=') ? text.slice(1) : text
    const tokens = tokenize(body)
    const refs = []
    const pieces = ['=']
    for (const t of tokens) {
        if (t.type === 'ref' || t.type === 'range') {
            t.refIndex = refs.length
            if (t.type === 'ref') {
                refs.push({ kind: 'cell', ...t.ref })
            } else {
                const top = t.a.row <= t.b.row ? t.a : t.b
                const bottom = top === t.a ? t.b : t.a
                const left = t.a.col <= t.b.col ? t.a : t.b
                const right = left === t.a ? t.b : t.a
                refs.push({
                    kind: 'range',
                    r1: top.row, absR1: top.absRow, r2: bottom.row, absR2: bottom.absRow,
                    c1: left.col, absC1: left.absCol, c2: right.col, absC2: right.absCol,
                })
            }
            pieces.push(t.refIndex)
        } else if (typeof pieces[pieces.length - 1] === 'string') {
            pieces[pieces.length - 1] += t.text
        } else {
            pieces.push(t.text)
        }
    }

    const sig = tokens.filter(t => t.type !== 'ws')
    let pos = 0
    const peek = () => sig[pos]
    const take = (type) => {
        const t = sig[pos]
        if (!t || (type && t.type !== type)) throw new SyntaxError(`Expected ${type || 'a value'}`)
        pos++
        return t
    }

    function parseExpression() { return parseConcat() }

    function parseConcat() {
        let left = parseAdditive()
        while (peek()?.type === '&') { take(); left = { t: 'bin', op: '&', l: left, r: parseAdditive() } }
        return left
    }

    function parseAdditive() {
        let left = parseMultiplicative()
        while (peek()?.type === '+' || peek()?.type === '-') {
            const op = take().type
            left = { t: 'bin', op, l: left, r: parseMultiplicative() }
        }
        return left
    }

    function parseMultiplicative() {
        let left = parsePower()
        while (peek()?.type === '*' || peek()?.type === '/') {
            const op = take().type
            left = { t: 'bin', op, l: left, r: parsePower() }
        }
        return left
    }

    function parsePower() {
        let left = parseUnary()
        while (peek()?.type === '^') { take(); left = { t: 'bin', op: '^', l: left, r: parseUnary() } }
        return left
    }

    function parseUnary() {
        if (peek()?.type === '-') { take(); return { t: 'neg', e: parseUnary() } }
        if (peek()?.type === '+') { take(); return parseUnary() }
        return parsePrimary()
    }

    function parsePrimary() {
        const t = take()
        switch (t.type) {
            case 'num': return { t: 'num', v: t.value }
            case 'str': return { t: 'str', v: t.value }
            case 'ref': return { t: 'ref', i: t.refIndex }
            case 'range': return { t: 'range', i: t.refIndex }
            case 'err': return { t: 'err' }
            case '(': {
                const inner = parseExpression()
                take(')')
                return inner
            }
            case 'ident': {
                if (peek()?.type !== '(') return { t: 'name', v: t.value }
                take('(')
                const args = []
                if (peek()?.type !== ')') {
                    args.push(parseExpression())
                    while (peek()?.type === ',') { take(); args.push(parseExpression()) }
                }
                take(')')
                return { t: 'fn', name: t.value, args }
            }
            default:
                throw new SyntaxError(`Unexpected "${t.text}"`)
        }
    }

    if (sig.length === 0) throw new SyntaxError('Empty formula')
    const ast = parseExpression()
    if (pos !== sig.length) throw new SyntaxError(`Unexpected "${sig[pos].text}"`)
    return { pieces, ast, refs }
}

// ── Evaluator ──

function asNumber(v) {
    if (isError(v)) throw v
    if (v === null || v === undefined || v === '') return 0
    if (typeof v === 'number') return v
    if (typeof v === 'boolean') return v ? 1 : 0
    const n = toNum(v)
    if (n === null) throw ERR.VALUE
    return n
}

function asText(v) {
    if (isError(v)) throw v
    if (v === null || v === undefined) return ''
    return typeof v === 'number' ? formatNumber(v) : String(v)
}

/** Display text for a computed number: no float noise, no exponent for normal sizes. */
export function formatNumber(n) {
    if (Number.isInteger(n)) return String(n)
    return String(parseFloat(n.toPrecision(12)))
}

// Collect the numeric values a function argument contributes. Inside a
// range only real numbers count (text and blanks are skipped, as in
// spreadsheets); a direct argument is coerced.
function collectNumbers(arg, ctx, out) {
    if (arg.t === 'range') {
        ctx.eachInRange(arg.i, (v) => {
            if (isError(v)) throw v
            if (typeof v === 'number') out.push(v)
        })
    } else {
        out.push(asNumber(evaluate(arg, ctx)))
    }
}

const FUNCTIONS = {
    SUM(args, ctx) {
        const nums = []
        for (const a of args) collectNumbers(a, ctx, nums)
        let s = 0
        for (const n of nums) s += n
        return s
    },
    AVERAGE(args, ctx) {
        const nums = []
        for (const a of args) collectNumbers(a, ctx, nums)
        if (nums.length === 0) throw ERR.DIV0
        let s = 0
        for (const n of nums) s += n
        return s / nums.length
    },
    MIN(args, ctx) {
        const nums = []
        for (const a of args) collectNumbers(a, ctx, nums)
        let m = Infinity
        for (const n of nums) if (n < m) m = n
        return nums.length ? m : 0
    },
    MAX(args, ctx) {
        const nums = []
        for (const a of args) collectNumbers(a, ctx, nums)
        let m = -Infinity
        for (const n of nums) if (n > m) m = n
        return nums.length ? m : 0
    },
    COUNT(args, ctx) {
        const nums = []
        for (const a of args) {
            try { collectNumbers(a, ctx, nums) } catch (e) { if (!isError(e)) throw e }
        }
        return nums.length
    },
    ABS(args, ctx) {
        if (args.length !== 1) throw ERR.VALUE
        return Math.abs(asNumber(evaluate(args[0], ctx)))
    },
    ROUND(args, ctx) {
        if (args.length < 1 || args.length > 2) throw ERR.VALUE
        const x = asNumber(evaluate(args[0], ctx))
        const digits = args.length === 2 ? asNumber(evaluate(args[1], ctx)) : 0
        const f = Math.pow(10, Math.trunc(digits))
        return Math.round(x * f) / f
    },
}
FUNCTIONS.AVG = FUNCTIONS.AVERAGE

export const FUNCTION_NAMES = Object.freeze(Object.keys(FUNCTIONS))

/**
 * Evaluate an AST node. Errors are thrown as CellError values.
 * @param {object} node
 * @param {{ ref(i:number): unknown, eachInRange(i:number, cb:(v:unknown)=>void): void }} ctx
 */
export function evaluate(node, ctx) {
    switch (node.t) {
        case 'num': return node.v
        case 'str': return node.v
        case 'ref': {
            const v = ctx.ref(node.i)
            if (isError(v)) throw v
            return v
        }
        case 'range': throw ERR.VALUE
        case 'name': throw ERR.NAME
        case 'err': throw ERR.REF
        case 'neg': return -asNumber(evaluate(node.e, ctx))
        case 'bin': {
            const l = evaluate(node.l, ctx)
            const r = evaluate(node.r, ctx)
            if (node.op === '&') return asText(l) + asText(r)
            const a = asNumber(l)
            const b = asNumber(r)
            switch (node.op) {
                case '+': return a + b
                case '-': return a - b
                case '*': return a * b
                case '/':
                    if (b === 0) throw ERR.DIV0
                    return a / b
                case '^': return Math.pow(a, b)
            }
            throw ERR.VALUE
        }
        case 'fn': {
            const fn = FUNCTIONS[node.name]
            if (!fn) throw ERR.NAME
            return fn(node.args, ctx)
        }
    }
    throw ERR.VALUE
}

/** Run a template's AST, turning thrown CellErrors into values. */
export function evaluateTemplate(ast, ctx) {
    try {
        const v = evaluate(ast, ctx)
        if (typeof v === 'number' && !Number.isFinite(v)) return ERR.VALUE
        return v === null || v === undefined ? 0 : v
    } catch (e) {
        if (isError(e)) return e
        throw e
    }
}
