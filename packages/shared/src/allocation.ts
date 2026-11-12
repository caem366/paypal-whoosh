import { addCents, assertIntegerCents, assertPositiveCents, splitEvenly } from './money.js'
import type { MoneyCents } from './domain.js'

export interface ReceiptItem {
  id: string
  label: string
  unitCents: MoneyCents
  quantity: number
}

export interface ItemAssignment {
  itemId: string
  memberIds: string[]
}

export interface MemberAllocation {
  memberId: string
  amountCents: MoneyCents
  itemIds: string[]
}

export interface PerPurchasePermission {
  memberId: string
  groupId: string
  limitCents: MoneyCents
  expiresAt: Date | null
  status: 'active' | 'revoked'
}

/** A narrow, purchase-specific exception. It never changes a standing limit. */
export interface OneTimeApproval {
  memberId: string
  groupId: string
  approvedCents: MoneyCents
  expiresAt: Date
  status: 'active' | 'revoked'
}

export interface PermissionResult {
  memberId: string
  amountCents: MoneyCents
  status: 'ready' | 'approval_required' | 'blocked'
  reason?: string
}

function itemTotal(item: ReceiptItem): MoneyCents {
  assertPositiveCents(item.unitCents, `${item.id}.unitCents`)
  if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
    throw new TypeError(`${item.id}.quantity must be a positive safe integer`)
  }
  const total = item.unitCents * item.quantity
  assertIntegerCents(total, `${item.id}.totalCents`)
  return total
}

/** Allocates each receipt item only to named members, with deterministic cents. */
export function allocateReceiptItems(
  items: ReceiptItem[],
  assignments: ItemAssignment[],
  knownMemberIds?: Iterable<string>,
): MemberAllocation[] {
  const itemsById = new Map(items.map((item) => [item.id, item]))
  if (itemsById.size !== items.length) throw new TypeError('Receipt item IDs must be unique')
  if (assignments.length !== items.length) throw new TypeError('Every receipt item needs exactly one assignment')

  const result = new Map<string, MemberAllocation>()
  const seen = new Set<string>()
  const validMembers = knownMemberIds ? new Set(knownMemberIds) : undefined
  for (const assignment of assignments) {
    const item = itemsById.get(assignment.itemId)
    if (!item || seen.has(item.id)) throw new TypeError('Assignments must reference each receipt item once')
    seen.add(item.id)
    if (assignment.memberIds.length === 0 || new Set(assignment.memberIds).size !== assignment.memberIds.length) {
      throw new TypeError(`Assignment for ${item.id} needs unique members`)
    }
    if (validMembers && assignment.memberIds.some((memberId) => !validMembers.has(memberId))) {
      throw new TypeError(`Assignment for ${item.id} references an unknown member`)
    }
    const portions = splitEvenly(itemTotal(item), assignment.memberIds.length)
    assignment.memberIds.forEach((memberId, index) => {
      const prior = result.get(memberId) ?? { memberId, amountCents: 0, itemIds: [] }
      prior.amountCents = addCents(prior.amountCents, portions[index]!)
      prior.itemIds.push(item.id)
      result.set(memberId, prior)
    })
  }
  return [...result.values()].sort((a, b) => a.memberId.localeCompare(b.memberId))
}

export function reconcileReceipt(items: ReceiptItem[], allocations: MemberAllocation[]): { receiptTotalCents: MoneyCents; allocatedCents: MoneyCents; differenceCents: MoneyCents } {
  const receiptTotalCents = addCents(...items.map(itemTotal))
  const allocatedCents = addCents(...allocations.map((allocation) => allocation.amountCents))
  return { receiptTotalCents, allocatedCents, differenceCents: receiptTotalCents - allocatedCents }
}

/** Permission logic is deterministic. A language model may only propose assignments. */
export function evaluatePermissions(
  allocations: MemberAllocation[],
  permissions: PerPurchasePermission[],
  now = new Date(),
  oneTimeApprovals: OneTimeApproval[] = [],
): PermissionResult[] {
  const byMember = new Map(permissions.map((permission) => [permission.memberId, permission]))
  return allocations.map((allocation) => {
    const permission = byMember.get(allocation.memberId)
    const exception = oneTimeApprovals.find((approval) =>
      approval.memberId === allocation.memberId
      && approval.status === 'active'
      && approval.expiresAt > now
      && approval.approvedCents >= allocation.amountCents,
    )
    if (!permission || permission.status === 'revoked' || (permission.expiresAt !== null && permission.expiresAt <= now)) {
      return { memberId: allocation.memberId, amountCents: allocation.amountCents, status: 'blocked', reason: 'No active group permission' }
    }
    if (allocation.amountCents > permission.limitCents) {
      if (exception) return { memberId: allocation.memberId, amountCents: allocation.amountCents, status: 'ready', reason: 'One-time approval verified' }
      return { memberId: allocation.memberId, amountCents: allocation.amountCents, status: 'approval_required', reason: 'Amount exceeds per-purchase limit' }
    }
    return { memberId: allocation.memberId, amountCents: allocation.amountCents, status: 'ready' }
  })
}
