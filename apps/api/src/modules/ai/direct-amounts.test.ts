import { describe, expect, it } from 'vitest'
import { parseDirectAmountRequest } from './direct-amounts.js'

const members = [
  { id: 'jordan', name: 'Jordan Bell' }, { id: 'avery', name: 'Avery Chen' },
  { id: 'morgan', name: 'Morgan Rivera' }, { id: 'sam', name: 'Sam Patel' },
]

describe('whole-receipt contribution instructions', () => {
  it('resolves named dollar amounts, same, and the rest in exact cents', () => {
    expect(parseDirectAmountRequest('Jordan pays three hundred and fifty dollars. Avery pays the same. Morgan pays two hundred and eighty-four. Sam covers the rest.', members, 128400)).toEqual({ status: 'READY', amounts: [
      { memberId: 'jordan', amountCents: 35000 }, { memberId: 'avery', amountCents: 35000 },
      { memberId: 'morgan', amountCents: 28400 }, { memberId: 'sam', amountCents: 30000 },
    ] })
  })

  it('clarifies unknown people, missing shares, and totals that do not reconcile', () => {
    expect(parseDirectAmountRequest('Jordan pays $350. Avery pays $350. Morgan pays $284. Chris covers the rest.', members, 128400)?.status).toBe('NEEDS_CLARIFICATION')
    expect(parseDirectAmountRequest('Jordan pays $350. Avery pays $350. Morgan pays $284.', members, 128400)?.status).toBe('NEEDS_CLARIFICATION')
    expect(parseDirectAmountRequest('Jordan pays $350. Avery pays $350. Morgan pays $284. Sam pays $299.', members, 128400)?.status).toBe('NEEDS_CLARIFICATION')
  })

  it('leaves item-assignment instructions to the existing interpreter', () => {
    expect(parseDirectAmountRequest('Morgan is not taking the shuttle. Avery and Jordan cover the upgrade. Split tickets four ways.', members, 128400)).toBeNull()
    expect(parseDirectAmountRequest('Morgan pays for the shuttle. Avery covers the upgrade.', members, 128400)).toBeNull()
    expect(parseDirectAmountRequest('Morgan may pay at most $200 but must cover everything', members, 128400)).toBeNull()
  })
})
