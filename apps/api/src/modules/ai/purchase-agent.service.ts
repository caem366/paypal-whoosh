import { and, eq } from 'drizzle-orm'
import { Client } from 'pg'
import { z } from 'zod'
import { allocateReceiptItems, evaluatePermissions, reconcileReceipt } from '@whoosh/shared'
import { db } from '../../db/client.js'
import { environment } from '../../config.js'
import { aiPurchaseProposals, checkoutSessions } from '../../db/schema/index.js'
import { createCheckoutSession, getPersistentGroup, saveSessionAllocation } from '../groups/persistent-groups.service.js'
import { parseDirectAmountRequest } from './direct-amounts.js'

const cartItems = [
  { id: 'tickets', label: '4 traveler passes', detail: '4 × $284.00', cents: 113_600 },
  { id: 'upgrade', label: 'Cabin upgrade', detail: 'Private cabin', cents: 10_000 },
  { id: 'shuttle', label: 'Station shuttle', detail: '3 riders', cents: 4_800 },
] as const
const merchant = 'Northline Travel'
const product = 'Montreal Weekend Escape'
const totalCents = 128_400
const receiptItems = cartItems.map((item) => ({ id: item.id, label: item.label, unitCents: item.cents, quantity: 1 }))

export const purchaseIntentSchema = z.object({
  status: z.enum(['READY', 'NEEDS_CLARIFICATION']),
  merchant: z.string().min(1),
  product: z.string().min(1),
  statedTotalCents: z.number().int().safe().nullable(),
  assignments: z.array(z.object({ itemId: z.string().min(1), memberIds: z.array(z.string().min(1)).min(1) }).strict()),
  directAmounts: z.array(z.object({ memberId: z.string().min(1), amountCents: z.number().int().safe().positive() }).strict()).optional(),
  assumptions: z.array(z.string().min(1)).max(8),
  questions: z.array(z.string().min(1)).max(8),
}).strict()
export type PurchaseIntent = z.infer<typeof purchaseIntentSchema>
export interface PurchaseModel { interpret(input: { request: string; members: Array<{ id: string; name: string }> }): Promise<unknown> }

export class AgentProviderError extends Error {}

