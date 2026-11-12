import { describe, expect, it } from 'vitest'
import { sandboxBuyerEmail } from './sandbox-buyer-email'
import { fundingPercentage } from './pay-track-progress'

describe('Pay & Track funding progress', () => {
  it('uses verified cents and preserves a one-decimal percentage', () => {
    expect(fundingPercentage(35000, 128400)).toBe(27.3)
    expect(fundingPercentage(0, 128400)).toBe(0)
    expect(fundingPercentage(128400, 128400)).toBe(100)
    expect(fundingPercentage(128400, 0)).toBe(0)
  })
})

describe('Sandbox buyer email suggestion', () => {
  it('uses a saved contact only when no buyer email is already bound to the commitment', () => {
    expect(sandboxBuyerEmail({ expectedPayerEmail: null }, 'saved@example.test')).toBe('saved@example.test')
    expect(sandboxBuyerEmail({ expectedPayerEmail: 'bound@example.test' }, 'saved@example.test')).toBe('bound@example.test')
    expect(sandboxBuyerEmail({ expectedPayerEmail: null }, null)).toBe('')
  })

  it('keeps an explicit correction, including clearing a wrong suggestion', () => {
    expect(sandboxBuyerEmail({ expectedPayerEmail: null }, 'saved@example.test', 'buyer@example.test')).toBe('buyer@example.test')
    expect(sandboxBuyerEmail({ expectedPayerEmail: null }, 'saved@example.test', '')).toBe('')
  })
})
