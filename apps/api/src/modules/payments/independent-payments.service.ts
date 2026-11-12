import { and, eq, inArray, ne, sql } from 'drizzle-orm'

import { db } from '../../db/client.js'
import {
  checkoutSessions,
  events,
  groupPurchases,
  groupMembers,
  fundingReadyNotifications,
  ledgerAccounts,
  northlineBookings,
  northlineBookingEvents,
  paymentCommitmentEvents,
  paymentCommitments,
  participantFunding,
  users,
  type paymentCommitmentStatus,
} from '../../db/schema/index.js'
import { postJournalInTransaction } from '../ledger/ledger.service.js'
import { assertCheckoutReady } from '../groups/persistent-groups.service.js'
import { PayPalOrdersError, type PayPalOrderGateway, type VerifiedOrder } from './paypal-orders.service.js'

type CommitmentStatus = (typeof paymentCommitmentStatus.enumValues)[number]
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function lockSession(tx: Tx, sessionId: string) {
  // shortcut: provider calls hold this checkout lock, use a durable outbox before production traffic.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`checkout:${sessionId}`}))`)
}

const activeCommitmentStatuses: CommitmentStatus[] = [
  'ready_to_pay', 'order_created', 'approved', 'capturing', 'paid_verified',
  'failed', 'cancelled', 'refund_pending', 'refunded',
]

export function payerIdentityMatches(expected: string | null, actual: string | undefined) {
  // shortcut: an invitation binds the share, not the person's identity; require a recorded PayPal payer until account linking exists.
  return Boolean(actual && (!expected || expected.trim().toLowerCase() === actual.trim().toLowerCase()))
}

export function providerOrderMatches(commitment: { id: string; revision: number; checkoutSessionId: string; providerOrderId: string | null; amountCents: number; currency: string }, expectedPayeeMerchantId: string | null, provider: VerifiedOrder) {
  return Boolean(expectedPayeeMerchantId && provider.orderId === commitment.providerOrderId && provider.customId === commitment.checkoutSessionId && provider.invoiceId === `whoosh-${commitment.id}-r${commitment.revision}` && provider.payeeMerchantId === expectedPayeeMerchantId && provider.orderCents === commitment.amountCents && provider.currency === commitment.currency)
}

export function capturedShareMatches(commitment: { id: string; revision: number; checkoutSessionId: string; providerOrderId: string | null; amountCents: number; currency: string; expectedPayerEmail: string | null }, expectedPayeeMerchantId: string | null, provider: VerifiedOrder) {
  return providerOrderMatches(commitment, expectedPayeeMerchantId, provider) && provider.captureCents === commitment.amountCents && provider.captureCurrency === commitment.currency && provider.captureStatus === 'COMPLETED' && payerIdentityMatches(commitment.expectedPayerEmail, provider.payerEmail)
}

export function refundMatchesCapture(commitment: { capturedCents: number | null; currency: string }, refund: { amountCents: number; currency: string }) {
  return commitment.capturedCents !== null && refund.amountCents === commitment.capturedCents && refund.currency === commitment.currency
}

async function addCommitmentEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  commitmentId: string,
  eventType: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  await tx.insert(paymentCommitmentEvents).values({ commitmentId, eventType, idempotencyKey, payload }).onConflictDoNothing()
}

export async function ensureIndependentPaymentCommitments(sessionId: string) {
  return db.transaction(async (tx) => {
    await lockSession(tx, sessionId)
    const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, sessionId)).limit(1)
    if (!session) throw new TypeError('Checkout session not found')
    if (session.status === 'completed') throw new TypeError('This booking is already complete')

    const funding = await tx.select().from(participantFunding).where(eq(participantFunding.checkoutSessionId, sessionId))
    if (funding.length === 0 || funding.some((row) => row.consentStatus !== 'consented')) {
      throw new TypeError('Every group member must consent before independent checkout can begin')
    }
    const total = funding.reduce((sum, row) => sum + row.allocationCents, 0)
    if (total !== session.totalCents) throw new TypeError('Allocated shares do not reconcile to the merchant total')
    assertCheckoutReady({ ...session, funding })

    if (session.merchantId === 'northline-simulator' && session.merchantOrderId) {
      const [booking] = await tx.insert(northlineBookings).values({ checkoutSessionId: session.id, merchantOrderId: session.merchantOrderId, totalCents: session.totalCents, currency: session.currency, expectedPayeeMerchantId: session.expectedPayeeMerchantId, expiresAt: session.expiresAt }).onConflictDoNothing().returning()
      if (booking) await tx.insert(northlineBookingEvents).values({ bookingId: booking.id, eventType: 'booking.created', idempotencyKey: `booking-created:${booking.id}`, payload: { checkoutSessionId: session.id } })
    }

    for (const row of funding) {
      const [existing] = await tx.select().from(paymentCommitments).where(and(
        eq(paymentCommitments.checkoutSessionId, sessionId),
        eq(paymentCommitments.memberId, row.memberId),
        inArray(paymentCommitments.status, activeCommitmentStatuses),
      )).limit(1)
      if (existing) continue
      const [commitment] = await tx.insert(paymentCommitments).values({
        checkoutSessionId: sessionId,
        memberId: row.memberId,
        amountCents: row.allocationCents,
        currency: session.currency,
        status: 'ready_to_pay',
      }).returning()
      if (!commitment) throw new Error('Could not create a payment commitment')
      await addCommitmentEvent(tx, commitment.id, 'commitment.created', `commitment-created:${commitment.id}`, { amountCents: commitment.amountCents, provider: 'paypal' })
    }

    if (session.paymentMode !== 'independent_paypal') await tx.update(checkoutSessions).set({
      paymentMode: 'independent_paypal', bookingStatus: 'awaiting_payments', status: 'authorized_unpaid', updatedAt: new Date(),
    }).where(eq(checkoutSessions.id, sessionId))
    return getIndependentPaymentCheckout(sessionId, tx)
  })
}