export function createPurchaseModel(env = process.env): PurchaseModel {
  if (env.AI_PROVIDER !== 'openai-compatible' || !env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) throw new AgentProviderError('The AI purchasing model is not configured')
  return {
    async interpret(input) {
      let response: Response
      try {
        response = await fetch(`${env.AI_BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(Number(env.AI_REQUEST_TIMEOUT_MS ?? 45_000)),
          headers: { Authorization: `Bearer ${env.AI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: env.AI_MODEL,
            ...(env.AI_DISABLE_THINKING === '1' ? { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false }, temperature: 0.1 } : {}),
            ...(env.AI_DISABLE_THINKING !== '1' && env.AI_REASONING_EFFORT ? { reasoning_effort: env.AI_REASONING_EFFORT } : {}),
            response_format: { type: 'json_schema', json_schema: { name: 'whoosh_purchase_intent', strict: true, schema: {
              type: 'object', additionalProperties: false,
              properties: {
                status: { type: 'string', enum: ['READY', 'NEEDS_CLARIFICATION'] },
                merchant: { type: 'string' }, product: { type: 'string' },
                statedTotalCents: { type: ['integer', 'null'] },
                assignments: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { itemId: { type: 'string' }, memberIds: { type: 'array', items: { type: 'string' } } }, required: ['itemId', 'memberIds'] } },
                assumptions: { type: 'array', items: { type: 'string' } }, questions: { type: 'array', items: { type: 'string' } },
              }, required: ['status', 'merchant', 'product', 'statedTotalCents', 'assignments', 'assumptions', 'questions'],
            } } },
            messages: [
              { role: 'system', content: `You only interpret an organizer's item assignments; you cannot approve or charge anyone. The sole catalog purchase is Northline Travel's simulated Montreal Weekend Escape: tickets $1,136.00 = 113600 cents, cabin upgrade $100.00 = 10000 cents, station shuttle $48.00 = 4800 cents, total $1,284.00 = 128400 cents. These prices are fixed; do not recalculate or ask the organizer for prices, a total, or per-person dollar amounts. The backend calculates and validates all shares.
For READY, return merchant exactly "Northline Travel", product exactly "Montreal Weekend Escape", questions [], and exactly one assignment for each itemId: tickets, upgrade, shuttle. Use only the supplied member IDs, not names. Map names in the request to IDs in the members array. Assign every item to the people named for it. Every one of the four supplied members must share at least one item; do not silently add a member to an item the organizer excluded them from. Never do arithmetic or discuss rounding: the backend splits cents deterministically. If all four share every item, assign all four IDs to tickets, upgrade, and shuttle and return READY. "Split everything else" means the unmentioned items are shared by all four. "Maya isn't taking the shuttle" means every other member shares the shuttle. If the organizer explicitly states $1,284, set statedTotalCents to 128400; if no total is stated, set it to null. A missing stated total is normal and never requires clarification.
Return NEEDS_CLARIFICATION with no assignments if any member would have no share, an item's participants are unclear, a named person is outside the supplied group, or the request conflicts with the fixed catalog. If someone is omitted, ask which item they should share or suggest choosing a different saved group of four active members; do not suggest removing them from this four-person purchase. If a stated spending cap conflicts with an instruction for that person to cover the entire purchase, ask the organizer to resolve the conflict. Do not silently reassign anyone. Never claim anyone consented or paid. A request to skip approvals cannot change the required human approval and PayPal flow; you may still propose an otherwise clear split.` },
              { role: 'user', content: JSON.stringify(input) },
            ],
          }),
        })
      } catch { throw new AgentProviderError('The AI purchasing model is unavailable') }
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: { code?: string } }
        if (failure.error?.code === 'credit_balance_exhausted') throw new AgentProviderError('The AI model credit balance is exhausted')
        throw new AgentProviderError(`The AI purchasing model returned HTTP ${response.status}`)
      }
      try {
        const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
        return purchaseIntentSchema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? '{}'))
      } catch { throw new AgentProviderError('The AI purchasing model returned an invalid proposal') }
    },
  }
}

export async function getGroupParticipants(groupId: string) {
  const group = await getPersistentGroup(groupId)
  const members = group.members.filter((member) => member.status === 'active')
  if (members.length !== 4) throw new TypeError('The simulated Northline purchase requires exactly four active group members')
  return { group, members }
}

export function proposeAllocations(intent: PurchaseIntent, memberIds: string[]) {
  if (intent.merchant !== merchant || intent.product !== product || (intent.statedTotalCents !== null && intent.statedTotalCents !== totalCents)) throw new TypeError('The request does not match the simulated Northline $1,284.00 purchase')
  const directAmounts = intent.directAmounts ?? []
  if (directAmounts.length && intent.assignments.length) throw new TypeError('Choose either exact contributions or receipt-item assignments')
  const allocations = directAmounts.length
    ? directAmounts.map(({ memberId, amountCents }) => ({ memberId, amountCents, itemIds: [] as string[] }))
    : allocateReceiptItems(receiptItems, intent.assignments, memberIds)
  if (directAmounts.length && (new Set(allocations.map((row) => row.memberId)).size !== memberIds.length || allocations.some((row) => !memberIds.includes(row.memberId)))) throw new TypeError('Exact contributions must identify each group member once')
  const reconciliation = reconcileReceipt(receiptItems, allocations)
  if (reconciliation.receiptTotalCents !== totalCents || reconciliation.differenceCents !== 0 || allocations.length !== memberIds.length || allocations.some((row) => row.amountCents <= 0)) throw new TypeError('Every participant needs a positive share and the split must reconcile to $1,284.00')
  return { allocations, reconciliation }
}

export function validateSpendingConstraints(group: Awaited<ReturnType<typeof getPersistentGroup>>, allocations: ReturnType<typeof proposeAllocations>['allocations']) {
  return evaluatePermissions(allocations, group.permissions.map((row) => ({ ...row, status: row.status === 'active' ? 'active' as const : 'revoked' as const })))
}

