import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { splitEvenly } from '@whoosh/shared'
import { db } from '../../db/client.js'
import { checkoutSessions, groupMembers, groupPermissions, groupPurchases, groupRules, groups, participantApprovalTokens, paymentCommitments, participantFunding, participantFundingEvents, purchaseApprovals, users } from '../../db/schema/index.js'
import { addGroupMember, createGroup } from './groups.service.js'

export async function listPersistentGroups() {
  const rows = await db.select().from(groups).orderBy(desc(groups.updatedAt))
  return Promise.all(rows.map(async (group) => {
    const [members, purchases, active] = await Promise.all([
      db.select({ id: groupMembers.id }).from(groupMembers).where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.status, 'active'))),
      db.select({ id: groupPurchases.id }).from(groupPurchases).where(eq(groupPurchases.groupId, group.id)),
      db.select({ id: checkoutSessions.id }).from(checkoutSessions).where(and(eq(checkoutSessions.groupId, group.id), inArray(checkoutSessions.status, ['active', 'authorized_unpaid', 'paypal_order_created']))),
    ])
    return { ...group, memberCount: members.length, purchaseCount: purchases.length, activeCheckoutCount: active.length }
  }))
}

export async function createPersistentGroup(input: { name: string; members: Array<string | { name: string; email?: string }> }) {
  const people = input.members.map((member) => typeof member === 'string' ? { name: member.trim() } : { name: member.name.trim(), email: member.email?.trim().toLowerCase() }).filter((member) => member.name)
  if (people.length === 0 || people.length > 5 || new Set(people.map((member) => member.name.toLowerCase())).size !== people.length) throw new TypeError('Provide distinct names for Jamie and up to four additional members')
  const created = await createGroup({ name: input.name, creatorName: people[0]!.name })
  await db.update(groupMembers).set({ role: 'host' }).where(eq(groupMembers.id, created.member.id))
  for (const person of people.slice(1)) {
    const added = await addGroupMember({ groupId: created.group.id, displayName: person.name })
    if (person.email) await db.update(groupMembers).set({ contactEmail: person.email }).where(eq(groupMembers.id, added.member.id))
  }
  await db.insert(groupRules).values({ groupId: created.group.id }).onConflictDoNothing()
  return getPersistentGroup(created.group.id)
}

export async function getPersistentGroup(groupId: string) {
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1)
  if (!group) throw new TypeError('Group not found')
  const [members, permissions, rules, purchases, sessions] = await Promise.all([
    db.select({ id: groupMembers.id, userId: users.id, name: users.displayName, contactEmail: groupMembers.contactEmail, role: groupMembers.role, status: groupMembers.status }).from(groupMembers).innerJoin(users, eq(groupMembers.userId, users.id)).where(eq(groupMembers.groupId, groupId)).orderBy(sql`CASE WHEN ${groupMembers.role} = 'host' THEN 0 ELSE 1 END`, groupMembers.joinedAt, groupMembers.id),
    db.select().from(groupPermissions).where(eq(groupPermissions.groupId, groupId)),
    db.select().from(groupRules).where(eq(groupRules.groupId, groupId)),
    db.select().from(groupPurchases).where(eq(groupPurchases.groupId, groupId)).orderBy(desc(groupPurchases.completedAt)),
    db.select().from(checkoutSessions).where(eq(checkoutSessions.groupId, groupId)).orderBy(desc(checkoutSessions.updatedAt)),
  ])
  return { group, members, permissions, rules: rules[0] ?? null, purchases, sessions }
}

export async function saveGroupContactEmail(groupId: string, memberId: string, email: string) {
  const [member] = await db.update(groupMembers).set({ contactEmail: email.trim().toLowerCase() }).where(and(eq(groupMembers.id, memberId), eq(groupMembers.groupId, groupId), eq(groupMembers.status, 'active'))).returning({ id: groupMembers.id, contactEmail: groupMembers.contactEmail })
  if (!member) throw new TypeError('Active group member not found')
  return member
}

