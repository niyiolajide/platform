"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addMonthsClamped = addMonthsClamped;
exports.mortgageMonthlyPaymentCents = mortgageMonthlyPaymentCents;
exports.mortgageAmortizationSchedule = mortgageAmortizationSchedule;
exports.mortgageBalanceAt = mortgageBalanceAt;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function cents(value) {
    if (typeof value === 'bigint') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('money value must be finite');
        }
        return BigInt(Math.round(value));
    }
    if (!/^-?\d+$/.test(value.trim())) {
        throw new Error(`invalid cents value "${value}"`);
    }
    return BigInt(value);
}
function parseDate(value) {
    const d = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(d.getTime())) {
        throw new Error(`invalid date "${String(value)}"`);
    }
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function dateOnly(d) {
    return d.toISOString().slice(0, 10);
}
function lastDayOfMonth(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
function addMonthsClamped(date, months) {
    const d = parseDate(date);
    const day = d.getUTCDate();
    const targetMonth = d.getUTCMonth() + months;
    const year = d.getUTCFullYear() + Math.floor(targetMonth / 12);
    const month = ((targetMonth % 12) + 12) % 12;
    const clampedDay = Math.min(day, lastDayOfMonth(year, month));
    return dateOnly(new Date(Date.UTC(year, month, clampedDay)));
}
function monthsBetween(start, end) {
    const raw = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
    const candidate = parseDate(addMonthsClamped(start, raw));
    return candidate.getTime() > end.getTime() ? raw - 1 : raw;
}
function termMonths(terms) {
    if (terms.termMonths != null) {
        if (!Number.isInteger(terms.termMonths) || terms.termMonths <= 0) {
            throw new Error('termMonths must be a positive integer');
        }
        return terms.termMonths;
    }
    if (terms.maturityDate == null || terms.maturityDate === '') {
        throw new Error('mortgage terms require termMonths or maturityDate');
    }
    const n = monthsBetween(parseDate(terms.originationDate), parseDate(terms.maturityDate));
    if (n <= 0) {
        throw new Error('maturityDate must be after originationDate');
    }
    return n;
}
function mortgageMonthlyPaymentCents(terms) {
    const principal = cents(terms.originalBalanceCents);
    if (principal <= 0n) {
        return 0n;
    }
    if (terms.monthlyPaymentCents != null) {
        return cents(terms.monthlyPaymentCents);
    }
    const n = termMonths(terms);
    const monthlyRate = terms.annualInterestRate / 12;
    if (!Number.isFinite(monthlyRate) || monthlyRate < 0) {
        throw new Error('annualInterestRate must be a non-negative decimal');
    }
    if (monthlyRate === 0) {
        return BigInt(Math.ceil(Number(principal) / n));
    }
    const p = Number(principal);
    const payment = p * monthlyRate / (1 - Math.pow(1 + monthlyRate, -n));
    return BigInt(Math.round(payment));
}
function mortgageAmortizationSchedule(terms) {
    const n = termMonths(terms);
    const monthlyRate = terms.annualInterestRate / 12;
    if (!Number.isFinite(monthlyRate) || monthlyRate < 0) {
        throw new Error('annualInterestRate must be a non-negative decimal');
    }
    let balance = cents(terms.originalBalanceCents);
    const payment = mortgageMonthlyPaymentCents(terms);
    const rows = [];
    for (let i = 1; i <= n && balance > 0n; i += 1) {
        const starting = balance;
        const interest = monthlyRate === 0 ? 0n : BigInt(Math.round(Number(starting) * monthlyRate));
        const maxPayment = starting + interest;
        const actualPayment = payment > maxPayment ? maxPayment : payment;
        const principal = actualPayment - interest;
        balance = starting - principal;
        rows.push({
            paymentNumber: i,
            paymentDate: addMonthsClamped(terms.originationDate, i),
            startingBalanceCents: starting,
            paymentCents: actualPayment,
            principalCents: principal,
            interestCents: interest,
            endingBalanceCents: balance,
        });
    }
    return rows;
}
function mortgageBalanceAt(terms, asOf) {
    const target = parseDate(asOf);
    const origination = parseDate(terms.originationDate);
    if (target.getTime() < origination.getTime() - MS_PER_DAY) {
        return cents(terms.originalBalanceCents);
    }
    let balance = cents(terms.originalBalanceCents);
    for (const row of mortgageAmortizationSchedule(terms)) {
        if (parseDate(row.paymentDate).getTime() > target.getTime()) {
            break;
        }
        balance = row.endingBalanceCents;
    }
    return balance < 0n ? 0n : balance;
}
