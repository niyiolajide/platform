export type MoneyCents = bigint | number | string

export interface MortgageTerms {
  /** Original principal in cents. */
  originalBalanceCents: MoneyCents
  /** Nominal annual interest rate as a decimal, e.g. 0.065 for 6.5%. */
  annualInterestRate: number
  /** Loan origination/closing date. First payment is one month after this date. */
  originationDate: Date | string
  /** Either maturityDate or termMonths is required. */
  maturityDate?: Date | string | null
  termMonths?: number | null
  /** Optional contractual monthly principal-and-interest payment in cents. */
  monthlyPaymentCents?: MoneyCents | null
}

export interface MortgageScheduleRow {
  paymentNumber: number
  paymentDate: string
  startingBalanceCents: bigint
  paymentCents: bigint
  principalCents: bigint
  interestCents: bigint
  endingBalanceCents: bigint
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function cents(value: MoneyCents): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('money value must be finite')
    return BigInt(Math.round(value))
  }
  if (!/^-?\d+$/.test(value.trim())) throw new Error(`invalid cents value "${value}"`)
  return BigInt(value)
}

function parseDate(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(d.getTime())) throw new Error(`invalid date "${String(value)}"`)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

export function addMonthsClamped(date: Date | string, months: number): string {
  const d = parseDate(date)
  const day = d.getUTCDate()
  const targetMonth = d.getUTCMonth() + months
  const year = d.getUTCFullYear() + Math.floor(targetMonth / 12)
  const month = ((targetMonth % 12) + 12) % 12
  const clampedDay = Math.min(day, lastDayOfMonth(year, month))
  return dateOnly(new Date(Date.UTC(year, month, clampedDay)))
}

function monthsBetween(start: Date, end: Date): number {
  const raw = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth())
  const candidate = parseDate(addMonthsClamped(start, raw))
  return candidate.getTime() > end.getTime() ? raw - 1 : raw
}

function termMonths(terms: MortgageTerms): number {
  if (terms.termMonths != null) {
    if (!Number.isInteger(terms.termMonths) || terms.termMonths <= 0) throw new Error('termMonths must be a positive integer')
    return terms.termMonths
  }
  if (!terms.maturityDate) throw new Error('mortgage terms require termMonths or maturityDate')
  const n = monthsBetween(parseDate(terms.originationDate), parseDate(terms.maturityDate))
  if (n <= 0) throw new Error('maturityDate must be after originationDate')
  return n
}

export function mortgageMonthlyPaymentCents(terms: MortgageTerms): bigint {
  const principal = cents(terms.originalBalanceCents)
  if (principal <= 0n) return 0n
  if (terms.monthlyPaymentCents != null) return cents(terms.monthlyPaymentCents)

  const n = termMonths(terms)
  const monthlyRate = terms.annualInterestRate / 12
  if (!Number.isFinite(monthlyRate) || monthlyRate < 0) throw new Error('annualInterestRate must be a non-negative decimal')
  if (monthlyRate === 0) return BigInt(Math.ceil(Number(principal) / n))

  const p = Number(principal)
  const payment = p * monthlyRate / (1 - Math.pow(1 + monthlyRate, -n))
  return BigInt(Math.round(payment))
}

export function mortgageAmortizationSchedule(terms: MortgageTerms): MortgageScheduleRow[] {
  const n = termMonths(terms)
  const monthlyRate = terms.annualInterestRate / 12
  if (!Number.isFinite(monthlyRate) || monthlyRate < 0) throw new Error('annualInterestRate must be a non-negative decimal')

  let balance = cents(terms.originalBalanceCents)
  const payment = mortgageMonthlyPaymentCents(terms)
  const rows: MortgageScheduleRow[] = []
  for (let i = 1; i <= n && balance > 0n; i += 1) {
    const starting = balance
    const interest = monthlyRate === 0 ? 0n : BigInt(Math.round(Number(starting) * monthlyRate))
    const maxPayment = starting + interest
    const actualPayment = payment > maxPayment ? maxPayment : payment
    const principal = actualPayment - interest
    balance = starting - principal
    rows.push({
      paymentNumber: i,
      paymentDate: addMonthsClamped(terms.originationDate, i),
      startingBalanceCents: starting,
      paymentCents: actualPayment,
      principalCents: principal,
      interestCents: interest,
      endingBalanceCents: balance,
    })
  }
  return rows
}

export function mortgageBalanceAt(terms: MortgageTerms, asOf: Date | string): bigint {
  const target = parseDate(asOf)
  const origination = parseDate(terms.originationDate)
  if (target.getTime() < origination.getTime() - MS_PER_DAY) return cents(terms.originalBalanceCents)

  let balance = cents(terms.originalBalanceCents)
  for (const row of mortgageAmortizationSchedule(terms)) {
    if (parseDate(row.paymentDate).getTime() > target.getTime()) break
    balance = row.endingBalanceCents
  }
  return balance < 0n ? 0n : balance
}
