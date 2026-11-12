import { beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../../db/client.js'
import { checkoutSessions, fundingReadyNotifications, groupPermissions, ledgerEntries, ledgerJournals, northlineBookings, northlineBookingEvents, participantApprovalTokens, participantFunding, paymentCommitments, purchaseApprovals } from '../../db/schema/index.js'
import { approveOneTime, cancelUnpaidCheckoutDraft, createCheckoutSession, createParticipantApprovalLinks, createPersistentGroup, decideParticipantApproval, getCheckoutSession, getParticipantApproval, getPersistentGroup, listPersistentGroups, recordPayPalOrder, resolveParticipantPaymentToken, saveGroupContactEmail, saveSessionAllocation, withdrawOneTime } from '../groups/persistent-groups.service.js'
import { cancelAndRefundIndependentCheckout, captureIndependentPayPalOrder, confirmSimulatedNorthlineBooking, createIndependentPayPalOrder, ensureIndependentPaymentCommitments, getIndependentPaymentCheckout, rejectSimulatedNorthlineBooking } from './independent-payments.service.js'
import type { PayPalOrderGateway, VerifiedOrder } from './paypal-orders.service.js'
import { allocateReceiptItems, reconcileReceipt } from '@whoosh/shared'
import { createAllocationInterpreter } from '../ai/interpretation.service.js'

const integration = process.env.WHOOSH_DB_INTEGRATION === '1' ? describe.sequential : describe.skip
const shares = [35000, 35000, 30000, 28400]
const emails = ['jamie@example.test', 'alex@example.test', 'jordan@example.test', 'maya@example.test']
const payeeId = 'TESTPAYEE1234'

integration('Saved group contacts', () => {
  it('persists contact corrections without granting purchase consent', async () => {
    const group = await createPersistentGroup({ name: `Contacts ${crypto.randomUUID()}`, members: ['Jamie', { name: 'Alex', email: 'Alex@example.test' }] })
    const alex = group.members.find((member) => member.name === 'Alex')!
    expect(alex.contactEmail).toBe('alex@example.test')
    await saveGroupContactEmail(group.group.id, alex.id, 'new@example.test')
    expect((await getPersistentGroup(group.group.id)).members.find((member) => member.id === alex.id)?.contactEmail).toBe('new@example.test')
  })
})

class FakePayPal implements PayPalOrderGateway {
  orders = new Map<string, VerifiedOrder>()
  refunds = new Map<string, { refundId: string; status: string; amountCents: number; currency: string }>()
  captureCalls = 0
  refundCalls = 0
  refundStatus = 'COMPLETED'
  captureIdOverride?: string
  uncertainCapture = false
  async createOrder(input: { totalCents: number; currency: 'USD'; reference: string; customId?: string; invoiceId?: string }) {
    const orderId = `TEST-ORDER-${crypto.randomUUID()}`
    this.orders.set(orderId, { orderId, status: 'CREATED', orderCents: input.totalCents, currency: input.currency, customId: input.customId, invoiceId: input.invoiceId, payeeMerchantId: payeeId })
    return { orderId, approvalUrl: `https://example.test/${orderId}`, mode: 'sandbox' as const }
  }
  async getOrder(orderId: string) { return { ...this.orders.get(orderId)! } }
  async captureOrder(orderId: string) {
    this.captureCalls++
    if (this.uncertainCapture) throw new Error('Provider connection lost during capture')
    const prior = this.orders.get(orderId)!
    const result = { ...prior, status: 'COMPLETED', captureId: this.captureIdOverride ?? `TEST-CAPTURE-${orderId}`, captureCents: prior.orderCents, captureCurrency: prior.currency, captureStatus: 'COMPLETED', mode: 'sandbox' as const }
    this.orders.set(orderId, result)
    return result
  }
  async refundCapture(captureId: string) {
    this.refundCalls++
    const order = [...this.orders.values()].find((row) => row.captureId === captureId)!
    const result = { refundId: `TEST-REFUND-${captureId}`, status: this.refundStatus, amountCents: order.captureCents!, currency: order.captureCurrency! }
    this.refunds.set(result.refundId, result)
    return result
  }
  async getRefund(refundId: string) { return this.refunds.get(refundId)! }
  approve(orderId: string, email: string) { this.orders.set(orderId, { ...this.orders.get(orderId)!, status: 'APPROVED', payerEmail: email }) }
}

async function fixture(options: { approveLast?: boolean } = {}) {
  const group = await createPersistentGroup({ name: `Integration ${crypto.randomUUID()}`, members: ['Jamie', 'Alex', 'Jordan', 'Maya'] })
  const members = group.members
  for (const member of members.slice(0, 3)) await db.insert(groupPermissions).values({ groupId: group.group.id, memberId: member.id, limitCents: 50000 })
  const cartItems = members.map((member, index) => ({ id: `share-${index}`, label: `${member.name}'s pass`, cents: shares[index]!, quantity: 1 }))
  const allocation = {
    interpretation: { assignments: cartItems.map((item, index) => ({ itemId: item.id, memberIds: [members[index]!.id] })) },
    allocations: members.map((member, index) => ({ memberId: member.id, itemIds: [cartItems[index]!.id] })),
  }
  const session = await createCheckoutSession({ groupId: group.group.id, merchant: 'Northline test', reference: crypto.randomUUID(), totalCents: 128400, currency: 'USD', cart: { product: 'Test trip', items: cartItems }, expectedPayeeMerchantId: payeeId })
  await saveSessionAllocation({ sessionId: session.id, instruction: 'Test allocation', allocation, memberAmounts: members.map((member, index) => ({ memberId: member.id, amountCents: shares[index]! })) })
  expect((await getCheckoutSession(session.id)).funding.every((row) => row.consentStatus === 'pending')).toBe(true)
  for (let index = 0; index < 3; index++) await approveOneTime({ sessionId: session.id, memberId: members[index]!.id, approvedCents: shares[index]! })
  if (options.approveLast !== false) await approveOneTime({ sessionId: session.id, memberId: members[3]!.id, approvedCents: shares[3]! })
  return { group, members, sessionId: session.id }
}

async function openOrders(sessionId: string, gateway: FakePayPal) {
  const checkout = await ensureIndependentPaymentCommitments(sessionId)
  const ids: Array<{ commitmentId: string; orderId: string }> = []
  for (let index = 0; index < checkout.commitments.length; index++) {
    const commitment = checkout.commitments[index]!
    const opened = await createIndependentPayPalOrder({ sessionId, commitmentId: commitment.id, expectedPayerEmail: emails[index]!, returnUrl: 'https://example.test/return', cancelUrl: 'https://example.test/cancel', gateway })
    gateway.approve(opened.providerOrderId!, emails[index]!)
    ids.push({ commitmentId: commitment.id, orderId: opened.providerOrderId! })
  }
  return ids
}

integration('PostgreSQL checkout consistency', () => {
  beforeAll(async () => {
    const result = await pool.query('select current_database() as name')
    if (result.rows[0]?.name !== 'whoosh_test') throw new Error('Integration tests require the isolated whoosh_test database')
  })

  it('closes only unpaid drafts in their own group and preserves payment activity', async () => {
    const group = await createPersistentGroup({ name: `Drafts ${crypto.randomUUID()}`, members: ['Jamie', 'Alex'] })
    const draft = await createCheckoutSession({ groupId: group.group.id, merchant: 'Northline test', reference: crypto.randomUUID(), totalCents: 128400, currency: 'USD', cart: { items: [] }, expectedPayeeMerchantId: payeeId })
    await expect(cancelUnpaidCheckoutDraft(crypto.randomUUID(), draft.id)).rejects.toThrow('not found in this group')
    expect((await cancelUnpaidCheckoutDraft(group.group.id, draft.id)).status).toBe('cancelled')
    expect((await listPersistentGroups()).find((row) => row.id === group.group.id)?.activeCheckoutCount).toBe(0)
    await expect(cancelUnpaidCheckoutDraft(group.group.id, draft.id)).rejects.toThrow('payment activity')
    const protectedSession = await createCheckoutSession({ groupId: group.group.id, merchant: 'Northline test', reference: crypto.randomUUID(), totalCents: 128400, currency: 'USD', cart: { items: [] }, expectedPayeeMerchantId: payeeId })
    await db.update(checkoutSessions).set({ paypalOrderId: 'TEST-ORDER-DRAFT-GUARD', merchantPaymentStatus: 'paypal_order_created', status: 'paypal_order_created' }).where(eq(checkoutSessions.id, protectedSession.id))
    await expect(cancelUnpaidCheckoutDraft(group.group.id, protectedSession.id)).rejects.toThrow('payment activity')
    expect((await getCheckoutSession(protectedSession.id)).status).toBe('paypal_order_created')
    const funded = await createCheckoutSession({ groupId: group.group.id, merchant: 'Northline test', reference: crypto.randomUUID(), totalCents: 128400, currency: 'USD', cart: { items: [] }, expectedPayeeMerchantId: payeeId })
    await db.insert(participantFunding).values({ checkoutSessionId: funded.id, memberId: group.members[0]!.id, allocationCents: 128400, fundingStatus: 'verified' })
    await expect(cancelUnpaidCheckoutDraft(group.group.id, funded.id)).rejects.toThrow('funding activity')
    expect((await getCheckoutSession(funded.id)).status).toBe('active')
  })

  it('issues hashed, expiring, participant-scoped links with one-time decision and withdrawal actions', async () => {
    const { members, sessionId } = await fixture({ approveLast: false })
    const link = (await createParticipantApprovalLinks(sessionId)).find((row) => row.participantName === 'Maya')
    expect(link?.participantName).toBe('Maya')
    expect(link?.purpose).toBe('decision')
    expect(link?.token).toMatch(/^[\w-]{43}$/)
    const [stored] = await db.select().from(participantApprovalTokens).where(eq(participantApprovalTokens.memberId, members[3]!.id))
    expect(stored?.tokenHash).not.toBe(link?.token)
    expect(stored?.tokenHash).toHaveLength(64)
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000)

    const details = await getParticipantApproval(link!.token)
    expect(details).toMatchObject({ participantName: 'Maya', groupName: expect.any(String), amountCents: 28400, canDecide: true })
    expect(details.items).toEqual([{ id: 'share-3', label: "Maya's pass", amountCents: 28400 }])
    const approved = await decideParticipantApproval(link!.token, 'approve')
    expect(approved).toMatchObject({ consentStatus: 'consented', withdrawalToken: expect.stringMatching(/^[\w-]{43}$/) })
    await expect(decideParticipantApproval(link!.token, 'approve')).rejects.toThrow('already been used')

    const withdrawal = await getParticipantApproval(approved.withdrawalToken!)
    expect(withdrawal).toMatchObject({ participantName: 'Maya', canWithdraw: true, canDecide: false })
    await expect(decideParticipantApproval(approved.withdrawalToken!, 'approve')).rejects.toThrow('does not allow')
    expect(await decideParticipantApproval(approved.withdrawalToken!, 'withdraw')).toMatchObject({ consentStatus: 'pending' })
    await expect(decideParticipantApproval(approved.withdrawalToken!, 'withdraw')).rejects.toThrow('already been used')

    const renewedLink = (await createParticipantApprovalLinks(sessionId)).find((row) => row.participantName === 'Maya')
    expect(await decideParticipantApproval(renewedLink!.token, 'decline')).toMatchObject({ consentStatus: 'declined' })
    await expect(decideParticipantApproval(renewedLink!.token, 'approve')).rejects.toThrow('already been used')
  })

  it('opens four email-free, participant-bound PayPal orders and verifies each captured share once', async () => {
    const gateway = new FakePayPal()
    const { members, sessionId } = await fixture()
    const links = await createParticipantApprovalLinks(sessionId)
    expect(links).toHaveLength(4)
    expect(links.every((link) => link.purpose === 'withdrawal')).toBe(true)
    const checkout = await ensureIndependentPaymentCommitments(sessionId)
    const orders: Array<{ commitmentId: string; orderId: string }> = []
    for (const [index, link] of links.entries()) {
      const participant = await resolveParticipantPaymentToken(link.token)
      expect(participant).toMatchObject({ sessionId, memberId: members[index]!.id, amountCents: shares[index], currency: 'USD' })
      const commitment = checkout.commitments.find((row) => row.memberId === participant.memberId)!
      const opened = await createIndependentPayPalOrder({ sessionId: participant.sessionId, commitmentId: commitment.id, returnUrl: 'https://example.test/participant-return', cancelUrl: 'https://example.test/participant-cancel', gateway })
      expect(opened.expectedPayerEmail).toBeNull()
      const repeated = await createIndependentPayPalOrder({ sessionId: participant.sessionId, commitmentId: commitment.id, returnUrl: 'https://example.test/participant-return', cancelUrl: 'https://example.test/participant-cancel', gateway })
      expect(repeated.providerOrderId).toBe(opened.providerOrderId)
      const orderId = opened.providerOrderId!
      expect(gateway.orders.get(orderId)).toMatchObject({ customId: sessionId, invoiceId: `whoosh-${commitment.id}-r1`, orderCents: shares[index], currency: 'USD', payeeMerchantId: payeeId })
      gateway.approve(orderId, emails[index]!)
      orders.push({ commitmentId: commitment.id, orderId })
    }
    expect(new Set(orders.map((row) => row.orderId)).size).toBe(4)
    expect(gateway.orders.size).toBe(4)
    for (const order of orders) await captureIndependentPayPalOrder({ sessionId, ...order, gateway })
    const restored = await getIndependentPaymentCheckout(sessionId)
    expect(restored).toMatchObject({ fundedCents: 128400, remainingCents: 0, fullyVerified: true })
    expect(restored.commitments.map((row) => row.payerEmail)).toEqual(emails)
    const journals = await Promise.all(restored.commitments.map((row) => db.select({ id: ledgerJournals.id }).from(ledgerJournals).where(eq(ledgerJournals.idempotencyKey, `paypal-capture:${row.providerCaptureId}`))))
    expect(journals.every((rows) => rows.length === 1)).toBe(true)
    await captureIndependentPayPalOrder({ sessionId, ...orders[0]!, gateway })
    expect(await db.select({ id: ledgerJournals.id }).from(ledgerJournals).where(eq(ledgerJournals.idempotencyKey, `paypal-capture:${restored.commitments[0]!.providerCaptureId}`))).toHaveLength(1)
    await confirmSimulatedNorthlineBooking(sessionId)
    expect((await getParticipantApproval(links[0]!.token)).paymentReady).toBe(false)
    await expect(resolveParticipantPaymentToken(links[0]!.token)).rejects.toThrow('not ready for participant payment')
  })

  it('blocks email-free payment until all consent and rejects expired links', async () => {
    const { members, sessionId } = await fixture({ approveLast: false })
    const link = (await createParticipantApprovalLinks(sessionId)).find((row) => row.participantName === 'Maya')!
    await expect(resolveParticipantPaymentToken(link.token)).rejects.toThrow('not ready for participant payment')
    await decideParticipantApproval(link.token, 'approve')
    expect(await resolveParticipantPaymentToken(link.token)).toMatchObject({ sessionId, memberId: members[3]!.id, amountCents: 28400 })
    await db.update(participantApprovalTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(participantApprovalTokens.memberId, members[3]!.id))
    await expect(resolveParticipantPaymentToken(link.token)).rejects.toThrow('invalid or expired')
  })

  it('restores missing checkout links only before any PayPal order exists', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const checkout = await ensureIndependentPaymentCommitments(sessionId)
    const links = await createParticipantApprovalLinks(sessionId)
    expect(links).toHaveLength(4)
    expect(links.every((link) => link.purpose === 'payment')).toBe(true)
    const first = await resolveParticipantPaymentToken(links[0]!.token)
    const commitment = checkout.commitments.find((row) => row.memberId === first.memberId)!
    await createIndependentPayPalOrder({ sessionId, commitmentId: commitment.id, returnUrl: 'https://example.test/return', cancelUrl: 'https://example.test/cancel', gateway })
    await expect(createParticipantApprovalLinks(sessionId)).rejects.toThrow('Consent cannot change')
    expect(await resolveParticipantPaymentToken(links[0]!.token)).toMatchObject({ sessionId, memberId: first.memberId })
  })

  it('does not issue checkout links for an expired Northline booking', async () => {
    const { sessionId } = await fixture()
    await ensureIndependentPaymentCommitments(sessionId)
    await db.update(checkoutSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(checkoutSessions.id, sessionId))
    await expect(createParticipantApprovalLinks(sessionId)).rejects.toThrow('expired')
  })

  it('invalidates participant links when the saved allocation changes and rejects unknown tokens', async () => {
    const { members, sessionId } = await fixture({ approveLast: false })
    const link = (await createParticipantApprovalLinks(sessionId)).find((row) => row.participantName === 'Maya')
    await expect(getParticipantApproval('A'.repeat(43))).rejects.toThrow('invalid or expired')
    await saveSessionAllocation({ sessionId, instruction: 'Revised allocation', allocation: { revised: true }, memberAmounts: members.map((member, index) => ({ memberId: member.id, amountCents: shares[index]! })) })
    await expect(getParticipantApproval(link!.token)).rejects.toThrow('out of date')
    await expect(decideParticipantApproval(link!.token, 'approve')).rejects.toThrow('out of date')
  })

  it('rejects expired participant decision links', async () => {
    const { members, sessionId } = await fixture({ approveLast: false })
    const link = (await createParticipantApprovalLinks(sessionId)).find((row) => row.participantName === 'Maya')
    await db.update(participantApprovalTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(participantApprovalTokens.memberId, members[3]!.id))
    await expect(getParticipantApproval(link!.token)).rejects.toThrow('invalid or expired')
    await expect(decideParticipantApproval(link!.token, 'approve')).rejects.toThrow('expired')
  })

  it('persists approval withdrawal and blocks payment until consent returns', async () => {
    const { members, sessionId } = await fixture()
    expect((await getCheckoutSession(sessionId)).status).toBe('authorized_unpaid')
    await withdrawOneTime({ sessionId, memberId: members[3]!.id })
    const restored = await getCheckoutSession(sessionId)
    expect(restored.status).toBe('active')
    expect(restored.funding.find((row) => row.memberId === members[3]!.id)?.consentStatus).toBe('pending')
    expect(await db.select().from(purchaseApprovals).where(and(eq(purchaseApprovals.checkoutSessionId, sessionId), eq(purchaseApprovals.memberId, members[3]!.id)))).toHaveLength(0)
    await expect(ensureIndependentPaymentCommitments(sessionId)).rejects.toThrow()
    await approveOneTime({ sessionId, memberId: members[3]!.id, approvedCents: shares[3]! })
    expect((await getCheckoutSession(sessionId)).status).toBe('authorized_unpaid')
  })

  it('invalidates one-time approval when an allocation is edited', async () => {
    const { members, sessionId } = await fixture()
    await saveSessionAllocation({ sessionId, instruction: 'Revised allocation', allocation: { revised: true }, memberAmounts: members.map((member, index) => ({ memberId: member.id, amountCents: shares[index]! })) })
    const restored = await getCheckoutSession(sessionId)
    expect(restored.status).toBe('active')
    expect(restored.funding.find((row) => row.memberId === members[3]!.id)?.consentStatus).toBe('pending')
    expect(await db.select().from(purchaseApprovals).where(eq(purchaseApprovals.checkoutSessionId, sessionId))).toHaveLength(0)
    await expect(ensureIndependentPaymentCommitments(sessionId)).rejects.toThrow()
  })

  it('saves the parsed Northline preview against actual saved member IDs', async () => {
    const { members, sessionId } = await fixture()
    const items = [{ id: 'tickets', label: '4 traveler passes', unitCents: 113_600, quantity: 1 }, { id: 'upgrade', label: 'Cabin upgrade', unitCents: 10_000, quantity: 1 }, { id: 'shuttle', label: 'Station shuttle', unitCents: 4_800, quantity: 1 }]
    const interpretation = await createAllocationInterpreter({ AI_PROVIDER: 'mock' }).interpret({ transcript: "Maya isn't taking the shuttle. Alex and I are covering the upgrade. Split everything else.", itemIds: items.map((item) => item.id), memberDirectory: members.map((member) => ({ id: member.id, name: member.name })) })
    expect(interpretation.status).toBe('READY')
    const allocations = allocateReceiptItems(items, interpretation.assignments, members.map((member) => member.id))
    expect(reconcileReceipt(items, allocations)).toEqual({ receiptTotalCents: 128_400, allocatedCents: 128_400, differenceCents: 0 })
    await saveSessionAllocation({ sessionId, instruction: 'Northline preview', allocation: { interpretation, allocations }, memberAmounts: allocations.map((row) => ({ memberId: row.memberId, amountCents: row.amountCents })) })
    const restored = await getCheckoutSession(sessionId)
    expect(restored.status).toBe('active')
    expect(Object.fromEntries(restored.funding.map((row) => [row.name, row.allocationCents]))).toEqual({ Jamie: 35_000, Alex: 35_000, Jordan: 30_000, Maya: 28_400 })
  })

  it('rejects late approvals in partially paid, completed, and cancelled sessions', async () => {
    const gateway = new FakePayPal()
    const { members, sessionId } = await fixture()
    const orders = await openOrders(sessionId, gateway)
    await captureIndependentPayPalOrder({ sessionId, commitmentId: orders[0]!.commitmentId, orderId: orders[0]!.orderId, gateway })
    expect((await getIndependentPaymentCheckout(sessionId)).session.bookingStatus).toBe('partially_paid')
    await expect(approveOneTime({ sessionId, memberId: members[3]!.id, approvedCents: shares[3]! })).rejects.toThrow('Consent cannot change')
    await expect(withdrawOneTime({ sessionId, memberId: members[3]!.id })).rejects.toThrow('Consent cannot change')
    await cancelAndRefundIndependentCheckout(sessionId, gateway)
    expect((await getCheckoutSession(sessionId)).status).toBe('cancelled')
    await expect(approveOneTime({ sessionId, memberId: members[3]!.id, approvedCents: shares[3]! })).rejects.toThrow('Consent cannot change')
    const completed = await fixture()
    const completedOrders = await openOrders(completed.sessionId, gateway)
    for (const order of completedOrders) await captureIndependentPayPalOrder({ sessionId: completed.sessionId, commitmentId: order.commitmentId, orderId: order.orderId, gateway })
    await confirmSimulatedNorthlineBooking(completed.sessionId)
    expect((await getCheckoutSession(completed.sessionId)).status).toBe('completed')
    await expect(approveOneTime({ sessionId: completed.sessionId, memberId: completed.members[3]!.id, approvedCents: shares[3]! })).rejects.toThrow('Consent cannot change')
    await expect(recordPayPalOrder({ sessionId: completed.sessionId, orderId: 'LATE-ORDER' })).rejects.toThrow()
    expect((await getCheckoutSession(completed.sessionId)).status).toBe('completed')
  })

  it('serializes duplicate final returns and posts one USD journal per verified share', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const orders = await openOrders(sessionId, gateway)
    for (const order of orders.slice(0, 3)) await captureIndependentPayPalOrder({ sessionId, commitmentId: order.commitmentId, orderId: order.orderId, gateway })
    const final = orders[3]!
    const [a, b] = await Promise.all([1, 2].map(() => captureIndependentPayPalOrder({ sessionId, commitmentId: final.commitmentId, orderId: final.orderId, gateway })))
    expect(a?.fundedCents).toBe(128400)
    expect(b?.fundedCents).toBe(128400)
    expect(gateway.captureCalls).toBe(4)
    expect((await getIndependentPaymentCheckout(sessionId)).session.bookingStatus).toBe('merchant_booking_pending')
    const commitments = await db.select().from(paymentCommitments).where(eq(paymentCommitments.checkoutSessionId, sessionId))
    expect(commitments).toHaveLength(4)
    for (const commitment of commitments) {
      const journals = await db.select().from(ledgerJournals).where(eq(ledgerJournals.idempotencyKey, `paypal-capture:${commitment.providerCaptureId}`))
      expect(journals).toHaveLength(1)
      const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.journalId, journals[0]!.id))
      expect(entries).toHaveLength(2)
      expect(entries.every((entry) => entry.currency === 'USD')).toBe(true)
      expect(entries[0]!.amountCents).toBe(commitment.amountCents)
    }
  })

  it('correlates four distinct PayPal orders and invoices to one pending Northline booking', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const opened = await openOrders(sessionId, gateway)
    const checkout = await getIndependentPaymentCheckout(sessionId)
    expect(checkout.merchantBooking).toMatchObject({ checkoutSessionId: sessionId, status: 'pending', totalCents: 128400, currency: 'USD', expectedPayeeMerchantId: payeeId })
    expect(new Set(opened.map((row) => row.orderId)).size).toBe(4)
    expect(new Set(opened.map((row) => gateway.orders.get(row.orderId)?.invoiceId)).size).toBe(4)
    expect(opened.every((row) => gateway.orders.get(row.orderId)?.customId === sessionId && gateway.orders.get(row.orderId)?.payeeMerchantId === payeeId)).toBe(true)
    await expect(confirmSimulatedNorthlineBooking(sessionId)).rejects.toThrow()
    expect((await getIndependentPaymentCheckout(sessionId)).merchantBooking?.status).toBe('pending')
  })

  it('rejects an incorrect PayPal payee before capture', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const [order] = await openOrders(sessionId, gateway)
    gateway.orders.set(order!.orderId, { ...gateway.orders.get(order!.orderId)!, payeeMerchantId: 'WRONG-PAYEE' })
    await expect(captureIndependentPayPalOrder({ sessionId, commitmentId: order!.commitmentId, orderId: order!.orderId, gateway })).rejects.toThrow('payee')
    expect(gateway.captureCalls).toBe(0)
    expect((await getIndependentPaymentCheckout(sessionId)).fundedCents).toBe(0)
  })

  it('confirms one durable Northline booking after four captures, including repeated and concurrent acknowledgments', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const orders = await openOrders(sessionId, gateway)
    await Promise.all(orders.map((order) => captureIndependentPayPalOrder({ sessionId, commitmentId: order.commitmentId, orderId: order.orderId, gateway })))
    const before = await getIndependentPaymentCheckout(sessionId)
    expect(before.fundedCents).toBe(128400)
    expect(before.merchantBooking?.status).toBe('pending')
    expect((await db.select().from(fundingReadyNotifications).where(eq(fundingReadyNotifications.checkoutSessionId, sessionId)))).toHaveLength(1)
    const [first, second] = await Promise.all([confirmSimulatedNorthlineBooking(sessionId), confirmSimulatedNorthlineBooking(sessionId)])
    expect(first.merchantBooking?.id).toBe(second.merchantBooking?.id)
    expect(first.merchantBooking?.status).toBe('confirmed')
    expect((await getIndependentPaymentCheckout(sessionId)).session.bookingStatus).toBe('confirmed_simulated')
    expect(await db.select().from(northlineBookings).where(eq(northlineBookings.checkoutSessionId, sessionId))).toHaveLength(1)
    expect(await db.select().from(northlineBookingEvents).where(and(eq(northlineBookingEvents.bookingId, first.merchantBooking!.id), eq(northlineBookingEvents.eventType, 'booking.confirmed')))).toHaveLength(1)
    expect((await db.select().from(fundingReadyNotifications).where(eq(fundingReadyNotifications.checkoutSessionId, sessionId)))[0]?.status).toBe('delivered')
  })

  it('keeps a rejected merchant booking unconfirmed', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const orders = await openOrders(sessionId, gateway)
    for (const order of orders) await captureIndependentPayPalOrder({ sessionId, commitmentId: order.commitmentId, orderId: order.orderId, gateway })
    await rejectSimulatedNorthlineBooking(sessionId, 'Inventory unavailable')
    await expect(confirmSimulatedNorthlineBooking(sessionId)).rejects.toThrow('rejected')
    const restored = await getIndependentPaymentCheckout(sessionId)
    expect(restored.merchantBooking).toMatchObject({ status: 'rejected', failureReason: 'Inventory unavailable' })
    expect(restored.session.status).not.toBe('completed')
  })

  it('persists expiration and does not confirm an expired merchant booking', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const orders = await openOrders(sessionId, gateway)
    for (const order of orders) await captureIndependentPayPalOrder({ sessionId, commitmentId: order.commitmentId, orderId: order.orderId, gateway })
    await db.update(northlineBookings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(northlineBookings.checkoutSessionId, sessionId))
    const result = await confirmSimulatedNorthlineBooking(sessionId)
    expect(result.merchantBooking?.status).toBe('expired')
    expect(result.session.status).not.toBe('completed')
    await expect(confirmSimulatedNorthlineBooking(sessionId)).rejects.toThrow('expired')
  })

  it('recovers an acknowledged merchant booking after a lost WHOOSH response', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const orders = await openOrders(sessionId, gateway)
    for (const order of orders) await captureIndependentPayPalOrder({ sessionId, commitmentId: order.commitmentId, orderId: order.orderId, gateway })
    await db.update(northlineBookings).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(northlineBookings.checkoutSessionId, sessionId))
    const restored = await confirmSimulatedNorthlineBooking(sessionId)
    expect(restored.session.bookingStatus).toBe('confirmed_simulated')
    expect(restored.merchantBooking?.status).toBe('confirmed')
    expect((await db.select().from(northlineBookings).where(eq(northlineBookings.checkoutSessionId, sessionId)))).toHaveLength(1)
  })

  it('serializes concurrent payments for the last two participants', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const orders = await openOrders(sessionId, gateway)
    for (const order of orders.slice(0, 2)) await captureIndependentPayPalOrder({ sessionId, commitmentId: order.commitmentId, orderId: order.orderId, gateway })
    await Promise.all(orders.slice(2).map((order) => captureIndependentPayPalOrder({ sessionId, commitmentId: order.commitmentId, orderId: order.orderId, gateway })))
    const restored = await getIndependentPaymentCheckout(sessionId)
    expect(restored.fundedCents).toBe(128400)
    expect(restored.remainingCents).toBe(0)
    expect(restored.session.bookingStatus).toBe('merchant_booking_pending')
    expect(gateway.captureCalls).toBe(4)
  })

  it('keeps provider success recoverable when PostgreSQL rejects capture persistence', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const [order] = await openOrders(sessionId, gateway)
    gateway.captureIdOverride = 'x'.repeat(129) // Exceeds the persisted provider capture ID column.
    await expect(captureIndependentPayPalOrder({ sessionId, commitmentId: order!.commitmentId, orderId: order!.orderId, gateway })).rejects.toThrow()
    expect(gateway.orders.get(order!.orderId)?.status).toBe('COMPLETED')
    expect(gateway.captureCalls).toBe(1)
    const [stored] = await db.select().from(paymentCommitments).where(eq(paymentCommitments.id, order!.commitmentId))
    expect(stored?.providerCaptureId).toBeNull()
    await expect(captureIndependentPayPalOrder({ sessionId, commitmentId: order!.commitmentId, orderId: order!.orderId, gateway })).rejects.toThrow()
    expect(gateway.captureCalls).toBe(1)
  })

  it('does not mark an uncertain provider capture as failed or start another charge', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const [order] = await openOrders(sessionId, gateway)
    gateway.uncertainCapture = true
    await expect(captureIndependentPayPalOrder({ sessionId, commitmentId: order!.commitmentId, orderId: order!.orderId, gateway })).rejects.toThrow('uncertain')
    const [stored] = await db.select().from(paymentCommitments).where(eq(paymentCommitments.id, order!.commitmentId))
    expect(stored?.status).toBe('order_created')
    expect((await getIndependentPaymentCheckout(sessionId)).fundedCents).toBe(0)
    expect(gateway.captureCalls).toBe(1)
  })

  it('rejects a CAD checkout before creating a USD PayPal order', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    await db.update(checkoutSessions).set({ currency: 'CAD' }).where(eq(checkoutSessions.id, sessionId))
    const checkout = await ensureIndependentPaymentCommitments(sessionId)
    const commitment = checkout.commitments[0]!
    await expect(createIndependentPayPalOrder({ sessionId, commitmentId: commitment.id, expectedPayerEmail: emails[0]!, returnUrl: 'https://example.test/return', cancelUrl: 'https://example.test/cancel', gateway })).rejects.toThrow('requires USD')
    expect(gateway.orders.size).toBe(0)
  })

  it('preserves partial captures and reverses them only after verified refunds', async () => {
    const gateway = new FakePayPal()
    const { sessionId } = await fixture()
    const orders = await openOrders(sessionId, gateway)
    await captureIndependentPayPalOrder({ sessionId, commitmentId: orders[0]!.commitmentId, orderId: orders[0]!.orderId, gateway })
    expect((await getIndependentPaymentCheckout(sessionId)).fundedCents).toBe(35000)
    gateway.refundStatus = 'PENDING'
    let recovered = await cancelAndRefundIndependentCheckout(sessionId, gateway)
    expect(recovered.fundedCents).toBe(0)
    const captured = recovered.commitments.find((row) => row.id === orders[0]!.commitmentId)!
    expect(captured.status).toBe('refund_pending')
    expect(captured.providerRefundId).toBeTruthy()
    gateway.refunds.get(captured.providerRefundId!)!.status = 'COMPLETED'
    recovered = await cancelAndRefundIndependentCheckout(sessionId, gateway)
    expect(recovered.commitments.find((row) => row.id === captured.id)?.status).toBe('refunded')
    expect(recovered.commitments.find((row) => row.id === captured.id)?.refundedCents).toBe(35000)
    expect(recovered.session.status).toBe('cancelled')
    await cancelAndRefundIndependentCheckout(sessionId, gateway)
    expect(gateway.refundCalls).toBe(1)
    const journals = await db.select().from(ledgerJournals).where(eq(ledgerJournals.idempotencyKey, `paypal-refund:${orders[0]!.commitmentId}`))
    expect(journals).toHaveLength(1)
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.journalId, journals[0]!.id))
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.currency === 'USD')).toBe(true)
  })
})
