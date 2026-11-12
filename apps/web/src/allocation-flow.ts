import { getPersistentCheckoutSession, getPersistentGroup, previewAllocation, savePersistentAllocation, type AllocationPreviewResponse, type PersistentCheckoutSession, type PersistentGroupDetail } from './api/whoosh'
import type { NorthlineCart } from './demo/northline'
import { allocateReceiptItems, reconcileReceipt, type ItemAssignment } from '@whoosh/shared'

export async function previewCheckoutAllocation(
  transcript: string,
  context: { groupId: string; sessionId: string } | undefined,
  cart: NorthlineCart,
  onReady: (result: AllocationPreviewResponse, group: PersistentGroupDetail, session: PersistentCheckoutSession) => void,
) {
  try {
    if (!context) throw new Error('Choose a saved group before previewing the split.')
    const group = await getPersistentGroup(context.groupId)
    const result = await previewAllocation(transcript, group, cart)
    if (result.needsClarification || !result.allocations || !result.reconciliation) throw new Error(`${result.interpretation.clarifications.join(' ') || 'Clarify who pays for each receipt item.'} Check that everyone named in the instruction belongs to ${group.group.name}.`)
    if (result.reconciliation.differenceCents !== 0 || result.reconciliation.receiptTotalCents !== cart.totalCents) throw new Error('The proposed split does not reconcile to the Northline receipt.')
    await savePersistentAllocation(context.sessionId, transcript, result, result.allocations.map((row) => ({ memberId: row.memberId, amountCents: row.amountCents })))
    const session = await getPersistentCheckoutSession(context.sessionId)
    onReady(result, group, session)
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`WHOOSH could not complete the split preview. Check your connection and try again. (${error.message})`, { cause: error })
    throw error
  }
}

export async function previewManualCheckoutAllocation(
  assignments: ItemAssignment[],
  context: { groupId: string; sessionId: string } | undefined,
  cart: NorthlineCart,
  onReady: (result: AllocationPreviewResponse, group: PersistentGroupDetail, session: PersistentCheckoutSession) => void,
) {
  if (!context) throw new Error('Choose a saved group before splitting the receipt.')
  const group = await getPersistentGroup(context.groupId)
  const memberIds = group.members.filter((member) => member.status === 'active').map((member) => member.id)
  const items = cart.items.map((item) => ({ id: item.id, label: item.label, unitCents: item.cents, quantity: 1 }))
  const allocations = allocateReceiptItems(items, assignments, memberIds)
  const reconciliation = reconcileReceipt(items, allocations)
  if (allocations.length !== memberIds.length || allocations.some((row) => row.amountCents <= 0)) throw new Error('Assign at least one receipt item to every group member.')
  if (reconciliation.differenceCents !== 0 || reconciliation.receiptTotalCents !== cart.totalCents) throw new Error('The manual split does not reconcile to the Northline receipt.')
  const result: AllocationPreviewResponse = { interpretation: { status: 'READY', assignments, clarifications: [] }, needsClarification: false, allocations, reconciliation }
  const instruction = `Manual allocation: ${assignments.map((row) => `${row.itemId} = ${row.memberIds.join(', ')}`).join('; ')}`
  await savePersistentAllocation(context.sessionId, instruction, result, allocations.map((row) => ({ memberId: row.memberId, amountCents: row.amountCents })))
  onReady(result, group, await getPersistentCheckoutSession(context.sessionId))
}