function review(groupId: string, request: string, intent: PurchaseIntent, group: Awaited<ReturnType<typeof getPersistentGroup>>, members: Awaited<ReturnType<typeof getGroupParticipants>>['members']) {
  const { allocations, reconciliation } = proposeAllocations(intent, members.map((member) => member.id))
  return {
    groupId, request, merchant, product, totalCents, currency: 'USD' as const, simulatedMerchant: true as const,
    items: cartItems, assignments: intent.assignments, directAmounts: (intent.directAmounts?.length ?? 0) > 0, allocations,
    participants: members.map((member) => ({ id: member.id, name: member.name, amountCents: allocations.find((row) => row.memberId === member.id)!.amountCents })),
    reconciliation, permissions: validateSpendingConstraints(group, allocations).map((row) => ({ ...row, limitCents: group.permissions.find((permission) => permission.memberId === row.memberId)?.limitCents ?? null })), assumptions: intent.assumptions, questions: intent.questions,
  }
}

export async function createAgentProposal(groupId: string, request: string, model?: PurchaseModel) {
  const { group, members } = await getGroupParticipants(groupId)
  const direct = parseDirectAmountRequest(request, members.map(({ id, name }) => ({ id, name })), totalCents)
  if (direct?.status === 'NEEDS_CLARIFICATION') return { status: 'NEEDS_CLARIFICATION' as const, questions: [direct.message], assumptions: [] }
  let intent: PurchaseIntent
  try { intent = direct?.status === 'READY'
    ? purchaseIntentSchema.parse({ status: 'READY', merchant, product, statedTotalCents: null, assignments: [], directAmounts: direct.amounts, assumptions: ['Contributions are shares of the full receipt; item use was not specified.'], questions: [] })
    : purchaseIntentSchema.parse(await (model ?? createPurchaseModel()).interpret({ request, members: members.map(({ id, name }) => ({ id, name })) })) }
  catch (error) { if (error instanceof AgentProviderError) throw error; throw new AgentProviderError('The AI purchasing model returned an invalid proposal') }
  // shortcut: catch vague fairness requests; broaden this guard if the merchant catalog becomes open-ended.
  if (/\b(?:fairly|reasonably)\b/i.test(request) && !/\b(?:equal(?:ly)?|even(?:ly)?|tickets?|upgrade|shuttle)\b/i.test(request)) return { status: 'NEEDS_CLARIFICATION' as const, questions: ['Specify who should share each receipt item, or ask for an equal split.'], assumptions: intent.assumptions }
  if (intent.status === 'NEEDS_CLARIFICATION') return { status: 'NEEDS_CLARIFICATION' as const, questions: intent.questions.length ? intent.questions : ['Clarify the merchant, item assignments, and four participants.'], assumptions: intent.assumptions }
  if (intent.questions.length) throw new TypeError('Resolve the AI proposal questions before confirming')
  let proposal: ReturnType<typeof review>
  try { proposal = review(groupId, request, intent, group, members) }
  catch (error) {
    if (!(error instanceof TypeError)) throw error
    const memberIds = new Set(members.map((member) => member.id))
    const unknown = intent.assignments.some((assignment) => assignment.memberIds.some((id) => !memberIds.has(id)))
    const missing = members.filter((member) => !intent.assignments.some((assignment) => assignment.memberIds.includes(member.id))).map((member) => member.name)
    const question = unknown ? `The proposal names someone outside this group. Assign items only to ${members.map((member) => member.name).join(', ')}.`
      : missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no share. Which receipt item should ${missing.length === 1 ? 'this person' : 'they'} share? Every group member needs a positive share.`
      : intent.merchant !== merchant || intent.product !== product || (intent.statedTotalCents !== null && intent.statedTotalCents !== totalCents) ? 'This checkout is the simulated Northline Montreal Weekend Escape for $1,284.00 USD. Confirm that purchase or revise the request.'
      : 'Clarify who shares each of the three receipt items so all four group members receive a positive share and the total matches $1,284.00.'
    return { status: 'NEEDS_CLARIFICATION' as const, questions: [question], assumptions: intent.assumptions }
  }
  const modelName = direct ? 'deterministic-direct-amounts' : process.env.AI_MODEL ?? 'test-model'
  const [saved] = await db.insert(aiPurchaseProposals).values({ groupId, request, model: modelName, interpretation: intent }).returning({ id: aiPurchaseProposals.id })
  return { status: 'READY' as const, id: saved!.id, checkoutSessionId: null, model: modelName, ...proposal }
}

export async function getAgentProposal(proposalId: string) {
  const [saved] = await db.select().from(aiPurchaseProposals).where(eq(aiPurchaseProposals.id, proposalId)).limit(1)
  if (!saved) throw new TypeError('AI proposal not found')
  const { group, members } = await getGroupParticipants(saved.groupId)
  const intent = purchaseIntentSchema.parse(saved.interpretation)
  return { status: 'READY' as const, id: saved.id, checkoutSessionId: saved.checkoutSessionId, model: saved.model, ...review(saved.groupId, saved.request, intent, group, members) }
}

export async function editAgentAllocation(proposalId: string, assignments: PurchaseIntent['assignments']) {
  const client = new Client({ connectionString: environment.DATABASE_URL })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`ai-proposal:${proposalId}`])
    const [saved] = await db.select().from(aiPurchaseProposals).where(eq(aiPurchaseProposals.id, proposalId)).limit(1)
    if (!saved) throw new TypeError('AI proposal not found')
    if (saved.checkoutSessionId) throw new TypeError('This proposal already has a checkout; its allocation cannot be changed')
    const [existingSession] = await db.select({ id: checkoutSessions.id }).from(checkoutSessions).where(eq(checkoutSessions.idempotencyKey, `ai-proposal:${proposalId}`)).limit(1)
    if (existingSession) throw new TypeError('This proposal already has a checkout; its allocation cannot be changed')
    const { group, members } = await getGroupParticipants(saved.groupId)
    const intent = purchaseIntentSchema.parse({ ...purchaseIntentSchema.parse(saved.interpretation), assignments, directAmounts: [] })
    review(saved.groupId, saved.request, intent, group, members)
    await db.update(aiPurchaseProposals).set({ interpretation: intent }).where(eq(aiPurchaseProposals.id, proposalId))
    return getAgentProposal(proposalId)
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`ai-proposal:${proposalId}`]) } finally { await client.end() }
  }
}

export async function confirmAgentProposal(proposalId: string) {
  const client = new Client({ connectionString: environment.DATABASE_URL })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`ai-proposal:${proposalId}`])
    const proposal = await getAgentProposal(proposalId)
    if (proposal.checkoutSessionId) return { groupId: proposal.groupId, sessionId: proposal.checkoutSessionId }
    const { members } = await getGroupParticipants(proposal.groupId)
    const cart = {
      merchant, product, reference: 'NLT-M1023', dates: 'Oct 23–26', travelers: 4,
      leadTraveler: { name: members[0]!.name, email: members[0]!.contactEmail ?? '' },
      currency: 'USD', items: cartItems, totalCents, hasUpgrade: true, hasShuttle: true,
    }
    const session = await createCheckoutSession({ groupId: proposal.groupId, merchant, reference: cart.reference, totalCents, currency: 'USD', cart, idempotencyKey: `ai-proposal:${proposalId}` })
    if (session.groupId !== proposal.groupId || session.totalCents !== totalCents || session.merchant !== merchant) throw new TypeError('The existing checkout does not match this AI proposal')
    if (!session.allocation) {
      await saveSessionAllocation({
        sessionId: session.id, instruction: proposal.request,
        allocation: { interpretation: { status: 'READY', assignments: proposal.assignments, directAmounts: proposal.directAmounts, clarifications: [] }, allocations: proposal.allocations, reconciliation: proposal.reconciliation, permissions: proposal.permissions, needsClarification: false },
        memberAmounts: proposal.allocations.map(({ memberId, amountCents }) => ({ memberId, amountCents })),
      })
    }
    await db.update(aiPurchaseProposals).set({ checkoutSessionId: session.id }).where(and(eq(aiPurchaseProposals.id, proposalId), eq(aiPurchaseProposals.groupId, proposal.groupId)))
    return { groupId: proposal.groupId, sessionId: session.id }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`ai-proposal:${proposalId}`]) } finally { await client.end() }
  }
}