export async function getIndependentPaymentCheckout(
  sessionId: string,
  query: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
) {
  const [session] = await query.select().from(checkoutSessions).where(eq(checkoutSessions.id, sessionId)).limit(1)
  if (!session) throw new TypeError('Checkout session not found')
  const commitments = await query.select({
    id: paymentCommitments.id,
    memberId: paymentCommitments.memberId,
    revision: paymentCommitments.revision,
    amountCents: paymentCommitments.amountCents,
    capturedCents: paymentCommitments.capturedCents,
    currency: paymentCommitments.currency,
    status: paymentCommitments.status,
    expectedPayerEmail: paymentCommitments.expectedPayerEmail,
    payerEmail: paymentCommitments.payerEmail,
    providerOrderId: paymentCommitments.providerOrderId,
    providerCaptureId: paymentCommitments.providerCaptureId,
    providerRefundId: paymentCommitments.providerRefundId,
    refundedCents: paymentCommitments.refundedCents,
    approvalUrl: paymentCommitments.approvalUrl,
    providerCustomId: paymentCommitments.providerCustomId,
    providerPayeeMerchantId: paymentCommitments.providerPayeeMerchantId,
    allocationCents: participantFunding.allocationCents,
    failureCode: paymentCommitments.failureCode,
    failureMessage: paymentCommitments.failureMessage,
    name: users.displayName,
  }).from(paymentCommitments)
    .innerJoin(participantFunding, and(eq(paymentCommitments.checkoutSessionId, participantFunding.checkoutSessionId), eq(paymentCommitments.memberId, participantFunding.memberId)))
    .innerJoin(groupMembers, eq(paymentCommitments.memberId, groupMembers.id))
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(eq(paymentCommitments.checkoutSessionId, sessionId))
    .orderBy(sql`CASE WHEN ${groupMembers.role} = 'host' THEN 0 ELSE 1 END`, groupMembers.joinedAt, groupMembers.id)
  const funding = await query.select({ memberId: participantFunding.memberId }).from(participantFunding).where(eq(participantFunding.checkoutSessionId, sessionId))
  const progress = calculateIndependentFundingProgress(commitments, session.totalCents, {
    sessionId: session.id,
    expectedPayeeMerchantId: session.expectedPayeeMerchantId,
    currency: session.currency,
    participantCount: funding.length,
  })
  const [merchantBooking] = await query.select().from(northlineBookings).where(eq(northlineBookings.checkoutSessionId, sessionId)).limit(1)
  return { session, commitments, merchantBooking: merchantBooking ?? null, ...progress }
}

/** Pure reconciliation boundary: only provider-verified captures count as funding. */
export function calculateIndependentFundingProgress(
  commitments: Array<{
    memberId: string
    status: string
    amountCents: number
    capturedCents: number | null
    currency: string
    allocationCents: number
    providerOrderId: string | null
    providerCaptureId: string | null
    providerCustomId: string | null
    providerPayeeMerchantId: string | null
  }>,
  totalCents: number,
  expected: { sessionId: string; expectedPayeeMerchantId: string | null; currency: string; participantCount: number },
) {
  const active = commitments.filter((row) => row.status !== 'superseded')
  const captures = new Map<string, number>()
  const members = new Map<string, number>()
  for (const row of active) {
    members.set(row.memberId, (members.get(row.memberId) ?? 0) + 1)
    if (row.providerCaptureId) captures.set(row.providerCaptureId, (captures.get(row.providerCaptureId) ?? 0) + 1)
  }
  const verified = active.filter((row) =>
    row.status === 'paid_verified'
    && Boolean(row.providerCaptureId && row.providerOrderId)
    && row.providerCaptureId !== null
    && captures.get(row.providerCaptureId) === 1
    && members.get(row.memberId) === 1
    && row.providerCustomId === expected.sessionId
    && Boolean(expected.expectedPayeeMerchantId && row.providerPayeeMerchantId === expected.expectedPayeeMerchantId)
    && row.currency === expected.currency
    && row.amountCents === row.allocationCents
    && row.capturedCents !== null
    && row.capturedCents === row.amountCents,
  )
  const fundedCents = verified.reduce((sum, row) => sum + (row.capturedCents ?? 0), 0)
  const fundedParticipants = new Set(verified.map((row) => row.memberId)).size
  const needsReview = active.some((row) =>
    (row.status === 'paid_verified' && !verified.includes(row))
    || row.amountCents !== row.allocationCents
    || row.currency !== expected.currency
    || members.get(row.memberId) !== 1,
  )
  const fullyVerified = expected.participantCount > 0
    && fundedParticipants === expected.participantCount
    && active.length === expected.participantCount
    && fundedCents === totalCents
  return {
    fundedCents,
    remainingCents: Math.max(0, totalCents - fundedCents),
    fundedParticipants,
    participantCount: expected.participantCount,
    unpaidParticipants: Math.max(0, expected.participantCount - fundedParticipants),
    fullyVerified,
    fundingStatus: needsReview ? 'needs_review' as const : fullyVerified ? 'fully_funded' as const : fundedCents > 0 ? 'partially_funded' as const : 'awaiting_payments' as const,
  }
}