export async function createCheckoutSession(input: { groupId: string; merchant: string; reference: string; totalCents: number; currency: string; cart: unknown; idempotencyKey?: string; expectedPayeeMerchantId?: string }) {
  return db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const [existing] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.idempotencyKey, input.idempotencyKey)).limit(1)
      if (existing) return existing
    }
    const northline = /^northline\b/i.test(input.merchant)
    const expiresAt = northline ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null
    const [session] = await tx.insert(checkoutSessions).values({ ...input, merchantId: northline ? 'northline-simulator' : null, expectedPayeeMerchantId: input.expectedPayeeMerchantId ?? process.env.PAYPAL_MERCHANT_ID ?? null, expiresAt }).returning()
    if (!session) throw new Error('Could not create checkout session')
    if (northline) {
      const merchantOrderId = `NLT-${session.id}`
      const [linked] = await tx.update(checkoutSessions).set({ merchantOrderId }).where(eq(checkoutSessions.id, session.id)).returning()
      return linked!
    }
    return session
  })
}

export async function getCheckoutSession(sessionId: string) {
  const [session] = await db.select().from(checkoutSessions).where(eq(checkoutSessions.id, sessionId)).limit(1)
  if (!session) throw new TypeError('Checkout session not found')
  const funding = await db.select({ memberId: participantFunding.memberId, name: users.displayName, allocationCents: participantFunding.allocationCents, consentStatus: participantFunding.consentStatus, fundingStatus: participantFunding.fundingStatus }).from(participantFunding).innerJoin(groupMembers, eq(participantFunding.memberId, groupMembers.id)).innerJoin(users, eq(groupMembers.userId, users.id)).where(eq(participantFunding.checkoutSessionId, sessionId)).orderBy(sql`CASE WHEN ${groupMembers.role} = 'host' THEN 0 ELSE 1 END`, groupMembers.joinedAt, groupMembers.id)
  return { ...session, funding }
}

export async function cancelUnpaidCheckoutDraft(groupId: string, sessionId: string) {
  return db.transaction(async (tx) => {
    await lockCheckout(tx, sessionId)
    const [session] = await tx.select().from(checkoutSessions).where(and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.groupId, groupId))).limit(1)
    if (!session) throw new TypeError('Checkout session not found in this group')
    if (!['active', 'authorized_unpaid'].includes(session.status) || session.paymentMode !== 'single_payer' || session.merchantPaymentStatus !== 'not_started' || session.paypalOrderId || session.paypalCaptureId) throw new TypeError('This checkout has payment activity. Open it to review or recover payments instead.')
    const [commitment] = await tx.select({ id: paymentCommitments.id }).from(paymentCommitments).where(eq(paymentCommitments.checkoutSessionId, sessionId)).limit(1)
    const [funding] = await tx.select({ id: participantFunding.id }).from(participantFunding).where(and(eq(participantFunding.checkoutSessionId, sessionId), sql`${participantFunding.fundingStatus} <> 'not_requested'`)).limit(1)
    if (commitment || funding) throw new TypeError('This checkout has funding activity. Open it to review or recover payments instead.')
    const [cancelled] = await tx.update(checkoutSessions).set({ status: 'cancelled', bookingStatus: 'cancelled', updatedAt: new Date() }).where(eq(checkoutSessions.id, sessionId)).returning()
    return cancelled!
  })
}

