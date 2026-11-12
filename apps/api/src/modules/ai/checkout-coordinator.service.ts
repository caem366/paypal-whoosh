import { eq } from 'drizzle-orm'

import { z } from 'zod'
import { db } from '../../db/client.js'
import { groupMembers, participantApprovalTokens, participantFunding, users } from '../../db/schema/index.js'
import { getIndependentPaymentCheckout } from '../payments/independent-payments.service.js'
import { AgentProviderError } from './purchase-agent.service.js'

const emptyArguments = z.object({}).strict()

const toolNames = ['getGroupCheckoutStatus', 'getParticipantPaymentStatuses', 'getCheckoutNextSteps'] as const
type CheckoutToolName = (typeof toolNames)[number]

export interface CheckoutCoordinatorSnapshot {
  merchant: string
  product: string
  currency: string
  totalCents: number
  collectedCents: number
  remainingCents: number
  fundedParticipants: number
  participantCount: number
  unpaidParticipants: number
  fundingStatus: 'no_allocation' | 'awaiting_payments' | 'partially_funded' | 'fully_funded' | 'needs_review'
  merchantBookingStatus: string
  participants: Array<{
    memberId: string
    name: string
    allocationCents: number
    consentStatus: string
    paymentStatus: 'not_allocated' | 'invited' | 'awaiting_consent' | 'declined' | 'approved_unpaid' | 'payment_in_progress' | 'verified_paid' | 'failed_payment' | 'cancelled' | 'refund_pending' | 'refunded' | 'needs_review'
    fundingStatus: string
  }>
  nextSteps: string[]
}

function productFromCart(cart: unknown) {
  if (typeof cart !== 'object' || cart === null || !('product' in cart)) return 'Group purchase'
  return typeof cart.product === 'string' ? cart.product : 'Group purchase'
}