export async function createIndependentPayPalOrder(input: {
  sessionId: string; commitmentId: string; expectedPayerEmail?: string; returnUrl: string; cancelUrl: string; gateway: PayPalOrderGateway
}) {
  return db.transaction(async (tx) => {
    await lockSession(tx, input.sessionId)
    const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, input.sessionId)).limit(1)
    if (!session || session.status !== 'authorized_unpaid' || session.paymentMode !== 'independent_paypal' || ['recovery_required', 'refund_pending', 'refunded', 'merchant_booking_pending', 'confirmed_simulated'].includes(session.bookingStatus)) throw new TypeError('This checkout is not accepting new PayPal orders')
    if (!session.expectedPayeeMerchantId) throw new TypeError('The Northline PayPal merchant ID must be configured before independent checkout')
    if (session.expiresAt && session.expiresAt <= new Date()) throw new TypeError('This Northline booking has expired')
    let [commitment] = await tx.select().from(paymentCommitments).where(and(eq(paymentCommitments.id, input.commitmentId), eq(paymentCommitments.checkoutSessionId, input.sessionId))).limit(1)
    if (!commitment) throw new TypeError('Payment commitment not found')
    if (commitment.status === 'paid_verified') return { ...commitment, approvalUrl: null }
    if (!['ready_to_pay', 'failed', 'cancelled', 'order_created'].includes(commitment.status)) throw new TypeError('This payment commitment cannot be opened for checkout')
    if (commitment.currency !== 'USD') throw new TypeError('PayPal Sandbox checkout requires USD')
    if (commitment.providerOrderId) {
      const provider = await input.gateway.getOrder(commitment.providerOrderId)
      if (provider.status === 'UNAVAILABLE') throw new TypeError('PayPal Sandbox is unavailable; the existing order cannot be checked safely')
      if (provider.status === 'COMPLETED' || provider.captureId) {
        await settleProviderCapture(tx, commitment, provider)
        const [reconciled] = await tx.select().from(paymentCommitments).where(eq(paymentCommitments.id, commitment.id)).limit(1)
        return { ...reconciled!, approvalUrl: null }
      }
      if (commitment.status === 'order_created' && commitment.approvalUrl) return commitment
    }
    if (['failed', 'cancelled'].includes(commitment.status)) {
      const [restarted] = await tx.update(paymentCommitments).set({ revision: commitment.revision + 1, providerOrderId: null, approvalUrl: null, createRequestId: `whoosh-commitment-${commitment.id}-revision-${commitment.revision + 1}`, captureRequestId: null, status: 'ready_to_pay', updatedAt: new Date() }).where(eq(paymentCommitments.id, commitment.id)).returning()
      if (!restarted) throw new Error('Could not restart this payment attempt')
      commitment = restarted
    }
    const requestId = commitment.createRequestId ?? `whoosh-commitment-${commitment.id}`
    const invoiceId = `whoosh-${commitment.id}-r${commitment.revision}`
    const order = await input.gateway.createOrder({ totalCents: commitment.amountCents, currency: 'USD', reference: requestId, customId: input.sessionId, invoiceId, returnUrl: input.returnUrl, cancelUrl: input.cancelUrl })
    if (order.mode === 'mock') return { ...commitment, providerOrderId: order.orderId, approvalUrl: undefined, status: 'ready_to_pay' as const }
    const [updated] = await tx.update(paymentCommitments).set({
      expectedPayerEmail: input.expectedPayerEmail?.trim().toLowerCase() ?? null,
      providerOrderId: order.orderId,
      providerCustomId: input.sessionId,
      providerInvoiceId: invoiceId,
      approvalUrl: order.approvalUrl,
      createRequestId: requestId,
      status: 'order_created',
      failureCode: null,
      failureMessage: null,
      updatedAt: new Date(),
    }).where(eq(paymentCommitments.id, commitment.id)).returning()
    if (!updated) throw new Error('Could not save the PayPal order')
    await addCommitmentEvent(tx, updated.id, 'paypal.order.created', `paypal-order:${updated.id}:${requestId}`, { orderId: order.orderId, amountCents: updated.amountCents })
    return updated
  })
}