const APPROVAL_LINK_TTL_MS = 24 * 60 * 60 * 1000
const hashApprovalToken = (token: string) => createHash('sha256').update(token).digest('hex')
const createApprovalToken = () => randomBytes(32).toString('base64url')
const allocationVersion = (session: { instruction: string | null; allocation: unknown; totalCents: number }) =>
  createHash('sha256').update(JSON.stringify([session.instruction, session.allocation, session.totalCents])).digest('hex')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function createParticipantApprovalLinks(sessionId: string) {
  return db.transaction(async (tx) => {
    await lockCheckout(tx, sessionId)
    const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, sessionId)).limit(1)
    if (!session) throw new TypeError('Checkout session not found')
    if (session.expiresAt && session.expiresAt <= new Date()) throw new TypeError('This Northline checkout has expired. Start a new purchase before inviting participants.')
    const commitments = await tx.select({ status: paymentCommitments.status, providerOrderId: paymentCommitments.providerOrderId, providerCaptureId: paymentCommitments.providerCaptureId }).from(paymentCommitments).where(eq(paymentCommitments.checkoutSessionId, sessionId))
    const restoringPaymentLinks = session.status === 'authorized_unpaid' && session.paymentMode === 'independent_paypal' && session.bookingStatus === 'awaiting_payments' && commitments.length > 0 && commitments.every((row) => row.status === 'ready_to_pay' && !row.providerOrderId && !row.providerCaptureId)
    if (!restoringPaymentLinks) await assertConsentEditable(tx, sessionId)
    if (!session.instruction || !session.allocation) throw new TypeError('Save a reconciled allocation before creating participant links')

    const funding = await tx.select({
      memberId: participantFunding.memberId,
      name: users.displayName,
      consentStatus: participantFunding.consentStatus,
    }).from(participantFunding)
      .innerJoin(groupMembers, eq(participantFunding.memberId, groupMembers.id))
      .innerJoin(users, eq(groupMembers.userId, users.id))
      .where(eq(participantFunding.checkoutSessionId, sessionId))
    const approvals = await tx.select({ memberId: purchaseApprovals.memberId })
      .from(purchaseApprovals)
      .where(eq(purchaseApprovals.checkoutSessionId, sessionId))
    const oneTimeApprovalIds = new Set(approvals.map((approval) => approval.memberId))
    const eligible = funding
    if (eligible.length === 0) return []
    if (restoringPaymentLinks && (eligible.length !== commitments.length || eligible.some((row) => row.consentStatus !== 'consented'))) throw new TypeError('Every participant must approve before checkout links can be restored')

    const now = new Date()
    await tx.update(participantApprovalTokens)
      .set({ consumedAt: now })
      .where(and(eq(participantApprovalTokens.checkoutSessionId, sessionId), isNull(participantApprovalTokens.consumedAt)))

    const version = allocationVersion(session)
    const links: Array<{ participantName: string; purpose: 'decision' | 'withdrawal' | 'payment'; token: string; expiresAt: string }> = []
    for (const row of eligible) {
      const purpose = restoringPaymentLinks ? 'payment' : row.consentStatus !== 'consented' ? 'decision' : oneTimeApprovalIds.has(row.memberId) ? 'withdrawal' : 'payment'
      const token = createApprovalToken()
      const expiresAt = new Date(now.getTime() + APPROVAL_LINK_TTL_MS)
      await tx.insert(participantApprovalTokens).values({
        checkoutSessionId: sessionId,
        memberId: row.memberId,
        tokenHash: hashApprovalToken(token),
        purpose,
        allocationVersion: version,
        expiresAt,
      })
      links.push({ participantName: row.name, purpose, token, expiresAt: expiresAt.toISOString() })
    }
    return links
  })
}

