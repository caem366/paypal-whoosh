import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderError, createPurchaseModel, proposeAllocations, purchaseIntentSchema } from './purchase-agent.service.js'

const env = { AI_PROVIDER: 'openai-compatible', AI_API_KEY: 'test-key', AI_BASE_URL: 'https://api.openai.com/v1', AI_MODEL: 'gpt-5.4-mini' }
const input = { request: 'Split the Northline trip among four people', members: [{ id: 'jamie', name: 'Jamie' }] }
const intent = { status: 'NEEDS_CLARIFICATION', merchant: 'Northline Travel', product: 'Montreal Weekend Escape', statedTotalCents: null, assignments: [], assumptions: [], questions: ['Name all four participants.'] }

afterEach(() => vi.unstubAllGlobals())

describe('model-backed purchasing intent', () => {
  it('validates exact contributions without assigning the upgrade or shuttle by guesswork', () => {
    const direct = purchaseIntentSchema.parse({ status: 'READY', merchant: 'Northline Travel', product: 'Montreal Weekend Escape', statedTotalCents: null, assignments: [], directAmounts: [
      { memberId: 'jordan', amountCents: 35000 }, { memberId: 'avery', amountCents: 35000 }, { memberId: 'morgan', amountCents: 28400 }, { memberId: 'sam', amountCents: 30000 },
    ], assumptions: [], questions: [] })
    expect(proposeAllocations(direct, ['jordan', 'avery', 'morgan', 'sam']).reconciliation.differenceCents).toBe(0)
    expect(proposeAllocations(direct, ['jordan', 'avery', 'morgan', 'sam']).allocations.every((row) => row.itemIds.length === 0)).toBe(true)
    expect(() => proposeAllocations({ ...direct, directAmounts: direct.directAmounts!.map((row) => row.memberId === 'sam' ? { ...row, amountCents: 29900 } : row) }, ['jordan', 'avery', 'morgan', 'sam'])).toThrow()
  })
  it('sends a structured request to the configured model and validates its response', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intent) } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await createPurchaseModel(env).interpret(input)).toEqual(intent)
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions')
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body).model).toBe('gpt-5.4-mini')
  })

  it('disables local model reasoning only when explicitly configured', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intent) } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await createPurchaseModel({ ...env, AI_DISABLE_THINKING: '1' }).interpret(input)
    const body = JSON.parse(fetch.mock.calls[0]?.[1].body)
    expect(body.reasoning_effort).toBe('none')
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body.response_format.type).toBe('json_schema')
  })

  it('uses an explicitly configured hosted-model reasoning effort', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intent) } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await createPurchaseModel({ ...env, AI_REASONING_EFFORT: 'minimal' }).interpret(input)
    const body = JSON.parse(fetch.mock.calls[0]?.[1].body)
    expect(body.reasoning_effort).toBe('minimal')
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  it('rejects malformed output and reports depleted provider credit without a mock fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"status":"READY"}' } }] }), { status: 200 })))
    await expect(createPurchaseModel(env).interpret(input)).rejects.toBeInstanceOf(AgentProviderError)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'credit_balance_exhausted' } }), { status: 429 })))
    await expect(createPurchaseModel(env).interpret(input)).rejects.toThrow('credit balance is exhausted')
  })
})