export async function captureIndependentPayPalOrder(input: {
  sessionId: string; commitmentId: string; orderId: string; gateway: PayPalOrderGateway
}) {
  return db.transaction(async (tx) => {
    await lockSession(tx, input.sessionId)
    const [commitment] = await tx.select().from(paymentCommitments).where(and(eq(paymentCommitments.id, input.commitmentId), eq(paymentCommitments.checkoutSessionId, input.sessionId))).limit(1)
    if (!commitment) throw new TypeError('Payment commitment not found')
    if (commitment.providerOrderId !== input.orderId) throw new TypeError('This PayPal order is not associated with the selected participant')
    if (commitment.status === 'paid_verified') return getIndependentPaymentCheckout(input.sessionId, tx)
    if (['refund_pending', 'refunded', 'superseded'].includes(commitment.status)) throw new TypeError('This payment is in recovery and cannot be captured')
    const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, input.sessionId)).limit(1)
    if (!session || ['recovery_required', 'refund_pending', 'refunded', 'merchant_booking_pending', 'confirmed_simulated'].includes(session.bookingStatus)) throw new TypeError('This checkout is not accepting payments')

    let provider = await input.gateway.getOrder(input.orderId)
    if (provider.status === 'UNAVAILABLE') throw new TypeError('PayPal Sandbox is not configured. No participant payment was captured.')
    if (provider.captureId || provider.status === 'COMPLETED') return settleProviderCapture(tx, commitment, provider)
    if (session.expiresAt && session.expiresAt <= new Date()) throw new TypeError('This Northline booking expired before capture; no new payment was started')
    if (!providerOrderMatches(commitment, session.expectedPayeeMerchantId, provider)) throw new TypeError('The PayPal order purchase, invoice, payee, amount, or currency does not match this share')
    if (!payerIdentityMatches(commitment.expectedPayerEmail, provider.payerEmail)) throw new TypeError('The PayPal buyer does not match the participant email for this payment link')
    if (provider.status !== 'APPROVED') throw new TypeError('PayPal approval is still required before WHOOSH can capture this share.')

    try {
      provider = await input.gateway.captureOrder(input.orderId, `whoosh-capture-${commitment.id}`)
      // Read the canonical order: capture responses can omit purchase-unit correlation fields.
      provider = await input.gateway.getOrder(input.orderId)
    } catch (error) {
      // A timeout can occur after PayPal captured. Read provider state before deciding anything.
      provider = await input.gateway.getOrder(input.orderId)
      if (!provider.captureId && provider.status !== 'COMPLETED') {
        if (error instanceof PayPalOrdersError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
          await markCommitmentFailed(tx, commitment.id, error.code ?? 'CAPTURE_DECLINED', error.message)
          return getIndependentPaymentCheckout(input.sessionId, tx)
        }
        throw new TypeError('PayPal capture outcome is uncertain. Retry confirmation of the same order; no new charge was started.', { cause: error })
      }
    }
    return settleProviderCapture(tx, commitment, provider)
  })
}

export async function cancelIndependentPaymentCommitment(sessionId: string, commitmentId: string, gateway: PayPalOrderGateway) {
  return db.transaction(async (tx) => {
    await lockSession(tx, sessionId)
    const [commitment] = await tx.select().from(paymentCommitments).where(and(eq(paymentCommitments.id, commitmentId), eq(paymentCommitments.checkoutSessionId, sessionId))).limit(1)
    if (!commitment) throw new TypeError('Payment commitment not found')
    if (commitment.status === 'paid_verified') throw new TypeError('A captured payment cannot be cancelled. Request a refund instead.')
    if (['refund_pending', 'refunded'].includes(commitment.status)) return getIndependentPaymentCheckout(sessionId, tx)
    if (commitment.providerOrderId) {
      const provider = await gateway.getOrder(commitment.providerOrderId)
      if (provider.status === 'UNAVAILABLE') throw new TypeError('PayPal Sandbox is unavailable; the order cannot be checked before cancellation')
      if (provider.captureId || provider.status === 'COMPLETED') return settleProviderCapture(tx, commitment, provider)
    }
    await tx.update(paymentCommitments).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(paymentCommitments.id, commitment.id))
    await addCommitmentEvent(tx, commitment.id, 'participant.cancelled', `commitment-cancelled:${commitment.id}`, {})
    return getIndependentPaymentCheckout(sessionId, tx)
  })
}

async function markCommitmentFailed(tx: Tx, commitmentId: string, code: string, message: string) {
  await tx.update(paymentCommitments).set({ status: 'failed', failureCode: code, failureMessage: message, updatedAt: new Date() }).where(eq(paymentCommitments.id, commitmentId))
  await addCommitmentEvent(tx, commitmentId, 'payment.failed', `payment-failed:${commitmentId}:${code}`, { code, message })
}