export async function getParticipantApproval(token: string) {
  if (!/^[\w-]{43}$/.test(token)) throw new TypeError('This participant link is invalid or expired')
  const [record] = await db.select({
    tokenId: participantApprovalTokens.id,
    tokenPurpose: participantApprovalTokens.purpose,
    tokenVersion: participantApprovalTokens.allocationVersion,
    expiresAt: participantApprovalTokens.expiresAt,
    consumedAt: participantApprovalTokens.consumedAt,
    sessionId: checkoutSessions.id,
    groupId: checkoutSessions.groupId,
    merchant: checkoutSessions.merchant,
    reference: checkoutSessions.reference,
    totalCents: checkoutSessions.totalCents,
    currency: checkoutSessions.currency,
    paymentMode: checkoutSessions.paymentMode,
    cart: checkoutSessions.cart,
    instruction: checkoutSessions.instruction,
    allocation: checkoutSessions.allocation,
    sessionStatus: checkoutSessions.status,
    merchantPaymentStatus: checkoutSessions.merchantPaymentStatus,
    bookingStatus: checkoutSessions.bookingStatus,
    expiresAtSession: checkoutSessions.expiresAt,
    groupName: groups.name,
    memberId: participantApprovalTokens.memberId,
    participantName: users.displayName,
    amountCents: participantFunding.allocationCents,
    consentStatus: participantFunding.consentStatus,
    fundingStatus: participantFunding.fundingStatus,
  }).from(participantApprovalTokens)
    .innerJoin(checkoutSessions, eq(participantApprovalTokens.checkoutSessionId, checkoutSessions.id))
    .innerJoin(groups, eq(checkoutSessions.groupId, groups.id))
    .innerJoin(participantFunding, and(
      eq(participantFunding.checkoutSessionId, checkoutSessions.id),
      eq(participantFunding.memberId, participantApprovalTokens.memberId),
    ))
    .innerJoin(groupMembers, eq(participantApprovalTokens.memberId, groupMembers.id))
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(eq(participantApprovalTokens.tokenHash, hashApprovalToken(token)))
    .limit(1)
  if (!record || record.expiresAt <= new Date()) throw new TypeError('This participant link is invalid or expired')
  if (record.tokenVersion !== allocationVersion(record)) throw new TypeError('This approval link is out of date. Ask the organizer for a current link.')
  if (!['decision', 'withdrawal', 'payment'].includes(record.tokenPurpose)) throw new TypeError('This participant link is invalid or expired')

  const allocation = record.allocation
  const interpretation = isRecord(allocation) && isRecord(allocation.interpretation) ? allocation.interpretation : undefined
  const directAmounts = interpretation?.directAmounts === true
  const assignments = interpretation && Array.isArray(interpretation.assignments) ? interpretation.assignments : []
  const cart = isRecord(record.cart) && Array.isArray(record.cart.items) ? record.cart.items : []
  const memberAllocation = isRecord(allocation) && Array.isArray(allocation.allocations)
    ? allocation.allocations.find((row) => isRecord(row) && row.memberId === record.memberId)
    : undefined
  const assignedIds = isRecord(memberAllocation) && Array.isArray(memberAllocation.itemIds)
    ? memberAllocation.itemIds.filter((itemId): itemId is string => typeof itemId === 'string')
    : []
  const items = directAmounts ? [{ id: 'full-receipt', label: 'Share of full Northline receipt', amountCents: record.amountCents }] : assignedIds.flatMap((itemId) => {
    const cartItem = cart.find((item) => isRecord(item) && item.id === itemId)
    const assignment = assignments.find((row) => isRecord(row) && row.itemId === itemId)
    if (!isRecord(cartItem) || typeof cartItem.label !== 'string' || typeof cartItem.cents !== 'number' || !isRecord(assignment) || !Array.isArray(assignment.memberIds)) return []
    const members = assignment.memberIds.filter((id): id is string => typeof id === 'string')
    const index = members.indexOf(record.memberId)
    if (index < 0 || members.length === 0) return []
    const quantity = typeof cartItem.quantity === 'number' && Number.isInteger(cartItem.quantity) && cartItem.quantity > 0 ? cartItem.quantity : 1
    const portions = splitEvenly(cartItem.cents * quantity, members.length)
    const share = portions[index]
    return share === undefined ? [] : [{ id: itemId, label: cartItem.label, amountCents: share }]
  })
  if (items.reduce((total, item) => total + item.amountCents, 0) !== record.amountCents) {
    throw new TypeError('Saved item shares do not match this participant allocation. Ask the organizer to recompute the split.')
  }
  const [oneTimeApproval] = await db.select({ id: purchaseApprovals.id })
    .from(purchaseApprovals)
    .where(and(eq(purchaseApprovals.checkoutSessionId, record.sessionId), eq(purchaseApprovals.memberId, record.memberId)))
    .limit(1)
  const [commitment] = await db.select({ id: paymentCommitments.id })
    .from(paymentCommitments)
    .where(eq(paymentCommitments.checkoutSessionId, record.sessionId))
    .limit(1)
  const [memberCommitment] = await db.select({ status: paymentCommitments.status, payerEmail: paymentCommitments.payerEmail, expectedPayerEmail: paymentCommitments.expectedPayerEmail })
    .from(paymentCommitments)
    .where(and(eq(paymentCommitments.checkoutSessionId, record.sessionId), eq(paymentCommitments.memberId, record.memberId)))
    .limit(1)
  const allFunding = await db.select({ consentStatus: participantFunding.consentStatus }).from(participantFunding).where(eq(participantFunding.checkoutSessionId, record.sessionId))
  const canDecide = record.tokenPurpose === 'decision' && !record.consumedAt && ['pending', 'declined'].includes(record.consentStatus)
  const canWithdraw = record.tokenPurpose === 'withdrawal' && !record.consumedAt && record.consentStatus === 'consented' && Boolean(oneTimeApproval)
  return {
    participantName: record.participantName,
    groupName: record.groupName,
    merchant: record.merchant,
    reference: record.reference,
    currency: record.currency,
    amountCents: record.amountCents,
    purchaseTotalCents: record.totalCents,
    items,
    consentStatus: record.consentStatus,
    expiresAt: record.expiresAt.toISOString(),
    purpose: record.tokenPurpose,
    canDecide,
    canWithdraw,
    paymentStarted: record.paymentMode !== 'single_payer' || Boolean(commitment) || record.merchantPaymentStatus !== 'not_started' || ['paypal_order_created', 'completed'].includes(record.sessionStatus),
    paymentReady: allFunding.length > 0 && allFunding.every((row) => row.consentStatus === 'consented') && ['active', 'authorized_unpaid'].includes(record.sessionStatus) && !['recovery_required', 'refund_pending', 'refunded', 'merchant_booking_pending', 'confirmed_simulated'].includes(record.bookingStatus) && (!record.expiresAtSession || record.expiresAtSession > new Date()),
    paymentStatus: memberCommitment?.status ?? null,
    payerIdentityVerified: Boolean(memberCommitment?.expectedPayerEmail && memberCommitment.payerEmail && memberCommitment.expectedPayerEmail.toLowerCase() === memberCommitment.payerEmail.toLowerCase()),
  }
}

