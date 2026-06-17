import { describe, it, expect } from 'vitest'
import { createAnonymizer } from '../src/ai/anonymize'

describe('createAnonymizer', () => {
  it('masks direct identifiers and never leaks them in the masked text', () => {
    const a = createAnonymizer()
    const src =
      'Email jane.doe@example.com, call (415) 555-0132, SSN 123-45-6789, ' +
      'card 4111 1111 1111 1111, server 192.168.1.42.'
    const masked = a.mask(src)
    expect(masked).not.toContain('jane.doe@example.com')
    expect(masked).not.toContain('555-0132')
    expect(masked).not.toContain('123-45-6789')
    expect(masked).not.toContain('4111')
    expect(masked).not.toContain('192.168.1.42')
    expect(masked).toMatch(/\[EMAIL_1\]/)
    expect(masked).toMatch(/\[PHONE_1\]/)
    expect(masked).toMatch(/\[SSN_1\]/)
    expect(masked).toMatch(/\[CARD_1\]/)
    expect(masked).toMatch(/\[IP_1\]/)
  })

  it('round-trips: unmask(mask(x)) === x', () => {
    const a = createAnonymizer()
    const src = 'Contact Mr. John Smith at john@acme.io about 100 Main Street.'
    expect(a.unmask(a.mask(src))).toBe(src)
  })

  it('keeps monetary amounts untouched', () => {
    const a = createAnonymizer()
    const src = 'Spent $1,234.56 and earned $2,000.00 this month.'
    const masked = a.mask(src)
    expect(masked).toBe(src)
  })

  it('reuses the same token for a repeated value (and is consistent across calls)', () => {
    const a = createAnonymizer()
    const m1 = a.mask('Reach jane@x.com today')
    const m2 = a.mask('jane@x.com is the address')
    const tok1 = m1.match(/\[EMAIL_\d+\]/)![0]
    const tok2 = m2.match(/\[EMAIL_\d+\]/)![0]
    expect(tok1).toBe(tok2)
  })

  it('detects heuristic person names but skips known non-name titlecase runs', () => {
    const a = createAnonymizer()
    const masked = a.mask('Sarah Connor moved to New York in March.')
    expect(masked).toContain('[PERSON_1]')
    expect(masked).toContain('New York') // stopword guard keeps geography
    expect(masked).toContain('March')
  })

  it('only Luhn-valid card-length digit runs are masked', () => {
    const a = createAnonymizer()
    // valid Visa test number → masked; an invalid 16-digit run → left alone
    expect(a.mask('card 4111111111111111')).toMatch(/\[CARD_1\]/)
    const b = createAnonymizer()
    expect(b.mask('ref 1234567812345678')).toContain('1234567812345678')
  })

  it('unmaskDeep restores values inside nested objects and arrays', () => {
    const a = createAnonymizer()
    const masked = a.mask('Owner: alice@home.org')
    const tok = masked.match(/\[EMAIL_\d+\]/)![0]
    const restored = a.unmaskDeep({
      summary: `See ${tok}`,
      items: [{ note: tok }, 'plain'],
      count: 3,
    })
    expect(restored).toEqual({
      summary: 'See alice@home.org',
      items: [{ note: 'alice@home.org' }, 'plain'],
      count: 3,
    })
  })

  it('unmask is a no-op when nothing was masked', () => {
    const a = createAnonymizer()
    expect(a.unmask('plain text [PERSON_9] unknown token')).toBe(
      'plain text [PERSON_9] unknown token',
    )
    expect(a.hasMappings()).toBe(false)
  })
})