async function settleProviderCapture(tx: Tx, commitment: typeof paymentCommitments.$inferSelect, provider: VerifiedOrder) {
  if (!provider.captureId || provider.captureStatus !== 'COMPLETED') throw new TypeError('PayPal has not verified a completed capture for this share')
  const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, commitment.checkoutSessionId)).limit(1)
  if (!capturedShareMatches(commitment, session?.expectedPayeeMerchantId ?? null, provider)) {
    await tx.update(paymentCommitments).set({ providerCaptureId: provider.captureId, capturedCents: provider.captureCents, payerEmail: provider.payerEmail, providerPayeeMerchantId: provider.payeeMerchantId, status: 'refund_pending', failureCode: 'CAPTURE_MISMATCH', failureMessage: 'Captured purchase, payee, amount, currency, or payer did not match the commitment', updatedAt: new Date() }).where(eq(paymentCommitments.id, commitment.id))
    await tx.update(checkoutSessions).set({ bookingStatus: 'recovery_required', updatedAt: new Date() }).where(eq(checkoutSessions.id, commitment.checkoutSessionId))
    await addCommitmentEvent(tx, commitment.id, 'paypal.capture.quarantined', `paypal-capture-quarantined:${provider.captureId}`, { orderId: provider.orderId, captureId: provider.captureId, capturedCents: provider.captureCents, currency: provider.captureCurrency, customId: provider.customId, invoiceId: provider.invoiceId, payeeMerchantId: provider.payeeMerchantId })
    return getIndependentPaymentCheckout(commitment.checkoutSessionId, tx)
  }
  if (provider.captureCents === undefined) throw new TypeError('PayPal capture amount is missing')
  return recordIndependentCapture(tx, { sessionId: commitment.checkoutSessionId, commitmentId: commitment.id, orderId: provider.orderId, captureId: provider.captureId, captureCents: provider.captureCents, payerEmail: provider.payerEmail, customId: provider.customId!, invoiceId: provider.invoiceId!, payeeMerchantId: provider.payeeMerchantId! })
}

async function recordIndependentCapture(tx: Tx, input: { sessionId: string; commitmentId: string; orderId: string; captureId: string; captureCents: number; payerEmail?: string; customId: string; invoiceId: string; payeeMerchantId: string }) {
    const [commitment] = await tx.select().from(paymentCommitments).where(and(eq(paymentCommitments.id, input.commitmentId), eq(paymentCommitments.checkoutSessionId, input.sessionId))).limit(1)
    if (!commitment) throw new TypeError('Payment commitment not found')
    if (commitment.status === 'paid_verified' && commitment.providerCaptureId === input.captureId) return getIndependentPaymentCheckout(input.sessionId, tx)
    if (input.captureCents !== commitment.amountCents) throw new TypeError('The captured PayPal amount does not match this participant commitment')
    if (!payerIdentityMatches(commitment.expectedPayerEmail, input.payerEmail)) throw new TypeError('The captured PayPal payer does not match the assigned participant')
    const [capturedElsewhere] = await tx.select({ id: paymentCommitments.id }).from(paymentCommitments).where(eq(paymentCommitments.providerCaptureId, input.captureId)).limit(1)
    if (capturedElsewhere && capturedElsewhere.id !== commitment.id) throw new TypeError('This PayPal capture is already assigned to another commitment')

    await tx.update(paymentCommitments).set({
      providerOrderId: input.orderId,
      providerCaptureId: input.captureId,
      capturedCents: input.captureCents,
      payerEmail: input.payerEmail?.trim().toLowerCase(),
      providerCustomId: input.customId,
      providerInvoiceId: input.invoiceId,
      providerPayeeMerchantId: input.payeeMerchantId,
      status: 'paid_verified',
      captureRequestId: `whoosh-capture-${commitment.id}`,
      updatedAt: new Date(),
    }).where(eq(paymentCommitments.id, commitment.id))
    await tx.update(participantFunding).set({ fundingStatus: 'verified' }).where(and(eq(participantFunding.checkoutSessionId, input.sessionId), eq(participantFunding.memberId, commitment.memberId)))
    await addCommitmentEvent(tx, commitment.id, 'paypal.capture.verified', `paypal-capture:${input.captureId}`, { orderId: input.orderId, captureId: input.captureId, capturedCents: input.captureCents })

    const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, input.sessionId)).limit(1)
    if (!session) throw new TypeError('Checkout session not found')
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ledger-accounts:${session.groupId}`}))`)
    const currentAccounts = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.groupId, session.groupId))
    let expense = currentAccounts.find((account) => account.groupMemberId === commitment.memberId && account.type === 'member_expense' && account.currency === session.currency)
    let merchantClearing = currentAccounts.find((account) => account.type === 'merchant_clearing' && account.currency === session.currency)
    if (!expense) {
      const [created] = await tx.insert(ledgerAccounts).values({ groupId: session.groupId, groupMemberId: commitment.memberId, type: 'member_expense', normalBalance: 'debit', currency: session.currency }).returning()
      expense = created
    }
    if (!merchantClearing) {
      const [created] = await tx.insert(ledgerAccounts).values({ groupId: session.groupId, type: 'merchant_clearing', normalBalance: 'credit', currency: session.currency }).returning()
      merchantClearing = created
    }
    if (!expense || !merchantClearing) throw new TypeError('Required group ledger accounts are missing')
    const ledgerCurrency = session.currency === 'USD' ? 'USD' as const : 'CAD' as const
    await postJournalInTransaction(tx, {
      groupId: session.groupId,
      description: `Verified PayPal share for commitment ${commitment.id}`,
      idempotencyKey: `paypal-capture:${input.captureId}`,
      entries: [
        { accountId: expense.id, direction: 'debit', amountCents: input.captureCents, currency: ledgerCurrency },
        { accountId: merchantClearing.id, direction: 'credit', amountCents: input.captureCents, currency: ledgerCurrency },
      ],
    })

    const progress = await getIndependentPaymentCheckout(input.sessionId, tx)
    if (progress.fullyVerified) {
      await tx.update(checkoutSessions).set({ merchantPaymentStatus: 'capture_verified', bookingStatus: 'merchant_booking_pending', updatedAt: new Date() }).where(eq(checkoutSessions.id, input.sessionId))
      await tx.insert(fundingReadyNotifications).values({ checkoutSessionId: input.sessionId }).onConflictDoNothing()
    } else {
      await tx.update(checkoutSessions).set({ bookingStatus: 'partially_paid', updatedAt: new Date() }).where(eq(checkoutSessions.id, input.sessionId))
    }
    return getIndependentPaymentCheckout(input.sessionId, tx)
}