export async function resolveParticipantPaymentToken(token: string) {
  const approval = await getParticipantApproval(token)
  if (approval.consentStatus !== 'consented' || !approval.paymentReady) throw new TypeError('This checkout is not ready for participant payment. Check approvals or booking status.')
  const [record] = await db.select().from(participantApprovalTokens).where(eq(participantApprovalTokens.tokenHash, hashApprovalToken(token))).limit(1)
  if (!record) throw new TypeError('This participant payment link is no longer active')
  if (record.purpose === 'decision' && record.consumedAt) {
    const [latestDecision] = await db.select({ id: participantApprovalTokens.id }).from(participantApprovalTokens)
      .where(and(eq(participantApprovalTokens.checkoutSessionId, record.checkoutSessionId), eq(participantApprovalTokens.memberId, record.memberId), eq(participantApprovalTokens.purpose, 'decision')))
      .orderBy(desc(participantApprovalTokens.createdAt), desc(participantApprovalTokens.id)).limit(1)
    if (latestDecision?.id !== record.id) throw new TypeError('This participant payment link was replaced by a newer invitation')
  } else if (record.consumedAt || !['withdrawal', 'payment'].includes(record.purpose)) throw new TypeError('This participant payment link is no longer active')
  return { sessionId: record.checkoutSessionId, memberId: record.memberId, amountCents: approval.amountCents, currency: approval.currency }
}

