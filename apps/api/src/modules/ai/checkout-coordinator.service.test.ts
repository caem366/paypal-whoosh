import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OpenAICompatibleCheckoutCoordinator,
  runCheckoutCoordinator,
  type CheckoutCoordinatorModel,
  type CheckoutCoordinatorSnapshot,
} from './checkout-coordinator.service.js'
import { AgentProviderError } from './purchase-agent.service.js'

const sessionId = 'c4f7dc9e-6f7a-4b54-a65f-3147888fdf10'
const snapshot: CheckoutCoordinatorSnapshot = {
  merchant: 'Northline Travel',
  product: 'Montreal Weekend Escape',
  currency: 'USD',
  totalCents: 128_400,
  collectedCents: 35_000,
  remainingCents: 93_400,
  fundedParticipants: 1,
  participantCount: 4,
  unpaidParticipants: 3,
  fundingStatus: 'partially_funded',
  merchantBookingStatus: 'not_started',
  participants: [
    { memberId: 'jordan', name: 'Jordan Bell', allocationCents: 35_000, consentStatus: 'consented', paymentStatus: 'verified_paid', fundingStatus: 'verified' },
    { memberId: 'avery', name: 'Avery Chen', allocationCents: 35_000, consentStatus: 'consented', paymentStatus: 'payment_in_progress', fundingStatus: 'not_requested' },
    { memberId: 'morgan', name: 'Morgan Rivera', allocationCents: 28_400, consentStatus: 'pending', paymentStatus: 'invited', fundingStatus: 'not_requested' },
    { memberId: 'sam', name: 'Sam Patel', allocationCents: 30_000, consentStatus: 'consented', paymentStatus: 'failed_payment', fundingStatus: 'failed' },
  ],
  nextSteps: ['Wait for Avery’s PayPal payment to verify.', 'Wait for Morgan Rivera’s consent.'],
}

class SelectingModel implements CheckoutCoordinatorModel {
  readonly toolResults: unknown[] = []
  calls = 0
  constructor(private readonly request: { id: string; name: string; arguments: string }[]) {}