export async function confirmSimulatedNorthlineBooking(sessionId: string) {
  return db.transaction(async (tx) => {
    await lockSession(tx, sessionId)
    const checkout = await getIndependentPaymentCheckout(sessionId, tx)
    const booking = checkout.merchantBooking
    if (!booking || booking.merchantOrderId !== checkout.session.merchantOrderId) throw new TypeError('Northline booking is not linked to this purchase')
    if (booking.status === 'confirmed') {
      if (checkout.session.bookingStatus !== 'confirmed_simulated') {
        await verifyMerchantFunding(tx, checkout.session, booking)
        const [notification] = await tx.select().from(fundingReadyNotifications).where(eq(fundingReadyNotifications.checkoutSessionId, sessionId)).limit(1)
        if (!notification) throw new TypeError('Northline funding notification is missing')
        await tx.update(fundingReadyNotifications).set({ status: 'delivered', deliveredAt: new Date() }).where(eq(fundingReadyNotifications.id, notification.id))
        await tx.insert(northlineBookingEvents).values({ bookingId: booking.id, eventType: 'booking.confirmed', idempotencyKey: `booking-confirmed:${booking.id}`, payload: { checkoutSessionId: sessionId, totalCents: booking.totalCents } }).onConflictDoNothing()
        await acknowledgeMerchantBooking(tx, sessionId, checkout.session.groupId, checkout.session.merchant, checkout.session.totalCents, checkout.session.currency)
      }
      return getIndependentPaymentCheckout(sessionId, tx)
    }
    if (booking.status === 'rejected' || booking.status === 'expired' || booking.status === 'cancelled') throw new TypeError(`Northline booking is ${booking.status}`)
    if (booking.expiresAt && booking.expiresAt <= new Date()) {
      await tx.update(northlineBookings).set({ status: 'expired', updatedAt: new Date() }).where(eq(northlineBookings.id, booking.id))
      await tx.insert(northlineBookingEvents).values({ bookingId: booking.id, eventType: 'booking.expired', idempotencyKey: `booking-expired:${booking.id}`, payload: {} }).onConflictDoNothing()
      return getIndependentPaymentCheckout(sessionId, tx)
    }
    await verifyMerchantFunding(tx, checkout.session, booking)
    const [notification] = await tx.select().from(fundingReadyNotifications).where(eq(fundingReadyNotifications.checkoutSessionId, sessionId)).limit(1)
    if (!notification) throw new TypeError('Northline has not received a durable funding-ready record')
    await tx.update(northlineBookings).set({ status: 'confirmed', confirmedAt: new Date(), updatedAt: new Date(), failureReason: null }).where(eq(northlineBookings.id, booking.id))
    await tx.insert(northlineBookingEvents).values({ bookingId: booking.id, eventType: 'booking.confirmed', idempotencyKey: `booking-confirmed:${booking.id}`, payload: { checkoutSessionId: sessionId, totalCents: booking.totalCents } }).onConflictDoNothing()
    await tx.update(fundingReadyNotifications).set({ status: 'delivered', deliveredAt: new Date() }).where(eq(fundingReadyNotifications.id, notification.id))
    await acknowledgeMerchantBooking(tx, sessionId, checkout.session.groupId, checkout.session.merchant, checkout.session.totalCents, checkout.session.currency)
    return getIndependentPaymentCheckout(sessionId, tx)
  })
}