export async function decideParticipantApproval(token: string, decision: 'approve' | 'decline' | 'withdraw') {
  if (!/^[\w-]{43}$/.test(token)) throw new TypeError('This participant link is invalid or expired')
  return db.transaction(async (tx) => {
    const tokenHash = hashApprovalToken(token)
    const [initialToken] = await tx.select().from(participantApprovalTokens).where(eq(participantApprovalTokens.tokenHash, tokenHash)).limit(1)
    if (!initialToken) throw new TypeError('This participant link is invalid or expired')
    await lockCheckout(tx, initialToken.checkoutSessionId)
    const [approvalToken] = await tx.select().from(participantApprovalTokens).where(eq(participantApprovalTokens.id, initialToken.id)).limit(1)
    if (!approvalToken || approvalToken.expiresAt <= new Date()) throw new TypeError('This participant link is invalid or expired')
    const session = await assertConsentEditable(tx, approvalToken.checkoutSessionId)
    if (!session.instruction || !session.allocation || approvalToken.allocationVersion !== allocationVersion(session)) {
      throw new TypeError('This approval link is out of date. Ask the organizer for a current link.')
    }
    if (approvalToken.consumedAt) throw new TypeError('This participant link has already been used. Ask the organizer for a current link if your decision needs changing.')

    const [funding] = await tx.select().from(participantFunding).where(and(
      eq(participantFunding.checkoutSessionId, session.id),
      eq(participantFunding.memberId, approvalToken.memberId),
    )).limit(1)
    if (!funding) throw new TypeError('No allocated participant share exists')
    const now = new Date()
    let withdrawalToken: string | undefined

    if (approvalToken.purpose === 'decision' && (decision === 'approve' || decision === 'decline')) {
      if (!['pending', 'declined'].includes(funding.consentStatus)) throw new TypeError('This participant has already made a decision')
      if (decision === 'approve') {
        await tx.insert(purchaseApprovals).values({ checkoutSessionId: session.id, memberId: approvalToken.memberId, approvedCents: funding.allocationCents })
          .onConflictDoUpdate({ target: [purchaseApprovals.checkoutSessionId, purchaseApprovals.memberId], set: { approvedCents: funding.allocationCents } })
        await tx.update(participantFunding).set({ consentStatus: 'consented' }).where(eq(participantFunding.id, funding.id))
        withdrawalToken = createApprovalToken()
        await tx.insert(participantApprovalTokens).values({
          checkoutSessionId: session.id,
          memberId: approvalToken.memberId,
          tokenHash: hashApprovalToken(withdrawalToken),
          purpose: 'withdrawal',
          allocationVersion: approvalToken.allocationVersion,
          expiresAt: new Date(now.getTime() + APPROVAL_LINK_TTL_MS),
        })
      } else {
        await tx.delete(purchaseApprovals).where(and(eq(purchaseApprovals.checkoutSessionId, session.id), eq(purchaseApprovals.memberId, approvalToken.memberId)))
        await tx.update(participantFunding).set({ consentStatus: 'declined' }).where(eq(participantFunding.id, funding.id))
      }
      await tx.insert(participantFundingEvents).values({
        checkoutSessionId: session.id,
        memberId: approvalToken.memberId,
        action: decision === 'approve' ? 'approval_granted' : 'approval_declined',
        amountCents: funding.allocationCents,
        idempotencyKey: crypto.randomUUID(),
      })
    } else if (approvalToken.purpose === 'withdrawal' && decision === 'withdraw') {
      if (funding.consentStatus !== 'consented') throw new TypeError('There is no active approval to withdraw')
      const [approval] = await tx.select({ id: purchaseApprovals.id }).from(purchaseApprovals).where(and(
        eq(purchaseApprovals.checkoutSessionId, session.id),
        eq(purchaseApprovals.memberId, approvalToken.memberId),
      )).limit(1)
      if (!approval) throw new TypeError('There is no one-time approval to withdraw')
      await tx.delete(purchaseApprovals).where(eq(purchaseApprovals.id, approval.id))
      await tx.update(participantFunding).set({ consentStatus: 'pending' }).where(eq(participantFunding.id, funding.id))
      await tx.insert(participantFundingEvents).values({
        checkoutSessionId: session.id,
        memberId: approvalToken.memberId,
        action: 'approval_withdrawn',
        amountCents: funding.allocationCents,
        idempotencyKey: crypto.randomUUID(),
      })
    } else {
      throw new TypeError('This participant link does not allow that action')
    }

    await tx.update(participantApprovalTokens).set({ consumedAt: now }).where(eq(participantApprovalTokens.id, approvalToken.id))
    const allFunding = await tx.select({ allocationCents: participantFunding.allocationCents, consentStatus: participantFunding.consentStatus })
      .from(participantFunding)
      .where(eq(participantFunding.checkoutSessionId, session.id))
    const authorized = allFunding.length > 0
      && allFunding.every((row) => row.consentStatus === 'consented')
      && allFunding.reduce((total, row) => total + row.allocationCents, 0) === session.totalCents
    await tx.update(checkoutSessions)
      .set({ status: authorized ? 'authorized_unpaid' : 'active', updatedAt: now })
      .where(eq(checkoutSessions.id, session.id))
    const [updatedFunding] = await tx.select({ consentStatus: participantFunding.consentStatus })
      .from(participantFunding)
      .where(and(eq(participantFunding.checkoutSessionId, session.id), eq(participantFunding.memberId, approvalToken.memberId)))
      .limit(1)
    return { consentStatus: updatedFunding?.consentStatus ?? 'pending', withdrawalToken }
  })
}

export function assertCheckoutReady(session: { status: string; totalCents: number; funding: Array<{ allocationCents: number; consentStatus: string }> }) {
  if (session.status !== 'authorized_unpaid') throw new TypeError('Checkout must be authorized before payment can begin')
  if (session.funding.length === 0 || session.funding.some((funding) => funding.consentStatus !== 'consented') || session.funding.reduce((total, funding) => total + funding.allocationCents, 0) !== session.totalCents) {
    throw new TypeError('Every participant must consent to a reconciled allocation before payment can begin')
  }
}