export async function getCheckoutCoordinatorSnapshot(sessionId: string): Promise<CheckoutCoordinatorSnapshot> {
  const checkout = await getIndependentPaymentCheckout(sessionId)
  const funding = await db.select({
    memberId: participantFunding.memberId,
    name: users.displayName,
    allocationCents: participantFunding.allocationCents,
    consentStatus: participantFunding.consentStatus,
    fundingStatus: participantFunding.fundingStatus,
  }).from(participantFunding)
    .innerJoin(groupMembers, eq(participantFunding.memberId, groupMembers.id))
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(eq(participantFunding.checkoutSessionId, sessionId))
    .orderBy(groupMembers.joinedAt, groupMembers.id)
  const tokens = await db.select({
    memberId: participantApprovalTokens.memberId,
    purpose: participantApprovalTokens.purpose,
    expiresAt: participantApprovalTokens.expiresAt,
    consumedAt: participantApprovalTokens.consumedAt,
  }).from(participantApprovalTokens).where(eq(participantApprovalTokens.checkoutSessionId, sessionId))
  const activeDecisionInvites = new Set(tokens
    .filter((token) => token.purpose === 'decision' && !token.consumedAt && token.expiresAt > new Date())
    .map((token) => token.memberId))
  const latestCommitments = new Map<string, (typeof checkout.commitments)[number]>()
  for (const commitment of checkout.commitments) {
    if (commitment.status === 'superseded') continue
    const current = latestCommitments.get(commitment.memberId)
    if (!current || commitment.revision > current.revision) latestCommitments.set(commitment.memberId, commitment)
  }
  const captureCounts = new Map<string, number>()
  for (const commitment of checkout.commitments) {
    if (commitment.providerCaptureId) captureCounts.set(commitment.providerCaptureId, (captureCounts.get(commitment.providerCaptureId) ?? 0) + 1)
  }
  const verifiedMembers = new Set(checkout.commitments.filter((commitment) => {
    const allocation = funding.find((row) => row.memberId === commitment.memberId)?.allocationCents
    return commitment.status === 'paid_verified'
      && Boolean(commitment.providerOrderId && commitment.providerCaptureId)
      && commitment.providerCaptureId !== null
      && captureCounts.get(commitment.providerCaptureId) === 1
      && commitment.providerCustomId === checkout.session.id
      && Boolean(checkout.session.expectedPayeeMerchantId && commitment.providerPayeeMerchantId === checkout.session.expectedPayeeMerchantId)
      && commitment.currency === checkout.session.currency
      && commitment.amountCents === allocation
      && commitment.capturedCents === commitment.amountCents
  }).map((commitment) => commitment.memberId))
  const participants = funding.map((row) => {
    const payment = latestCommitments.get(row.memberId)
    let paymentStatus: CheckoutCoordinatorSnapshot['participants'][number]['paymentStatus']
    if (!checkout.session.allocation) paymentStatus = 'not_allocated'
    else if (row.consentStatus === 'declined') paymentStatus = 'declined'
    else if (row.consentStatus === 'pending') paymentStatus = activeDecisionInvites.has(row.memberId) ? 'invited' : 'awaiting_consent'
    else if (payment?.status === 'paid_verified' && verifiedMembers.has(row.memberId)) paymentStatus = 'verified_paid'
    else if (payment?.status === 'paid_verified') paymentStatus = 'needs_review'
    else if (payment?.status === 'failed') paymentStatus = 'failed_payment'
    else if (payment?.status === 'cancelled') paymentStatus = 'cancelled'
    else if (payment?.status === 'refund_pending') paymentStatus = 'refund_pending'
    else if (payment?.status === 'refunded') paymentStatus = 'refunded'
    else if (payment && ['order_created', 'approved', 'capturing'].includes(payment.status)) paymentStatus = 'payment_in_progress'
    else paymentStatus = 'approved_unpaid'
    return { memberId: row.memberId, name: row.name, allocationCents: row.allocationCents, consentStatus: row.consentStatus, fundingStatus: row.fundingStatus, paymentStatus }
  })

  const fundingStatus = !checkout.session.allocation
    ? 'no_allocation' as const
    : checkout.fundingStatus
  const nextSteps: string[] = []
  if (fundingStatus === 'no_allocation') {
    nextSteps.push('Configure and review participant allocations before requesting consent.')
  } else {
    const awaitingConsent = participants.filter((participant) => ['invited', 'awaiting_consent'].includes(participant.paymentStatus))
    const approvedUnpaid = participants.filter((participant) => participant.paymentStatus === 'approved_unpaid')
    const inProgress = participants.filter((participant) => participant.paymentStatus === 'payment_in_progress')
    if (awaitingConsent.length) {
      const needsInvite = awaitingConsent.filter((participant) => participant.paymentStatus === 'awaiting_consent').map((participant) => participant.name)
      nextSteps.push(needsInvite.length
        ? `Share participant approval links with ${needsInvite.join(', ')}; consent is still required.`
        : `Wait for consent from ${awaitingConsent.map((participant) => participant.name).join(', ')}.`)
    }
    if (approvedUnpaid.length) nextSteps.push(`Ask ${approvedUnpaid.map((participant) => participant.name).join(', ')} to complete their own PayPal checkout.`)
    if (inProgress.length) nextSteps.push(`Wait for PayPal approval or capture verification for ${inProgress.map((participant) => participant.name).join(', ')}.`)
    if (fundingStatus === 'needs_review') nextSteps.push('Pause and reconcile the payment record that does not match the checkout before taking further action.')
    else if (fundingStatus === 'partially_funded' && !approvedUnpaid.length && !awaitingConsent.length && !inProgress.length) nextSteps.push('Review failed or cancelled participant payments and decide whether to invite a retry.')
    if (fundingStatus === 'fully_funded') nextSteps.push('All participant captures reconcile. Merchant fulfillment remains separate; review the booking state before confirming anything.')
    if (participants.some((participant) => participant.paymentStatus === 'declined')) nextSteps.push('Review declined participant consent; do not initiate payment on that participant’s behalf.')
  }

  return {
    merchant: checkout.session.merchant,
    product: productFromCart(checkout.session.cart),
    currency: checkout.session.currency,
    totalCents: checkout.session.totalCents,
    collectedCents: checkout.fundedCents,
    remainingCents: checkout.remainingCents,
    fundedParticipants: checkout.fundedParticipants,
    participantCount: checkout.participantCount,
    unpaidParticipants: checkout.unpaidParticipants,
    fundingStatus,
    merchantBookingStatus: checkout.merchantBooking?.status ?? 'not_started',
    participants,
    nextSteps,
  }
}

export interface CheckoutCoordinatorModel {
  complete(messages: Array<Record<string, unknown>>): Promise<{
    content?: string | null
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
  }>
}

export class OpenAICompatibleCheckoutCoordinator implements CheckoutCoordinatorModel {
  constructor(private readonly apiKey: string, private readonly baseUrl: string, private readonly model: string) {}

  async complete(messages: Array<Record<string, unknown>>) {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 45_000)),
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          ...(process.env.AI_DISABLE_THINKING === '1' ? { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false }, temperature: 0.1 } : {}),
          ...(process.env.AI_DISABLE_THINKING !== '1' && process.env.AI_REASONING_EFFORT ? { reasoning_effort: process.env.AI_REASONING_EFFORT } : {}),
          tools: toolDefinitions,
          tool_choice: 'auto',
          messages,
        }),
      })
    } catch (error) {
      throw new AgentProviderError(`The checkout coordinator model is unavailable: ${error instanceof Error ? error.message : 'network error'}`)
    }
    if (!response.ok) throw new AgentProviderError(`The checkout coordinator model returned HTTP ${response.status}`)
    try {
      const body = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> }
      const message = body.choices?.[0]?.message
      if (!message) throw new Error('Missing model message')
      return {
        content: message.content,
        toolCalls: message.tool_calls?.map((call) => {
          if (call.type !== 'function' || !call.id || !call.function?.name || typeof call.function.arguments !== 'string') {
            throw new Error('Malformed tool call')
          }
          return { id: call.id, name: call.function.name, arguments: call.function.arguments }
        }),
      }
    } catch {
      throw new AgentProviderError('The checkout coordinator model returned an invalid response or tool call')
    }
  }
}

