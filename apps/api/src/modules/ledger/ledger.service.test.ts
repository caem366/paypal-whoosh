import { describe, expect, it } from 'vitest'

import { assertEntryAccountCurrencies, assertJournalBalanced } from './ledger.service.js'

describe('ledger service', () => {
  it('accepts a balanced journal', () => {
    expect(() =>
      assertJournalBalanced([
        {
          accountId: 'caelan-wallet',
          direction: 'debit',
          amountCents: 50_000,
          currency: 'CAD',
        },
        {
          accountId: 'system-funding',
          direction: 'credit',
          amountCents: 50_000,
          currency: 'CAD',
        },
      ]),
    ).not.toThrow()
  })

  it('rejects an unbalanced journal', () => {
    expect(() =>
      assertJournalBalanced([
        {
          accountId: 'caelan-wallet',
          direction: 'debit',
          amountCents: 50_000,
          currency: 'CAD',
        },
        {
          accountId: 'system-funding',
          direction: 'credit',
          amountCents: 49_999,
          currency: 'CAD',
        },
      ]),
    ).toThrow('Journal is unbalanced')
  })

  it('rejects a zero-value entry', () => {
    expect(() =>
      assertJournalBalanced([
        {
          accountId: 'caelan-wallet',
          direction: 'debit',
          amountCents: 0,
          currency: 'CAD',
        },
        {
          accountId: 'system-funding',
          direction: 'credit',
          amountCents: 0,
          currency: 'CAD',
        },
      ]),
    ).toThrow()
  })
  it('rejects equal debits and credits in different currencies', () => {
    expect(() => assertJournalBalanced([
      { accountId: 'expense', direction: 'debit', amountCents: 100, currency: 'USD' },
      { accountId: 'clearing', direction: 'credit', amountCents: 100, currency: 'CAD' },
    ])).toThrow('one currency')
  })
  it('rejects a USD entry posted to a CAD account', () => {
    expect(() => assertEntryAccountCurrencies([
      { accountId: 'expense', direction: 'debit', amountCents: 100, currency: 'USD' },
    ], [{ id: 'expense', currency: 'CAD' }])).toThrow('currency must match')
  })
})