async function lockCheckout(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], sessionId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`checkout:${sessionId}`}))`)
}

async function assertConsentEditable(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], sessionId: string) {
  await lockCheckout(tx, sessionId)
  const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, sessionId)).limit(1)
  if (!session) throw new TypeError('Checkout session not found')
  const [commitment] = await tx.select({ id: paymentCommitments.id }).from(paymentCommitments).where(eq(paymentCommitments.checkoutSessionId, sessionId)).limit(1)
  if (!['active', 'authorized_unpaid'].includes(session.status) || session.paymentMode !== 'single_payer' || session.merchantPaymentStatus !== 'not_started' || commitment) {
    throw new TypeError('Consent cannot change after payment processing begins')
  }
  return session
}

export async function saveSessionAllocation(input: { sessionId: string; instruction: string; allocation: unknown; memberAmounts: Array<{ memberId: string; amountCents: number }> }) {
  return db.transaction(async (tx) => {
    const session = await assertConsentEditable(tx, input.sessionId)
    await tx.update(participantApprovalTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(participantApprovalTokens.checkoutSessionId, input.sessionId), isNull(participantApprovalTokens.consumedAt)))
    const activeMembers = await tx.select({ id: groupMembers.id }).from(groupMembers).where(and(eq(groupMembers.groupId, session.groupId), eq(groupMembers.status, 'active')))
    const memberIds = input.memberAmounts.map((row) => row.memberId)
    if (new Set(memberIds).size !== memberIds.length || memberIds.length !== activeMembers.length || memberIds.some((id) => !activeMembers.some((member) => member.id === id))) {
      throw new TypeError('Allocation must include each active group member exactly once')
    }
    if (input.memberAmounts.reduce((total, row) => total + row.amountCents, 0) !== session.totalCents) {
      throw new TypeError('Allocated shares must reconcile to the merchant total')
    }
    await tx.delete(purchaseApprovals).where(eq(purchaseApprovals.checkoutSessionId, input.sessionId))
    for (const row of input.memberAmounts) {
      await tx.insert(participantFunding).values({ checkoutSessionId: input.sessionId, memberId: row.memberId, allocationCents: row.amountCents, consentStatus: 'pending', fundingStatus: 'not_requested' }).onConflictDoUpdate({ target: [participantFunding.checkoutSessionId, participantFunding.memberId], set: { allocationCents: row.amountCents, consentStatus: 'pending' } })
    }
    const allFunding = await tx.select({ allocationCents: participantFunding.allocationCents, consentStatus: participantFunding.consentStatus }).from(participantFunding).where(eq(participantFunding.checkoutSessionId, input.sessionId))
    const authorized = allFunding.length === activeMembers.length && allFunding.every((row) => row.consentStatus === 'consented') && allFunding.reduce((sum, row) => sum + row.allocationCents, 0) === session.totalCents
    const [updated] = await tx.update(checkoutSessions).set({ instruction: input.instruction, allocation: input.allocation, status: authorized ? 'authorized_unpaid' : 'active', updatedAt: new Date() }).where(eq(checkoutSessions.id, input.sessionId)).returning()
    return updated
  })
}

export async function approveOneTime(input: { sessionId: string; memberId: string; approvedCents: number }) {
  return db.transaction(async (tx) => {
    const session = await assertConsentEditable(tx, input.sessionId)
    const [funding] = await tx.select().from(participantFunding).where(and(eq(participantFunding.checkoutSessionId, input.sessionId), eq(participantFunding.memberId, input.memberId))).limit(1)
    if (!funding) throw new TypeError('No allocated participant funding record exists')
    if (input.approvedCents !== funding.allocationCents) throw new TypeError('Approval must match the participant allocation')
    await tx.insert(purchaseApprovals).values({ checkoutSessionId: input.sessionId, memberId: input.memberId, approvedCents: input.approvedCents }).onConflictDoUpdate({ target: [purchaseApprovals.checkoutSessionId, purchaseApprovals.memberId], set: { approvedCents: input.approvedCents } })
    await tx.update(participantFunding).set({ consentStatus: 'consented' }).where(eq(participantFunding.id, funding.id))
    const allFunding = await tx.select({ allocationCents: participantFunding.allocationCents, consentStatus: participantFunding.consentStatus }).from(participantFunding).where(eq(participantFunding.checkoutSessionId, input.sessionId))
    const [updated] = await tx.update(checkoutSessions).set({ status: allFunding.length > 0 && allFunding.every((row) => row.consentStatus === 'consented') && allFunding.reduce((sum, row) => sum + row.allocationCents, 0) === session.totalCents ? 'authorized_unpaid' : 'active', updatedAt: new Date() }).where(eq(checkoutSessions.id, input.sessionId)).returning()
    return updated
  })
}

export async function withdrawOneTime(input: { sessionId: string; memberId: string }) {
  return db.transaction(async (tx) => {
    await assertConsentEditable(tx, input.sessionId)
    const [funding] = await tx.select().from(participantFunding).where(and(eq(participantFunding.checkoutSessionId, input.sessionId), eq(participantFunding.memberId, input.memberId))).limit(1)
    if (!funding) throw new TypeError('No allocated participant funding record exists')
    const [approval] = await tx.select({ id: purchaseApprovals.id }).from(purchaseApprovals).where(and(eq(purchaseApprovals.checkoutSessionId, input.sessionId), eq(purchaseApprovals.memberId, input.memberId))).limit(1)
    if (!approval) throw new TypeError('No one-time approval exists to withdraw')
    await tx.delete(purchaseApprovals).where(eq(purchaseApprovals.id, approval.id))
    await tx.update(participantFunding).set({ consentStatus: 'pending' }).where(eq(participantFunding.id, funding.id))
    await tx.insert(participantFundingEvents).values({ checkoutSessionId: input.sessionId, memberId: input.memberId, action: 'approval_withdrawn', amountCents: funding.allocationCents, idempotencyKey: crypto.randomUUID() })
    const [updated] = await tx.update(checkoutSessions).set({ status: 'active', updatedAt: new Date() }).where(eq(checkoutSessions.id, input.sessionId)).returning()
    return updated
  })
}

export async function recordSimulatedFunding(input: { sessionId: string; memberId: string; outcome: 'funded' | 'failed' | 'cancelled'; idempotencyKey: string }) {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, input.sessionId)).limit(1)
    if (!session || session.paymentMode === 'independent_paypal') throw new TypeError('Simulated funding cannot update an independent PayPal checkout')
    const [priorEvent] = await tx.select().from(participantFundingEvents).where(eq(participantFundingEvents.idempotencyKey, input.idempotencyKey)).limit(1)
    if (priorEvent) return
    const [funding] = await tx.select().from(participantFunding).where(and(eq(participantFunding.checkoutSessionId, input.sessionId), eq(participantFunding.memberId, input.memberId))).limit(1)
    if (!funding) throw new TypeError('No allocated participant funding record exists')
    if (funding.consentStatus !== 'consented') throw new TypeError('This share has not been approved')
    if (funding.fundingStatus === 'verified' && input.outcome === 'funded') return
    const status = input.outcome === 'funded' ? 'verified' : input.outcome
    await tx.insert(participantFundingEvents).values({ checkoutSessionId: input.sessionId, memberId: input.memberId, action: input.outcome, amountCents: funding.allocationCents, idempotencyKey: input.idempotencyKey })
    await tx.update(participantFunding).set({ fundingStatus: status }).where(eq(participantFunding.id, funding.id))
  })
}

/** A created PayPal Order is a single payer-to-merchant checkout state, not
 * participant funding and never a completed group purchase. */
export async function recordPayPalOrder(input: { sessionId: string; orderId: string }) {
  return db.transaction(async (tx) => {
    await lockCheckout(tx, input.sessionId)
    const session = await getCheckoutSession(input.sessionId)
    assertCheckoutReady(session)
    const [updated] = await tx.update(checkoutSessions)
      .set({ status: 'paypal_order_created', merchantPaymentStatus: 'paypal_order_created', paypalOrderId: input.orderId, updatedAt: new Date() })
      .where(and(eq(checkoutSessions.id, input.sessionId), eq(checkoutSessions.status, 'authorized_unpaid')))
      .returning()
    if (!updated) throw new TypeError('Checkout is no longer accepting a PayPal order')
    return updated
  })
}

export async function recordVerifiedCapture(input: { sessionId: string; orderId: string; captureId: string }) {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(groupPurchases).where(eq(groupPurchases.paypalCaptureId, input.captureId)).limit(1)
    if (existing) return existing
    const [existingForSession] = await tx.select().from(groupPurchases).where(eq(groupPurchases.checkoutSessionId, input.sessionId)).limit(1)
    if (existingForSession) return existingForSession
    const [session] = await tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, input.sessionId)).limit(1)
    if (!session) throw new TypeError('Checkout session not found')
    if (session.status !== 'paypal_order_created') throw new TypeError('Checkout is not awaiting this PayPal capture')
    if (session.paypalOrderId !== input.orderId) throw new TypeError('This PayPal order is not associated with the checkout session')
    const [purchase] = await tx.insert(groupPurchases).values({ groupId: session.groupId, checkoutSessionId: session.id, merchant: session.merchant, title: 'Montreal Weekend Escape', totalCents: session.totalCents, currency: session.currency, paypalCaptureId: input.captureId }).returning()
    if (!purchase) throw new Error('Could not finalize group purchase')
    await tx.update(checkoutSessions).set({ status: 'completed', merchantPaymentStatus: 'capture_verified', paypalOrderId: input.orderId, paypalCaptureId: input.captureId, updatedAt: new Date() }).where(eq(checkoutSessions.id, input.sessionId))
    return purchase
  })
}
