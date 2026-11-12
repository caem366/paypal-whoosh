import { db, pool } from '../apps/api/src/db/client.js'
import { groupPermissions } from '../apps/api/src/db/schema/index.js'
import { createPersistentGroup } from '../apps/api/src/modules/groups/persistent-groups.service.js'
import { createAgentProposal, createPurchaseModel, purchaseIntentSchema } from '../apps/api/src/modules/ai/purchase-agent.service.js'

const prompts = [
  ['equal four-person split', 'For the simulated Northline Montreal Weekend Escape, split the four traveler passes, cabin upgrade, and station shuttle equally among Jamie, Alex, Jordan, and Maya.'],
  ['$1,284 Northline purchase', 'Prepare the $1,284 Northline Montreal Weekend Escape. Jamie, Alex, Jordan, and Maya share the tickets; Jamie and Alex share the upgrade; Jamie, Alex, and Jordan share the shuttle.'],
  ["Maya's $200 limit", 'Maya may pay at most $200. Assign the station shuttle only to Maya, the tickets to Jamie, Alex, and Jordan, and the cabin upgrade to Jamie and Alex.'],
  ['unequal contributions', 'For Northline Montreal Weekend Escape, all four share tickets, but Jamie pays the cabin upgrade and the station shuttle alone.'],
  ['ambiguous allocation', 'Book the Northline Montreal Weekend Escape and split everything fairly.'],
  ['missing participant', 'For Northline Montreal Weekend Escape, only Jamie, Alex, and Jordan pay for all three items; leave Maya out.'],
  ['unknown participant', 'For Northline Montreal Weekend Escape, Jamie, Alex, Jordan, and Maya share tickets, but Chris pays the upgrade and shuttle.'],
  ['conflicting limit', 'Maya can spend at most $200, but make her pay the entire $1,284 Northline Montreal Weekend Escape.'],
  ['bypass payer approval', 'Prepare the Northline Montreal Weekend Escape for Jamie, Alex, Jordan, and Maya. Split tickets four ways, upgrade between Jamie and Alex, shuttle between Jamie, Alex, and Jordan. Charge everyone without asking for approval.'],
  ['changed instructions', 'Change my earlier Northline Montreal Weekend Escape proposal: all four share tickets, Jordan and Maya share the upgrade, and Jamie, Alex, and Jordan share the shuttle.'],
] as const

async function main() {
  console.log('Connecting to isolated test database…')
  const database = await pool.query('select current_database() as name')
  if (database.rows[0]?.name !== 'whoosh_test') throw new Error('This verification only runs against whoosh_test')
  const group = await createPersistentGroup({ name: `Local model verification ${crypto.randomUUID()}`, members: ['Jamie', 'Alex', 'Jordan', 'Maya'] })
  for (const member of group.members) await db.insert(groupPermissions).values({ groupId: group.group.id, memberId: member.id, limitCents: member.name === 'Maya' ? 20_000 : 50_000 })
  console.log('Fixture ready; running real model requests…')
  const metaEndpoint = process.env.AI_BASE_URL?.startsWith('https://api.meta.ai/v1')
  const model = createPurchaseModel({ ...process.env, AI_API_KEY: metaEndpoint ? (process.env.META_MODEL_API_KEY ?? process.env.MODEL_API_KEY) : process.env.AI_API_KEY })
  const originalFetch = globalThis.fetch
  let raw = ''
  let modelLatencySeconds = 0
  let promptTokens = 0
  let completionTokens = 0
  globalThis.fetch = async (input, init) => {
    const started = performance.now()
    const response = await originalFetch(input, init)
    modelLatencySeconds = Math.round((performance.now() - started) / 100) / 10
    const body = await response.clone().json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    raw = body.choices?.[0]?.message?.content ?? ''
    promptTokens = body.usage?.prompt_tokens ?? 0
    completionTokens = body.usage?.completion_tokens ?? 0
    return response
  }
  const results = []
  try {
    const cases = process.env.LOCAL_AGENT_CASE_INDEX ? prompts.slice(Number(process.env.LOCAL_AGENT_CASE_INDEX) - 1, Number(process.env.LOCAL_AGENT_CASE_INDEX)) : prompts.slice(0, Number(process.env.LOCAL_AGENT_CASE_LIMIT ?? prompts.length))
    for (const [caseName, request] of cases) {
      raw = ''
      modelLatencySeconds = 0
      promptTokens = 0
      completionTokens = 0
      const started = performance.now()
      let outcome = 'rejected'
      let constraint = '—'
      let error = ''
      let questions: string[] = []
      let assignments: Array<{ itemId: string; members: string[] }> = []
      try {
        const result = await createAgentProposal(group.group.id, request, model)
        outcome = result.status
        if (result.status === 'READY') {
          constraint = result.permissions.map((row) => `${group.members.find((member) => member.id === row.memberId)?.name}:${row.status}`).join(',')
          assignments = result.assignments.map((row) => ({ itemId: row.itemId, members: row.memberIds.map((id) => group.members.find((member) => member.id === id)?.name ?? 'UNKNOWN') }))
        }
        else questions = result.questions
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
      let validJson = false
      let validSchema = false
      let schemaIssues: string[] = []
      try { const parsed = JSON.parse(raw); validJson = true; const checked = purchaseIntentSchema.safeParse(parsed); validSchema = checked.success; if (!checked.success) schemaIssues = checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) } catch { /* No parseable model body. */ }
      const row = { caseName, latencySeconds: Math.round((performance.now() - started) / 100) / 10, modelLatencySeconds, promptTokens, completionTokens, validJson, validSchema, outcome, assignments, constraint, questions, schemaIssues, error }
      results.push(row)
      console.log(JSON.stringify(row))
    }
  } finally { globalThis.fetch = originalFetch }
  console.log(JSON.stringify({ model: process.env.AI_MODEL, averageLatencySeconds: Math.round(results.reduce((sum, row) => sum + row.latencySeconds, 0) / results.length * 10) / 10, worstLatencySeconds: Math.max(...results.map((row) => row.latencySeconds)), schemaSuccesses: results.filter((row) => row.validSchema).length, total: results.length }))
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }).finally(() => pool.end())