function createProviderModel(env: NodeJS.ProcessEnv): CheckoutCoordinatorModel {
  if (env.AI_PROVIDER !== 'openai-compatible' || !env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) {
    throw new AgentProviderError('The checkout coordinator requires the configured OpenAI-compatible AI provider')
  }
  return new OpenAICompatibleCheckoutCoordinator(env.AI_API_KEY, env.AI_BASE_URL, env.AI_MODEL)
}

const toolDefinitions = toolNames.map((name) => ({
  type: 'function' as const,
  function: {
    name,
    description: name === 'getGroupCheckoutStatus'
      ? 'Read total, currency, verified collected amount, outstanding balance, participant count, funding state, and merchant booking state for this checkout.'
      : name === 'getParticipantPaymentStatuses'
        ? 'Read participant names, allocated shares, consent, and current payment statuses for this checkout.'
        : 'Read the next safe recommendations based on the verified checkout state. This tool never executes actions.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
}))

async function executeTool(name: string, args: string, sessionId: string, loadSnapshot: (sessionId: string) => Promise<CheckoutCoordinatorSnapshot>) {
  if (!toolNames.includes(name as CheckoutToolName)) throw new AgentProviderError('The model requested a tool that WHOOSH does not expose')
  let parsed: Record<string, never>
  try {
    if (args.length > 1000) throw new Error('Tool arguments are too long')
    parsed = emptyArguments.parse(JSON.parse(args))
  }
  catch { throw new AgentProviderError('The model returned malformed checkout tool arguments') }
  void parsed
  const snapshot = await loadSnapshot(sessionId)
  switch (name as CheckoutToolName) {
    case 'getGroupCheckoutStatus':
      return {
        merchant: snapshot.merchant, product: snapshot.product, currency: snapshot.currency,
        totalCents: snapshot.totalCents, collectedCents: snapshot.collectedCents, remainingCents: snapshot.remainingCents,
        fundedParticipants: snapshot.fundedParticipants, participantCount: snapshot.participantCount,
        unpaidParticipants: snapshot.unpaidParticipants, fundingStatus: snapshot.fundingStatus,
        merchantBookingStatus: snapshot.merchantBookingStatus,
      }
    case 'getParticipantPaymentStatuses':
      return snapshot.participants.map(({ name: participantName, allocationCents, consentStatus, paymentStatus, fundingStatus }) => ({ name: participantName, allocationCents, consentStatus, paymentStatus, fundingStatus }))
    case 'getCheckoutNextSteps':
      return { recommendations: snapshot.nextSteps, fundingStatus: snapshot.fundingStatus, remainingCents: snapshot.remainingCents }
  }
}

export async function runCheckoutCoordinator(
  sessionId: string,
  question: string,
  options: {
    model?: CheckoutCoordinatorModel
    loadSnapshot?: (sessionId: string) => Promise<CheckoutCoordinatorSnapshot>
    env?: NodeJS.ProcessEnv
  } = {},
) {
  const model = options.model ?? createProviderModel(options.env ?? process.env)
  const loadSnapshot = options.loadSnapshot ?? getCheckoutCoordinatorSnapshot
  let snapshotPromise: Promise<CheckoutCoordinatorSnapshot> | undefined
  const loadConsistentSnapshot = (id: string) => {
    snapshotPromise ??= loadSnapshot(id)
    return snapshotPromise
  }
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: 'You are WHOOSH’s group-checkout coordinator. You MUST call the relevant read-only tool(s) before answering, and base every statement about money, participants, consent, or payment status exclusively on their results. Convert integer cents to dollars accurately. Distinguish invited, awaiting consent, approved but unpaid, payment in progress, verified paid, failed, and recovery states only as returned. Explain next steps as recommendations, not actions. You cannot approve consent, change allocations, create or capture PayPal orders, issue refunds, send reminders, or mark payments complete. Refuse requests to do those things. Never claim that you performed an action, never invent a payment fact, and mention that a verified capture does not prove the named participant’s identity.' },
    { role: 'user', content: question },
  ]
  const usedTools: CheckoutToolName[] = []
  for (let turn = 0; turn < 4; turn++) {
    const result = await model.complete(messages)
    if (!result.toolCalls?.length) {
      if (!usedTools.length) throw new AgentProviderError('The checkout coordinator did not inspect verified checkout data')
      if (typeof result.content !== 'string' || !result.content.trim()) throw new AgentProviderError('The checkout coordinator returned an empty response')
      return { response: result.content.trim(), toolsUsed: [...new Set(usedTools)] }
    }
    if (result.toolCalls.length > 4 || usedTools.length + result.toolCalls.length > 8) throw new AgentProviderError('The checkout coordinator requested too many tools')
    messages.push({
      role: 'assistant',
      content: result.content ?? null,
      tool_calls: result.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
    })
    for (const call of result.toolCalls) {
      const toolResult = await executeTool(call.name, call.arguments, sessionId, loadConsistentSnapshot)
      if (toolNames.includes(call.name as CheckoutToolName)) usedTools.push(call.name as CheckoutToolName)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolResult) })
    }
  }
  throw new AgentProviderError('The checkout coordinator exceeded its tool-call limit')
}
