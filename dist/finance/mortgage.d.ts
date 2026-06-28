export type MoneyCents = bigint | number | string;
export interface MortgageTerms {
    /** Original principal in cents. */
    originalBalanceCents: MoneyCents;
    /** Nominal annual interest rate as a decimal, e.g. 0.065 for 6.5%. */
    annualInterestRate: number;
    /** Loan origination/closing date. First payment is one month after this date. */
    originationDate: Date | string;
    /** Either maturityDate or termMonths is required. */
    maturityDate?: Date | string | null;
    termMonths?: number | null;
    /** Optional contractual monthly principal-and-interest payment in cents. */
    monthlyPaymentCents?: MoneyCents | null;
}
export interface MortgageScheduleRow {
    paymentNumber: number;
    paymentDate: string;
    startingBalanceCents: bigint;
    paymentCents: bigint;
    principalCents: bigint;
    interestCents: bigint;
    endingBalanceCents: bigint;
}
export declare function addMonthsClamped(date: Date | string, months: number): string;
export declare function mortgageMonthlyPaymentCents(terms: MortgageTerms): bigint;
export declare function mortgageAmortizationSchedule(terms: MortgageTerms): MortgageScheduleRow[];
export declare function mortgageBalanceAt(terms: MortgageTerms, asOf: Date | string): bigint;