  async complete(messages: Array<Record<string, unknown>>) {
    this.calls++
    if (this.calls === 1) return { toolCalls: this.request }
    this.toolResults.push(...messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(String(message.content))))
    return { content: 'Jordan’s $350 payment is verified. The group has collected $350 of $1,284, leaving $934 outstanding.' }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('read-only checkout coordinator', () => {
  it('lets the model select status and participant tools and answers from their backend results', async () => {
    const model = new SelectingModel([
      { id: 'tool-status', name: 'getGroupCheckoutStatus', arguments: '{}' },
      { id: 'tool-participants', name: 'getParticipantPaymentStatuses', arguments: '{}' },
      { id: 'tool-next', name: 'getCheckoutNextSteps', arguments: '{}' },
    ])
    const loaded: string[] = []
    const result = await runCheckoutCoordinator(sessionId, 'Who has paid and what should I do next?', {
      model,
      loadSnapshot: async (id) => { loaded.push(id); return snapshot },
    })
    expect(result.toolsUsed).toEqual(['getGroupCheckoutStatus', 'getParticipantPaymentStatuses', 'getCheckoutNextSteps'])
    expect(result.response).toContain('Jordan’s $350 payment')
    expect(loaded).toEqual([sessionId])
    expect(model.toolResults).toHaveLength(3)
    expect(model.toolResults[0]).toMatchObject({ totalCents: 128_400, collectedCents: 35_000, remainingCents: 93_400, fundingStatus: 'partially_funded' })
    expect(model.toolResults[1]).toEqual(snapshot.participants.map(({ name, allocationCents, consentStatus, paymentStatus, fundingStatus }) => ({ name, allocationCents, consentStatus, paymentStatus, fundingStatus })))
    expect(model.toolResults[2]).toMatchObject({ remainingCents: 93_400 })
  })

  it('requires at least one actual tool call before returning an answer', async () => {
    const model: CheckoutCoordinatorModel = { complete: async () => ({ content: 'Jordan has paid.' }) }
    await expect(runCheckoutCoordinator(sessionId, 'Who paid?', { model })).rejects.toThrow('did not inspect verified')
  })

  it('rejects malformed or cross-session tool arguments without loading any checkout', async () => {
    const model = new SelectingModel([{ id: 'tool-status', name: 'getGroupCheckoutStatus', arguments: '{"sessionId":"another-session"}' }])
    const loadSnapshot = vi.fn(async () => snapshot)
    await expect(runCheckoutCoordinator(sessionId, 'How much is left?', { model, loadSnapshot })).rejects.toThrow('malformed checkout tool arguments')
    expect(loadSnapshot).not.toHaveBeenCalled()
  })

  it('does not answer for a checkout the backend cannot resolve', async () => {
    const model = new SelectingModel([{ id: 'tool-status', name: 'getGroupCheckoutStatus', arguments: '{}' }])
    await expect(runCheckoutCoordinator(sessionId, 'How much is left?', {
      model,
      loadSnapshot: async () => { throw new TypeError('Checkout session not found') },
    })).rejects.toThrow('Checkout session not found')
  })

  it('does not expose payment actions as tools and rejects fabricated action requests', async () => {
    const model = new SelectingModel([{ id: 'capture', name: 'capturePayPalOrder', arguments: '{}' }])
    const loadSnapshot = vi.fn(async () => snapshot)
    await expect(runCheckoutCoordinator(sessionId, 'Capture the unpaid shares now.', { model, loadSnapshot })).rejects.toThrow('does not expose')
    expect(loadSnapshot).not.toHaveBeenCalled()
  })

  it('reports fully funded only when the current backend tool result says every share is verified', async () => {
    const full: CheckoutCoordinatorSnapshot = {
      ...snapshot,
      collectedCents: 128_400,
      remainingCents: 0,
      fundedParticipants: 4,
      unpaidParticipants: 0,
      fundingStatus: 'fully_funded',
      participants: snapshot.participants.map((participant) => ({ ...participant, paymentStatus: 'verified_paid', fundingStatus: 'verified' })),
      nextSteps: ['All participant captures reconcile. Merchant fulfillment remains separate.'],
    }
    const model = new SelectingModel([{ id: 'tool-status', name: 'getGroupCheckoutStatus', arguments: '{}' }])
    const result = await runCheckoutCoordinator(sessionId, 'Is everyone finished paying?', { model, loadSnapshot: async () => full })
    expect(model.toolResults[0]).toMatchObject({ collectedCents: 128_400, remainingCents: 0, fundingStatus: 'fully_funded' })
    expect(result.toolsUsed).toEqual(['getGroupCheckoutStatus'])
  })

  it('surfaces provider failures instead of substituting a made-up checkout result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })))
    const model = new OpenAICompatibleCheckoutCoordinator('test-key', 'https://api.example.test/v1', 'test-model')
    await expect(model.complete([{ role: 'user', content: 'Check status' }])).rejects.toBeInstanceOf(AgentProviderError)
  })

  it('sends actual tool definitions and consumes provider tool calls and tool results', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'getGroupCheckoutStatus', arguments: '{}' } },
        { id: 'call-2', type: 'function', function: { name: 'getParticipantPaymentStatuses', arguments: '{}' } },
      ] } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Jordan is the only verified payer; $934 remains.' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const result = await runCheckoutCoordinator(sessionId, 'Who has paid so far?', {
      model: new OpenAICompatibleCheckoutCoordinator('test-key', 'https://api.example.test/v1', 'test-model'),
      loadSnapshot: async () => snapshot,
    })
    const firstRequest = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)
    const secondRequest = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)
    expect(firstRequest.tool_choice).toBe('auto')
    expect(firstRequest.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'getGroupCheckoutStatus', 'getParticipantPaymentStatuses', 'getCheckoutNextSteps',
    ])
    expect(secondRequest.messages.filter((message: { role: string }) => message.role === 'tool')).toHaveLength(2)
    expect(result.toolsUsed).toEqual(['getGroupCheckoutStatus', 'getParticipantPaymentStatuses'])
    expect(result.response).toContain('$934 remains')
  })
})
