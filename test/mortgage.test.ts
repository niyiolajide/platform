import { describe, expect, it } from 'vitest'
import {
  addMonthsClamped,
  mortgageAmortizationSchedule,
  mortgageBalanceAt,
  mortgageMonthlyPaymentCents,
} from '../src/finance'

describe('mortgage amortization', () => {
  it('computes the fixed monthly payment for a standard 30-year loan', () => {
    const payment = mortgageMonthlyPaymentCents({
      originalBalanceCents: 300_000_00,
      annualInterestRate: 0.06,
      originationDate: '2026-01-01',
      termMonths: 360,
    })
    expect(payment).toBe(1_798_65n)
  })

  it('uses month-anniversary payments and returns the balance at a date', () => {
    const terms = {
      originalBalanceCents: 300_000_00,
      annualInterestRate: 0.06,
      originationDate: '2026-01-15',
      termMonths: 360,
    }
    expect(mortgageBalanceAt(terms, '2026-02-14')).toBe(300_000_00n)
    expect(mortgageBalanceAt(terms, '2026-02-15')).toBe(299_701_35n)
  })

  it('emits an iterative schedule that floors the final balance at zero', () => {
    const rows = mortgageAmortizationSchedule({
      originalBalanceCents: 10_000_00,
      annualInterestRate: 0,
      originationDate: '2026-01-31',
      termMonths: 10,
    })
    expect(rows).toHaveLength(10)
    expect(rows[0]).toMatchObject({
      paymentNumber: 1,
      paymentDate: '2026-02-28',
      principalCents: 100_000n,
      interestCents: 0n,
      endingBalanceCents: 900_000n,
    })
    expect(rows.at(-1)?.endingBalanceCents).toBe(0n)
  })

  it('clamps month-end dates consistently', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonthsClamped('2026-01-31', 2)).toBe('2026-03-31')
  })
})
