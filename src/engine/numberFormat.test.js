import { describe, it, expect } from 'vitest'
import { formatNumberDisplay } from './numberFormat.js'

// AI_CONTRACT.md §4 display table: input → [number, currency, percent, date]
const TABLE = [
    ['79', ['79.00', '$79.00', '7900%', '79']],
    ['$1,200.00', ['1,200.00', '$1,200.00', '120000%', '$1,200.00']],
    ['0.1', ['0.10', '$0.10', '10%', '0.1']],
    ['10%', ['0.10', '$0.10', '10%', '10%']],
    ['n/a', ['n/a', 'n/a', 'n/a', 'n/a']],
    ['2024-01-15', ['2024-01-15', '2024-01-15', '2024-01-15', '2024-01-15']],
    ['1/15/2024', ['1/15/2024', '1/15/2024', '1/15/2024', '2024-01-15']],
    ['15 Jan 2024', ['15 Jan 2024', '15 Jan 2024', '15 Jan 2024', '2024-01-15']],
]
const FORMATS = ['number', 'currency', 'percent', 'date']

describe('formatNumberDisplay: contract §4 table', () => {
    for (const [input, outputs] of TABLE) {
        FORMATS.forEach((fmt, i) => {
            it(`${fmt}(${JSON.stringify(input)}) → ${outputs[i]}`, () => {
                expect(formatNumberDisplay(input, fmt)).toBe(outputs[i])
            })
        })
    }
})

describe('formatNumberDisplay: edge cases', () => {
    it('leaves general and missing formats unchanged', () => {
        expect(formatNumberDisplay('$1,200.00', 'general')).toBe('$1,200.00')
        expect(formatNumberDisplay(' West ', undefined)).toBe(' West ')
    })

    it('keeps blanks blank', () => {
        for (const fmt of FORMATS) expect(formatNumberDisplay('', fmt)).toBe('')
        expect(formatNumberDisplay(null, 'currency')).toBe('')
    })

    it('puts the minus sign before the currency symbol', () => {
        expect(formatNumberDisplay('-5', 'currency')).toBe('-$5.00')
        expect(formatNumberDisplay(-1234.5, 'number')).toBe('-1,234.50')
        expect(formatNumberDisplay('-0.001', 'currency')).toBe('$0.00')
    })

    it('accepts computed numbers', () => {
        expect(formatNumberDisplay(1200, 'currency')).toBe('$1,200.00')
        expect(formatNumberDisplay(0.125, 'percent')).toBe('12.5%')
        expect(formatNumberDisplay(22648023.35, 'number')).toBe('22,648,023.35')
        expect(formatNumberDisplay(42, 'general')).toBe('42')
        expect(formatNumberDisplay(45306, 'date')).toBe('45306')
    })

    it('handles the messier sample spellings', () => {
        expect(formatNumberDisplay('$ 49.99', 'currency')).toBe('$49.99')
        expect(formatNumberDisplay('15 %', 'percent')).toBe('15%')
        expect(formatNumberDisplay('1.005', 'number')).toBe('1.01')
        expect(formatNumberDisplay('0.1234', 'percent')).toBe('12.34%')
        expect(formatNumberDisplay('2024-1-5', 'date')).toBe('2024-01-05')
        expect(formatNumberDisplay('15 January 2024', 'date')).toBe('2024-01-15')
    })
})