async function verifyMerchantFunding(tx: Tx, session: typeof checkoutSessions.$inferSelect, booking: typeof northlineBookings.$inferSelect) {
  if (session.merchantId !== 'northline-simulator' || session.merchantOrderId !== booking.merchantOrderId || session.paymentMode !== 'independent_paypal' || session.bookingStatus !== 'merchant_booking_pending' || session.status !== 'authorized_unpaid') throw new TypeError('Northline cannot confirm a checkout outside merchant booking pending')
  if (!session.expectedPayeeMerchantId || booking.expectedPayeeMerchantId !== session.expectedPayeeMerchantId || booking.totalCents !== session.totalCents || booking.currency !== session.currency) throw new TypeError('Northline booking does not match the checkout merchant, amount, or currency')
  const funding = await tx.select().from(participantFunding).where(eq(participantFunding.checkoutSessionId, session.id))
  const commitments = await tx.select().from(paymentCommitments).where(and(eq(paymentCommitments.checkoutSessionId, session.id), ne(paymentCommitments.status, 'superseded')))
  const members = new Set(funding.map((row) => row.memberId))
  if (funding.length !== 4 || commitments.length !== funding.length || commitments.some((row) => !members.has(row.memberId)) || new Set(commitments.map((row) => row.memberId)).size !== funding.length) throw new TypeError('Northline requires four distinct participant commitments')
  if (funding.some((row) => row.consentStatus !== 'consented' || row.fundingStatus !== 'verified')) throw new TypeError('Northline requires consent and verified funding for every participant')
  if (commitments.some((row) => row.status !== 'paid_verified' || !row.providerCaptureId || !row.providerOrderId || row.providerCustomId !== session.id || row.providerInvoiceId !== `whoosh-${row.id}-r${row.revision}` || row.providerPayeeMerchantId !== session.expectedPayeeMerchantId || !payerIdentityMatches(row.expectedPayerEmail, row.payerEmail ?? undefined) || row.currency !== session.currency || row.capturedCents !== row.amountCents || row.amountCents !== funding.find((funded) => funded.memberId === row.memberId)?.allocationCents)) throw new TypeError('Northline could not verify every PayPal capture against this purchase')
  if (commitments.reduce((sum, row) => sum + (row.capturedCents ?? 0), 0) !== booking.totalCents || new Set(commitments.map((row) => row.providerCaptureId)).size !== commitments.length) throw new TypeError('Northline captured shares do not reconcile to the booking total')
}

async function acknowledgeMerchantBooking(tx: Tx, sessionId: string, groupId: string, merchant: string, totalCents: number, currency: string) {
  await tx.insert(groupPurchases).values({ groupId, checkoutSessionId: sessionId, merchant, title: 'Montreal Weekend Escape (simulated booking)', totalCents, currency, isDemoData: true }).onConflictDoNothing()
  await tx.update(checkoutSessions).set({ status: 'completed', bookingStatus: 'confirmed_simulated', updatedAt: new Date() }).where(eq(checkoutSessions.id, sessionId))
}

export async function rejectSimulatedNorthlineBooking(sessionId: string, reason: string) {
  return db.transaction(async (tx) => {
    await lockSession(tx, sessionId)
    const [booking] = await tx.select().from(northlineBookings).where(eq(northlineBookings.checkoutSessionId, sessionId)).limit(1)
    if (!booking || booking.status === 'confirmed') throw new TypeError('This Northline booking cannot be rejected')
    await tx.update(northlineBookings).set({ status: 'rejected', failureReason: reason.slice(0, 200), updatedAt: new Date() }).where(eq(northlineBookings.id, booking.id))
    await tx.insert(northlineBookingEvents).values({ bookingId: booking.id, eventType: 'booking.rejected', idempotencyKey: `booking-rejected:${booking.id}`, payload: { reason: reason.slice(0, 200) } }).onConflictDoNothing()
    return getIndependentPaymentCheckout(sessionId, tx)
  })
}

