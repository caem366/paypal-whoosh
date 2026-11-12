import { z } from 'zod'

/** AI output is a proposal only. Allocation and permission services validate it. */
const assignmentSchema = z.object({
  itemId: z.string().min(1),
  memberIds: z.array(z.string().min(1)).min(1),
}).strict()

/** This is an intent contract, intentionally incapable of carrying amounts. */
export const allocationInterpretationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('READY'),
    assignments: z.array(assignmentSchema).min(1),
    clarifications: z.array(z.string()).max(0).default([]),
  }).strict(),
  z.object({
    status: z.literal('NEEDS_CLARIFICATION'),
    assignments: z.array(assignmentSchema).max(0).default([]),
    clarifications: z.array(z.string().min(1)).min(1),
  }).strict(),
])

export type AllocationInterpretation = z.infer<typeof allocationInterpretationSchema>

export interface AllocationInterpreter {
  interpret(input: { transcript: string; itemIds: string[]; memberDirectory: Array<{ id: string; name: string }> }): Promise<AllocationInterpretation>
}

export class MockAllocationInterpreter implements AllocationInterpreter {
  async interpret(input: Parameters<AllocationInterpreter['interpret']>[0]): Promise<AllocationInterpretation> {
    const transcript = input.transcript
    const everyone = input.memberDirectory.map((member) => member.id)
    const findMember = (name: string) => {
      const normalized = name.trim().replace(/\s+(?:are|is)$/i, '').replace(/\s+/g, ' ').toLowerCase()
      const matches = input.memberDirectory.filter((member) => {
        const fullName = member.name.trim().replace(/\s+/g, ' ').toLowerCase()
        return fullName === normalized || fullName.split(' ')[0] === normalized
      })
      return matches.length === 1 ? matches[0] : undefined
    }
    const namePattern = String.raw`([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)`
    const takingShuttle = new RegExp(String.raw`(?:^|[,.!?]\s*)${namePattern}\s+(?:isn['’]?t|is\s+not|doesn['’]?t|does\s+not)\s+(?:taking|take|riding|ride)?\s*(?:the\s+)?shuttle`, 'iu').exec(transcript)
    const coversUpgrade = new RegExp(String.raw`\b${namePattern}\s+and\s+i\s+(?:are\s+)?cover(?:ing)?\s+(?:the\s+)?upgrade`, 'iu').exec(transcript)
    const pairCoversUpgrade = new RegExp(String.raw`\b${namePattern}\s+and\s+${namePattern}\s+(?:are\s+)?(?:cover(?:ing)?|splitting|sharing)\s+(?:the\s+)?upgrade`, 'iu').exec(transcript)
    const ticketSharesAll = /\btickets?\s+(?:four|4)\s+ways\b|\bsplit\s+everything\s+else\b/i.test(transcript)
    const upgradePair = pairCoversUpgrade?.[2]?.replace(/\s+are$/i, '').toLowerCase() === 'i' ? undefined : pairCoversUpgrade
    const invalidName = [takingShuttle?.[1], coversUpgrade?.[1], upgradePair?.[1], upgradePair?.[2]].find((name) => name && !findMember(name))
    if (invalidName) {
      const available = input.memberDirectory.map((member) => member.name).join(', ')
      return { status: 'NEEDS_CLARIFICATION', assignments: [], clarifications: [`“${invalidName}” isn't in the selected group. Use a group member's name: ${available}.`] }
    }

    const assignments: AllocationInterpretation['assignments'] = []
    for (const itemId of input.itemIds) {
      if (itemId === 'tickets' && ticketSharesAll) {
        assignments.push({ itemId, memberIds: everyone })
      } else if (itemId === 'upgrade' && upgradePair?.[1] && upgradePair[2]) {
        const firstMember = findMember(upgradePair[1])
        const secondMember = findMember(upgradePair[2])
        if (firstMember && secondMember) assignments.push({ itemId, memberIds: [...new Set([firstMember.id, secondMember.id])] })
      } else if (itemId === 'upgrade' && coversUpgrade?.[1]) {
        const namedMember = findMember(coversUpgrade[1])
        if (namedMember && everyone[0]) assignments.push({ itemId, memberIds: [...new Set([everyone[0], namedMember.id])] })
      } else if (itemId === 'shuttle' && takingShuttle?.[1]) {
        const excludedMember = findMember(takingShuttle[1])
        if (excludedMember) assignments.push({ itemId, memberIds: everyone.filter((memberId) => memberId !== excludedMember.id) })
      }
    }

    if (assignments.length === input.itemIds.length && assignments.every((assignment) => assignment.memberIds.length > 0)) {
      return { status: 'READY', assignments, clarifications: [] }
    }

    const available = input.memberDirectory.map((member) => member.name).join(', ')
    return { status: 'NEEDS_CLARIFICATION', assignments: [], clarifications: [`I need a clear assignment for every receipt item. Use the group members' names: ${available}.`] }
  }
}

export class OpenAICompatibleInterpreter implements AllocationInterpreter {
  constructor(private readonly apiKey: string, private readonly baseUrl: string, private readonly model: string) {}
  async interpret(input: Parameters<AllocationInterpreter['interpret']>[0]): Promise<AllocationInterpretation> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 20_000)), headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        ...(process.env.AI_DISABLE_THINKING !== '1' && process.env.AI_REASONING_EFFORT ? { reasoning_effort: process.env.AI_REASONING_EFFORT } : {}),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'whoosh_allocation_intent',
            strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              properties: {
                status: { type: 'string', enum: ['READY', 'NEEDS_CLARIFICATION'] },
                assignments: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { itemId: { type: 'string' }, memberIds: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['itemId', 'memberIds'] } },
                clarifications: { type: 'array', items: { type: 'string' } },
              }, required: ['status', 'assignments', 'clarifications'],
            },
          },
        },
        messages: [{ role: 'system', content: 'You interpret human allocation intent only. The first memberDirectory entry is the organizer and speaker: “I” means that member. “Split everything else” assigns items not otherwise specified to all supplied members. “Maya is not taking the shuttle” assigns that item to every supplied member except Maya. Return exactly one assignment for each supplied itemId, using only supplied member IDs. Return NEEDS_CLARIFICATION if any item or person remains ambiguous. Never calculate amounts, change item prices, decide authorization, or execute payments.' }, { role: 'user', content: JSON.stringify(input) }],
      }),
    })
    if (!response.ok) throw new Error(`AI provider returned ${response.status}`)
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    return allocationInterpretationSchema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? '{}'))
  }
}

/** Provider outages or malformed model output must never block a deterministic
 * supported flow. The fallback can only return intent or clarification; it
 * cannot calculate money, change permissions, or execute payments. */
export class FallbackAllocationInterpreter implements AllocationInterpreter {
  constructor(private readonly primary: AllocationInterpreter, private readonly fallback: AllocationInterpreter) {}

  async interpret(input: Parameters<AllocationInterpreter['interpret']>[0]): Promise<AllocationInterpretation> {
    try {
      return await this.primary.interpret(input)
    } catch {
      return this.fallback.interpret(input)
    }
  }
}

export function createAllocationInterpreter(env = process.env): AllocationInterpreter {
  if (env.AI_PROVIDER === 'openai-compatible' && env.AI_API_KEY && env.AI_BASE_URL && env.AI_MODEL) {
    return new FallbackAllocationInterpreter(
      new OpenAICompatibleInterpreter(env.AI_API_KEY, env.AI_BASE_URL, env.AI_MODEL),
      new MockAllocationInterpreter(),
    )
  }
  return new MockAllocationInterpreter()
}
