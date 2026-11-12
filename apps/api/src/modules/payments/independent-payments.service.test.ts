import { describe, expect, it } from 'vitest'

import { calculateIndependentFundingProgress, capturedShareMatches, payerIdentityMatches, refundMatchesCapture } from './independent-payments.service.js'

describe('independent payer reconciliation', () => {
  const expected = { sessionId: 'PURCHASE', expectedPayeeMerchantId: 'PAYEE', currency: 'USD', participantCount: 4 }
  const shares = [35_000, 35_000, 28_400, 30_000]
  const fundingRows = (fundedCount: number) => shares.map((amountCents, index) => {
    const paid = index < fundedCount
    return {
      memberId: `MEMBER-${index}`,
      status: paid ? 'paid_verified' : 'ready_to_pay',
      amountCents,
      capturedCents: paid ? amountCents : null,
      currency: 'USD',
      allocationCents: amountCents,
      providerOrderId: paid ? `ORDER-${index}` : null,
      providerCaptureId: paid ? `CAPTURE-${index}` : null,
      providerCustomId: paid ? 'PURCHASE' : null,
      providerPayeeMerchantId: paid ? 'PAYEE' : null,
    }
  })

  it('reconciles the four Montreal captures exactly in integer cents', () => {
    const result = calculateIndependentFundingProgress(fundingRows(4), 128_400, expected)
    expect(result).toMatchObject({ fundedCents: 128_400, remainingCents: 0, fundedParticipants: 4, participantCount: 4, unpaidParticipants: 0, fullyVerified: true, fundingStatus: 'fully_funded' })
  })

  it.each([
    [1, 35_000, 93_400],
    [2, 70_000, 58_400],
    [3, 98_400, 30_000],
  ])('reports %i verified participant(s) and reconciles partial funding', (fundedCount, fundedCents, remainingCents) => {
    const result = calculateIndependentFundingProgress(fundingRows(fundedCount), 128_400, expected)
    expect(result).toMatchObject({
      fundedCents,
      remainingCents,
      fundedParticipants: fundedCount,
      participantCount: 4,
      unpaidParticipants: 4 - fundedCount,
      fullyVerified: false,
      fundingStatus: 'partially_funded',
    })
  })

  it('does not count approval, simulated funding, or an unverified capture as merchant funding', () => {
    const rows = fundingRows(1).map((row, index) => ({ ...row, status: ['paid_verified', 'approved', 'capturing', 'failed'][index]!, capturedCents: index === 0 ? row.capturedCents : null }))
    const result = calculateIndependentFundingProgress(rows, 128_400, expected)
    expect(result).toMatchObject({ fundedCents: 35_000, remainingCents: 93_400, fundedParticipants: 1, fullyVerified: false })
  })
  it('does not count a pending or completed refund as available funding', () => {
    const rows = fundingRows(4).map((row, index) => ({ ...row, status: ['paid_verified', 'refund_pending', 'refunded', 'failed'][index]! }))
    const result = calculateIndependentFundingProgress(rows, 128_400, expected)
    expect(result).toMatchObject({ fundedCents: 35_000, remainingCents: 93_400, fundedParticipants: 1, fullyVerified: false })
  })

  it('does not confirm a booking when captured cents do not equal the group total', () => {
    const rows = fundingRows(4)
    rows[3]!.capturedCents = 28_399
    const result = calculateIndependentFundingProgress(rows, 128_400, expected)
    expect(result.fullyVerified).toBe(false)
    expect(result).toMatchObject({ fundedCents: 98_400, remainingCents: 30_000, fundingStatus: 'needs_review' })
  })

  it('does not count duplicate captures or captures correlated to another session or merchant', () => {
    const duplicate = fundingRows(2)
    duplicate[1]!.providerCaptureId = duplicate[0]!.providerCaptureId
    const duplicateResult = calculateIndependentFundingProgress(duplicate, 128_400, expected)
    expect(duplicateResult).toMatchObject({ fundedCents: 0, fundedParticipants: 0, fundingStatus: 'needs_review' })

    const mismatched = fundingRows(2)
    mismatched[0]!.providerCustomId = 'OTHER-PURCHASE'
    mismatched[1]!.providerPayeeMerchantId = 'OTHER-PAYEE'
    const mismatchedResult = calculateIndependentFundingProgress(mismatched, 128_400, expected)
    expect(mismatchedResult).toMatchObject({ fundedCents: 0, fundedParticipants: 0, fundingStatus: 'needs_review' })
  })

  it('does not count a capture that disagrees with the share allocation or checkout currency', () => {
    const rows = fundingRows(2)
    rows[0]!.allocationCents += 1
    rows[1]!.currency = 'CAD'
    expect(calculateIndependentFundingProgress(rows, 128_400, expected)).toMatchObject({
      fundedCents: 0,
      fundedParticipants: 0,
      fundingStatus: 'needs_review',
    })
  })

  it('checks a specified buyer and records a buyer for an email-free invitation', () => {
    expect(payerIdentityMatches('maya.buyer@example.com', 'MAYA.BUYER@example.com')).toBe(true)
    expect(payerIdentityMatches('maya.buyer@example.com', 'jamie.buyer@example.com')).toBe(false)
    expect(payerIdentityMatches(null, 'maya.buyer@example.com')).toBe(true)
    expect(payerIdentityMatches(null, undefined)).toBe(false)
  })
  it('rejects captures with the wrong amount, currency, status, or payer', () => {
    const commitment = { id: 'COMMITMENT', revision: 1, checkoutSessionId: 'PURCHASE', providerOrderId: 'ORDER', amountCents: 35_000, currency: 'USD', expectedPayerEmail: 'alex@example.com' }
    const capture = { orderId: 'ORDER', status: 'COMPLETED', orderCents: 35_000, currency: 'USD', customId: 'PURCHASE', invoiceId: 'whoosh-COMMITMENT-r1', payeeMerchantId: 'PAYEE', captureId: 'CAPTURE', captureCents: 35_000, captureCurrency: 'USD', captureStatus: 'COMPLETED', payerEmail: 'alex@example.com' }
    expect(capturedShareMatches(commitment, 'PAYEE', capture)).toBe(true)
    expect(capturedShareMatches({ ...commitment, expectedPayerEmail: null }, 'PAYEE', capture)).toBe(true)
    expect(capturedShareMatches({ ...commitment, expectedPayerEmail: null }, 'PAYEE', { ...capture, payerEmail: undefined })).toBe(false)
    expect(capturedShareMatches(commitment, 'PAYEE', { ...capture, captureCents: 34_999 })).toBe(false)
    expect(capturedShareMatches(commitment, 'PAYEE', { ...capture, captureCurrency: 'CAD' })).toBe(false)
    expect(capturedShareMatches(commitment, 'PAYEE', { ...capture, captureStatus: 'PENDING' })).toBe(false)
    expect(capturedShareMatches(commitment, 'PAYEE', { ...capture, payerEmail: 'other@example.com' })).toBe(false)
    expect(capturedShareMatches(commitment, 'OTHER', capture)).toBe(false)
    expect(capturedShareMatches(commitment, 'PAYEE', { ...capture, customId: 'OTHER' })).toBe(false)
    expect(capturedShareMatches(commitment, 'PAYEE', { ...capture, invoiceId: 'OTHER' })).toBe(false)
    expect(capturedShareMatches(commitment, 'PAYEE', { ...capture, orderId: 'OTHER' })).toBe(false)
  })
  it('only treats a verified full refund as matching the original capture', () => {
    const refund = { amountCents: 35_000, currency: 'USD' }
    expect(refundMatchesCapture({ capturedCents: 35_000, currency: 'USD' }, refund)).toBe(true)
    expect(refundMatchesCapture({ capturedCents: null, currency: 'USD' }, refund)).toBe(false)
    expect(refundMatchesCapture({ capturedCents: 35_001, currency: 'USD' }, refund)).toBe(false)
    expect(refundMatchesCapture({ capturedCents: 35_000, currency: 'CAD' }, refund)).toBe(false)
  })
})
