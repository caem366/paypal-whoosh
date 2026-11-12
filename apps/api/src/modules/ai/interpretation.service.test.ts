import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAllocationInterpreter, OpenAICompatibleInterpreter } from './interpretation.service.js'

afterEach(() => vi.unstubAllGlobals())

describe('mock allocation interpreter', () => {
  it('tells the hosted model who “I” and “everything else” refer to', async () => {
    const output = { status: 'READY', assignments: [{ itemId: 'tickets', memberIds: ['jamie', 'alex', 'maya', 'jordan'] }, { itemId: 'upgrade', memberIds: ['jamie', 'alex'] }, { itemId: 'shuttle', memberIds: ['jamie', 'alex', 'jordan'] }], clarifications: [] }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const interpreter = new OpenAICompatibleInterpreter('test-key', 'https://api.meta.ai/v1', 'muse-ember-1.0')
    expect((await interpreter.interpret({ transcript: "Maya isn't taking the shuttle. Alex and I cover the upgrade. Split everything else.", itemIds: ['tickets', 'upgrade', 'shuttle'], memberDirectory: [{ id: 'jamie', name: 'Jamie' }, { id: 'alex', name: 'Alex' }, { id: 'maya', name: 'Maya' }, { id: 'jordan', name: 'Jordan' }] })).assignments).toEqual(output.assignments)
    const body = JSON.parse(fetch.mock.calls[0]?.[1].body)
    expect(body.messages[0].content).toContain('first memberDirectory entry is the organizer')
    expect(body.messages[0].content).toContain('items not otherwise specified to all supplied members')
  })
  it('only proposes the seeded allocation; it does not calculate amounts', async () => {
    const result = await createAllocationInterpreter({ AI_PROVIDER: 'mock' }).interpret({ transcript: "Split tickets four ways, Alex and I cover the upgrade, Maya isn't taking the shuttle", itemIds: ['tickets', 'upgrade', 'shuttle'], memberDirectory: [{ id: 'jamie', name: 'Jamie Cooper' }, { id: 'alex', name: 'Alex Chen' }, { id: 'jordan', name: 'Jordan Ellis' }, { id: 'maya', name: 'Maya Patel' }] })
    expect(result.status).toBe('READY')
    expect(result.assignments).toHaveLength(3)
    expect(JSON.stringify(result)).not.toContain('amountCents')
  })

  it('interprets the Northline instructions shown on the checkout screen', async () => {
    const result = await createAllocationInterpreter({ AI_PROVIDER: 'mock' }).interpret({ transcript: "Maya isn't taking the shuttle. Alex and I are covering the upgrade. Split everything else.", itemIds: ['tickets', 'upgrade', 'shuttle'], memberDirectory: [{ id: 'jamie', name: 'Jamie Cooper' }, { id: 'alex', name: 'Alex Chen' }, { id: 'jordan', name: 'Jordan Ellis' }, { id: 'maya', name: 'Maya Patel' }] })
    expect(result).toMatchObject({ status: 'READY', assignments: [{ itemId: 'tickets', memberIds: ['jamie', 'alex', 'jordan', 'maya'] }, { itemId: 'upgrade', memberIds: ['jamie', 'alex'] }, { itemId: 'shuttle', memberIds: ['jamie', 'alex', 'jordan'] }] })
  })

  it('resolves valid instructions against the selected sandbox group names', async () => {
    const result = await createAllocationInterpreter({ AI_PROVIDER: 'mock' }).interpret({
      transcript: "Morgan isn't taking the shuttle. Avery and Jordan are covering the upgrade. Split tickets four ways.",
      itemIds: ['tickets', 'upgrade', 'shuttle'],
      memberDirectory: [{ id: 'avery', name: 'Avery Chen' }, { id: 'jordan', name: 'Jordan Bell' }, { id: 'morgan', name: 'Morgan Rivera' }, { id: 'sam', name: 'Sam Patel' }],
    })
    expect(result).toMatchObject({ status: 'READY', assignments: [{ itemId: 'tickets', memberIds: ['avery', 'jordan', 'morgan', 'sam'] }, { itemId: 'upgrade', memberIds: ['avery', 'jordan'] }, { itemId: 'shuttle', memberIds: ['avery', 'jordan', 'sam'] }] })
  })

  it('explains which participant name is not in the selected group', async () => {
    const result = await createAllocationInterpreter({ AI_PROVIDER: 'mock' }).interpret({
      transcript: "Chris isn't taking the shuttle. Avery and Jordan are covering the upgrade. Split tickets four ways.",
      itemIds: ['tickets', 'upgrade', 'shuttle'],
      memberDirectory: [{ id: 'avery', name: 'Avery Chen' }, { id: 'jordan', name: 'Jordan Bell' }, { id: 'morgan', name: 'Morgan Rivera' }, { id: 'sam', name: 'Sam Patel' }],
    })
    expect(result.status).toBe('NEEDS_CLARIFICATION')
    expect(result.clarifications[0]).toContain("Chris” isn't in the selected group")
    expect(result.clarifications[0]).toContain('Avery Chen, Jordan Bell, Morgan Rivera, Sam Patel')
  })

  it('does not guess the demo split from conflicting words alone', async () => {
    const result = await createAllocationInterpreter({ AI_PROVIDER: 'mock' }).interpret({ transcript: 'Maya is taking the shuttle and Jordan covers the upgrade.', itemIds: ['tickets', 'upgrade', 'shuttle'], memberDirectory: [{ id: 'jamie', name: 'Jamie Cooper' }, { id: 'alex', name: 'Alex Chen' }, { id: 'jordan', name: 'Jordan Ellis' }, { id: 'maya', name: 'Maya Patel' }] })
    expect(result.status).toBe('NEEDS_CLARIFICATION')
  })

  it('asks for clarification rather than guessing ambiguous intent', async () => {
    const result = await createAllocationInterpreter({ AI_PROVIDER: 'mock' }).interpret({ transcript: 'Sam covers it', itemIds: ['tickets'], memberDirectory: [{ id: 'sam-rivera', name: 'Sam Rivera' }, { id: 'sam-brooks', name: 'Sam Brooks' }] })
    expect(result).toMatchObject({ status: 'NEEDS_CLARIFICATION' })
  })
})