export async function cancelAndRefundIndependentCheckout(sessionId: string, gateway: PayPalOrderGateway) {
  return db.transaction(async (tx) => {
    await lockSession(tx, sessionId)
    const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, sessionId)).limit(1)
    if (!session || session.paymentMode !== 'independent_paypal') throw new TypeError('Independent checkout not found')
    if (session.bookingStatus === 'confirmed_simulated') throw new TypeError('The demo booking is already acknowledged; cancel it before refunding')
    const pending = await tx.select().from(paymentCommitments).where(and(eq(paymentCommitments.checkoutSessionId, sessionId), ne(paymentCommitments.status, 'superseded')))
    for (const commitment of pending) {
      if (!commitment.providerCaptureId && commitment.providerOrderId) {
        const provider = await gateway.getOrder(commitment.providerOrderId)
        if (provider.status === 'UNAVAILABLE') throw new TypeError('PayPal Sandbox is unavailable; payment state cannot be checked before cancellation')
        if (provider.captureId || provider.status === 'COMPLETED') await settleProviderCapture(tx, commitment, provider)
      }
    }
    const commitments = await tx.select().from(paymentCommitments).where(and(eq(paymentCommitments.checkoutSessionId, sessionId), ne(paymentCommitments.status, 'superseded')))
    await tx.update(checkoutSessions).set({ bookingStatus: 'recovery_required', updatedAt: new Date() }).where(eq(checkoutSessions.id, sessionId))
    for (const commitment of commitments) {
      if (commitment.status === 'refunded') continue
      if (!commitment.providerCaptureId) {
        await tx.update(paymentCommitments).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(paymentCommitments.id, commitment.id))
        continue
      }
      const requestId = commitment.refundRequestId ?? `whoosh-refund-${commitment.id}`
      let refund: { refundId: string; status: string; amountCents: number; currency: string }
      try {
        refund = commitment.providerRefundId ? await gateway.getRefund(commitment.providerRefundId) : await gateway.refundCapture(commitment.providerCaptureId, requestId)
      } catch (error) {
        await tx.update(paymentCommitments).set({ status: 'refund_pending', refundRequestId: requestId, failureCode: 'REFUND_UNCERTAIN', failureMessage: error instanceof Error ? error.message : 'PayPal refund outcome is uncertain', updatedAt: new Date() }).where(eq(paymentCommitments.id, commitment.id))
        continue
      }
      if (!refundMatchesCapture(commitment, refund)) {
        await tx.update(paymentCommitments).set({ status: 'refund_pending', providerRefundId: refund.refundId, refundRequestId: requestId, failureCode: 'REFUND_MISMATCH', failureMessage: 'PayPal refund amount or currency did not match the capture', updatedAt: new Date() }).where(eq(paymentCommitments.id, commitment.id))
        continue
      }
      await tx.update(paymentCommitments).set({ status: refund.status === 'COMPLETED' ? 'refunded' : 'refund_pending', providerRefundId: refund.refundId, refundRequestId: requestId, refundedCents: refund.status === 'COMPLETED' ? refund.amountCents : null, failureCode: ['COMPLETED', 'PENDING'].includes(refund.status) ? null : 'REFUND_FAILED', failureMessage: ['COMPLETED', 'PENDING'].includes(refund.status) ? null : `PayPal refund status: ${refund.status}`, updatedAt: new Date() }).where(eq(paymentCommitments.id, commitment.id))
      await addCommitmentEvent(tx, commitment.id, `paypal.refund.${refund.status.toLowerCase()}`, `paypal-refund:${refund.refundId}:${refund.status}`, { refundId: refund.refundId, captureId: commitment.providerCaptureId, amountCents: refund.amountCents })
      const [funding] = await tx.select({ fundingStatus: participantFunding.fundingStatus }).from(participantFunding).where(and(eq(participantFunding.checkoutSessionId, sessionId), eq(participantFunding.memberId, commitment.memberId))).limit(1)
      if (refund.status === 'COMPLETED' && funding?.fundingStatus === 'verified') await postRefundJournal(tx, session, commitment, refund.amountCents)
      if (refund.status === 'COMPLETED') await tx.update(participantFunding).set({ fundingStatus: 'refunded' }).where(and(eq(participantFunding.checkoutSessionId, sessionId), eq(participantFunding.memberId, commitment.memberId)))
    }
    const updated = await tx.select().from(paymentCommitments).where(and(eq(paymentCommitments.checkoutSessionId, sessionId), ne(paymentCommitments.status, 'superseded')))
    const done = updated.every((row) => ['refunded', 'cancelled'].includes(row.status))
    await tx.update(checkoutSessions).set({ status: done ? 'cancelled' : session.status, bookingStatus: done ? (updated.some((row) => row.status === 'refunded') ? 'refunded' : 'cancelled') : 'refund_pending', updatedAt: new Date() }).where(eq(checkoutSessions.id, sessionId))
    if (done) {
      const [booking] = await tx.select().from(northlineBookings).where(eq(northlineBookings.checkoutSessionId, sessionId)).limit(1)
      if (booking && booking.status !== 'confirmed') {
        await tx.update(northlineBookings).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(northlineBookings.id, booking.id))
        await tx.insert(northlineBookingEvents).values({ bookingId: booking.id, eventType: 'booking.cancelled', idempotencyKey: `booking-cancelled:${booking.id}`, payload: {} }).onConflictDoNothing()
      }
    }
    return getIndependentPaymentCheckout(sessionId, tx)
  })
}

async function postRefundJournal(tx: Tx, session: typeof checkoutSessions.$inferSelect, commitment: typeof paymentCommitments.$inferSelect, amountCents: number) {
  const accounts = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.groupId, session.groupId))
  const expense = accounts.find((account) => account.groupMemberId === commitment.memberId && account.type === 'member_expense' && account.currency === session.currency)
  const clearing = accounts.find((account) => account.type === 'merchant_clearing' && account.currency === session.currency)
  if (!expense || !clearing) throw new TypeError('Refund ledger accounts are missing')
  const currency = session.currency === 'USD' ? 'USD' as const : 'CAD' as const
  await postJournalInTransaction(tx, { groupId: session.groupId, description: `Refund for commitment ${commitment.id}`, idempotencyKey: `paypal-refund:${commitment.id}`, entries: [
    { accountId: clearing.id, direction: 'debit', amountCents, currency },
    { accountId: expense.id, direction: 'credit', amountCents, currency },
  ] })
}
