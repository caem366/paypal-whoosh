import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, pool } from '../../db/client.js'
import { aiPurchaseProposals, checkoutSessions, groupPermissions } from '../../db/schema/index.js'
import { createPersistentGroup, getCheckoutSession } from '../groups/persistent-groups.service.js'
import { ensureIndependentPaymentCommitments } from '../payments/independent-payments.service.js'
import { AgentProviderError, confirmAgentProposal, createAgentProposal, editAgentAllocation, getAgentProposal, type PurchaseIntent } from './purchase-agent.service.js'

const integration = process.env.WHOOSH_DB_INTEGRATION === '1' ? describe.sequential : describe.skip

integration('AI group purchase handoff in PostgreSQL', () => {
  beforeAll(async () => {
    const result = await pool.query('select current_database() as name')
    if (result.rows[0]?.name !== 'whoosh_test') throw new Error('Integration tests require the isolated whoosh_test database')
  })

  async function fixture() {
    const group = await createPersistentGroup({ name: `Agent ${crypto.randomUUID()}`, members: ['Jamie', 'Alex', 'Jordan', 'Maya'] })
    for (const member of group.members) await db.insert(groupPermissions).values({ groupId: group.group.id, memberId: member.id, limitCents: 50_000 })
    const ids = Object.fromEntries(group.members.map((member) => [member.name, member.id]))
    const intent: PurchaseIntent = {
      status: 'READY', merchant: 'Northline Travel', product: 'Montreal Weekend Escape', statedTotalCents: 128_400,
      assignments: [
        { itemId: 'tickets', memberIds: group.members.map((member) => member.id) },
        { itemId: 'upgrade', memberIds: [ids.Jamie!, ids.Alex!] },
        { itemId: 'shuttle', memberIds: [ids.Jamie!, ids.Alex!, ids.Jordan!] },
      ], assumptions: [], questions: [],
    }
    return { group, intent }
  }

  it('rejects malformed model output without storing a proposal', async () => {
    const { group } = await fixture()
    await expect(createAgentProposal(group.group.id, 'Plan the Northline trip', { interpret: async () => ({ status: 'READY', totalCents: '1284' }) })).rejects.toBeInstanceOf(AgentProviderError)
    expect(await db.select().from(aiPurchaseProposals).where(eq(aiPurchaseProposals.groupId, group.group.id))).toHaveLength(0)
  })

  it('rejects model totals that disagree with the fixed receipt', async () => {
    const { group, intent } = await fixture()
    const result = await createAgentProposal(group.group.id, 'Plan the Northline trip', { interpret: async () => ({ ...intent, statedTotalCents: 128_300 }) })
    expect(result).toMatchObject({ status: 'NEEDS_CLARIFICATION', questions: [expect.stringContaining('$1,284.00')] })
    expect(await db.select().from(aiPurchaseProposals).where(eq(aiPurchaseProposals.groupId, group.group.id))).toHaveLength(0)
  })

  it('rejects assignments to participants outside the saved group', async () => {
    const { group, intent } = await fixture()
    const result = await createAgentProposal(group.group.id, 'Plan the Northline trip', { interpret: async () => ({ ...intent, assignments: [{ itemId: 'tickets', memberIds: ['outsider'] }, ...intent.assignments.slice(1)] }) })
    expect(result).toMatchObject({ status: 'NEEDS_CLARIFICATION', questions: [expect.stringContaining('outside this group')] })
    expect(await db.select().from(aiPurchaseProposals).where(eq(aiPurchaseProposals.groupId, group.group.id))).toHaveLength(0)
  })

  it('asks for a correction when the model omits required payers', async () => {
    const { group, intent } = await fixture()
    const onlyThree = intent.assignments.map((assignment) => ({ ...assignment, memberIds: assignment.memberIds.filter((id) => id !== group.members[3]!.id) }))
    const missing = await createAgentProposal(group.group.id, 'Leave Maya out', { interpret: async () => ({ ...intent, assignments: onlyThree }) })
    expect(missing).toMatchObject({ status: 'NEEDS_CLARIFICATION', questions: [expect.stringContaining('Maya')] })
    const onlyMaya = intent.assignments.map((assignment) => ({ ...assignment, memberIds: [group.members[3]!.id] }))
    const conflicting = await createAgentProposal(group.group.id, 'Maya may pay at most $200 but must cover everything', { interpret: async () => ({ ...intent, assignments: onlyMaya }) })
    expect(conflicting).toMatchObject({ status: 'NEEDS_CLARIFICATION', questions: [expect.stringContaining('Jamie, Alex, Jordan')] })
    expect(await db.select().from(aiPurchaseProposals).where(eq(aiPurchaseProposals.groupId, group.group.id))).toHaveLength(0)
  })

  it('does not turn vague fairness wording into an unrequested equal split', async () => {
    const { group, intent } = await fixture()
    const result = await createAgentProposal(group.group.id, 'Book Northline and split everything fairly.', { interpret: async () => intent })
    expect(result.status).toBe('NEEDS_CLARIFICATION')
    expect(await db.select().from(aiPurchaseProposals).where(eq(aiPurchaseProposals.groupId, group.group.id))).toHaveLength(0)
  })

  it('persists a cent-safe four-person proposal, then creates one unapproved checkout on repeated confirmation', async () => {
    const { group, intent } = await fixture()
    const proposal = await createAgentProposal(group.group.id, 'Maya skips the shuttle; Jamie and Alex cover the upgrade; split tickets four ways.', { interpret: async () => intent })
    expect(proposal.status).toBe('READY')
    if (proposal.status !== 'READY') throw new Error('Expected a ready proposal')
    expect(proposal.reconciliation).toEqual({ receiptTotalCents: 128_400, allocatedCents: 128_400, differenceCents: 0 })
    expect(Object.fromEntries(proposal.participants.map((participant) => [participant.name, participant.amountCents]))).toEqual({ Jamie: 35_000, Alex: 35_000, Jordan: 30_000, Maya: 28_400 })
    expect((await getAgentProposal(proposal.id)).checkoutSessionId).toBeNull()
    const [first, second] = await Promise.all([confirmAgentProposal(proposal.id), confirmAgentProposal(proposal.id)])
    expect(first.sessionId).toBe(second.sessionId)
    const saved = await getCheckoutSession(first.sessionId)
    expect(saved.totalCents).toBe(128_400)
    expect(saved.funding).toHaveLength(4)
    expect(saved.funding.every((row) => row.consentStatus === 'pending' && row.fundingStatus === 'not_requested')).toBe(true)
    await expect(ensureIndependentPaymentCommitments(first.sessionId)).rejects.toThrow()
    expect((await getAgentProposal(proposal.id)).checkoutSessionId).toBe(first.sessionId)
    expect(await db.select().from(checkoutSessions).where(eq(checkoutSessions.idempotencyKey, `ai-proposal:${proposal.id}`))).toHaveLength(1)
  })

  it('persists an exact-amount request without reusing the old item split', async () => {
    const { group } = await fixture()
    const proposal = await createAgentProposal(group.group.id, 'Jordan pays three hundred and fifty dollars. Alex pays the same. Maya pays two hundred and eighty-four. Jamie covers the rest.')
    if (proposal.status !== 'READY') throw new Error('Expected exact-amount proposal')
    expect(proposal.directAmounts).toBe(true)
    expect(proposal.assignments).toEqual([])
    expect(Object.fromEntries(proposal.participants.map((person) => [person.name, person.amountCents]))).toEqual({ Jamie: 30_000, Alex: 35_000, Jordan: 35_000, Maya: 28_400 })
    const checkout = await confirmAgentProposal(proposal.id)
    const restored = await getCheckoutSession(checkout.sessionId)
    expect(restored.allocation).toMatchObject({ interpretation: { directAmounts: true, assignments: [] } })
    expect(restored.funding.every((row) => row.consentStatus === 'pending' && row.fundingStatus === 'not_requested')).toBe(true)
  })

  it('edits assignments before checkout, validates cents and membership, and locks the proposal after confirmation', async () => {
    const { group, intent } = await fixture()
    const proposal = await createAgentProposal(group.group.id, 'Split the Northline trip across this group.', { interpret: async () => intent })
    if (proposal.status !== 'READY') throw new Error('Expected a ready proposal')
    const revised = intent.assignments.map((row) => row.itemId === 'upgrade' ? { ...row, memberIds: [group.members[2]!.id, group.members[3]!.id] } : row)
    const saved = await editAgentAllocation(proposal.id, revised)
    expect(saved.reconciliation.differenceCents).toBe(0)
    expect(saved.assignments).toEqual(revised)
    expect((await getAgentProposal(proposal.id)).assignments).toEqual(revised)
    await expect(editAgentAllocation(proposal.id, revised.map((row) => row.itemId === 'tickets' ? { ...row, memberIds: ['outsider'] } : row))).rejects.toThrow('unknown member')
    await expect(editAgentAllocation(proposal.id, revised.map((row) => row.itemId === 'shuttle' ? { ...row, memberIds: [] } : row))).rejects.toThrow()
    await confirmAgentProposal(proposal.id)
    await expect(editAgentAllocation(proposal.id, intent.assignments)).rejects.toThrow('already has a checkout')
    expect((await getAgentProposal(proposal.id)).assignments).toEqual(revised)
  })
})
