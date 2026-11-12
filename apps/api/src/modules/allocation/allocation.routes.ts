import { Router } from 'express'
import { z } from 'zod'
import { allocateReceiptItems, evaluatePermissions, reconcileReceipt } from '@whoosh/shared'
import { createAllocationInterpreter } from '../ai/interpretation.service.js'
import { parseDirectAmountRequest } from '../ai/direct-amounts.js'

const money = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const previewSchema = z.object({
  transcript: z.string().trim().min(1).max(4_000),
  groupId: z.string().min(1),
  members: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).min(1),
  items: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), unitCents: money, quantity: z.number().int().positive() })).min(1),
  permissions: z.array(z.object({ memberId: z.string().min(1), groupId: z.string().min(1), limitCents: money, expiresAt: z.coerce.date().nullable(), status: z.enum(['active', 'revoked']) })),
})

export const allocationRouter = Router()
allocationRouter.post('/preview', async (request, response, next) => {
  try {
    const input = previewSchema.parse(request.body)
    const receiptTotalCents = reconcileReceipt(input.items, []).receiptTotalCents
    const direct = parseDirectAmountRequest(input.transcript, input.members, receiptTotalCents)
    if (direct?.status === 'NEEDS_CLARIFICATION') return response.status(200).json({ interpretation: { status: 'NEEDS_CLARIFICATION', assignments: [], clarifications: [direct.message] }, needsClarification: true })
    if (direct?.status === 'READY') {
      const allocations = direct.amounts.map(({ memberId, amountCents }) => ({ memberId, amountCents, itemIds: [] }))
      const reconciliation = reconcileReceipt(input.items, allocations)
      const permissions = evaluatePermissions(allocations, input.permissions.filter((permission) => permission.groupId === input.groupId))
      return response.status(200).json({ interpretation: { status: 'READY', assignments: [], directAmounts: true, clarifications: [] }, allocations, reconciliation, permissions, needsClarification: false })
    }
    const interpretation = await createAllocationInterpreter().interpret({ transcript: input.transcript, itemIds: input.items.map((item) => item.id), memberDirectory: input.members })
    if (interpretation.status === 'NEEDS_CLARIFICATION') return response.status(200).json({ interpretation, needsClarification: true })
    const allocations = allocateReceiptItems(input.items, interpretation.assignments, input.members.map((member) => member.id))
    const reconciliation = reconcileReceipt(input.items, allocations)
    const permissions = evaluatePermissions(allocations, input.permissions.filter((permission) => permission.groupId === input.groupId))
    response.status(200).json({ interpretation, allocations, reconciliation, permissions, needsClarification: interpretation.clarifications.length > 0 })
  } catch (error) { next(error) }
})
