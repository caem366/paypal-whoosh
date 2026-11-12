import { describe, expect, it } from 'vitest'
import { allocateReceiptItems, evaluatePermissions, reconcileReceipt } from './allocation.js'

const items = [
  { id: 'tickets', label: 'Tickets', unitCents: 28_400, quantity: 4 },
  { id: 'upgrade', label: 'Cabin upgrade', unitCents: 10_000, quantity: 1 },
  { id: 'shuttle', label: 'Station shuttle', unitCents: 1_600, quantity: 3 },
]

describe('item allocation', () => {
  it('allocates the Montreal receipt with exact reconciliation', () => {
    const allocations = allocateReceiptItems(items, [
      { itemId: 'tickets', memberIds: ['alex', 'jamie', 'jordan', 'maya'] },
      { itemId: 'upgrade', memberIds: ['alex', 'jamie'] },
      { itemId: 'shuttle', memberIds: ['alex', 'jamie', 'jordan'] },
    ])
    expect(allocations).toEqual([
      { memberId: 'alex', amountCents: 35_000, itemIds: ['tickets', 'upgrade', 'shuttle'] },
      { memberId: 'jamie', amountCents: 35_000, itemIds: ['tickets', 'upgrade', 'shuttle'] },
      { memberId: 'jordan', amountCents: 30_000, itemIds: ['tickets', 'shuttle'] },
      { memberId: 'maya', amountCents: 28_400, itemIds: ['tickets'] },
    ])
    expect(reconcileReceipt(items, allocations)).toEqual({ receiptTotalCents: 128_400, allocatedCents: 128_400, differenceCents: 0 })
  })

  it('requires one-time approval when Maya exceeds her limit', () => {
    const result = evaluatePermissions([{ memberId: 'maya', amountCents: 28_400, itemIds: ['tickets'] }], [{ memberId: 'maya', groupId: 'montreal', limitCents: 25_000, expiresAt: new Date('2027-01-01'), status: 'active' }], new Date('2026-10-05'))
    expect(result[0]).toMatchObject({ status: 'approval_required', reason: 'Amount exceeds per-purchase limit' })
  })

  it('honors an active standing permission without an expiry date', () => {
    const result = evaluatePermissions([{ memberId: 'jamie', amountCents: 35_000, itemIds: ['tickets', 'upgrade', 'shuttle'] }], [{ memberId: 'jamie', groupId: 'montreal', limitCents: 50_000, expiresAt: null, status: 'active' }])
    expect(result[0]?.status).toBe('ready')
  })

  it('uses a one-time approval without raising the standing authorization limit', () => {
    const result = evaluatePermissions(
      [{ memberId: 'maya', amountCents: 28_400, itemIds: ['tickets'] }],
      [{ memberId: 'maya', groupId: 'montreal', limitCents: 25_000, expiresAt: new Date('2027-01-01'), status: 'active' }],
      new Date('2026-10-05'),
      [{ memberId: 'maya', groupId: 'montreal', approvedCents: 28_400, expiresAt: new Date('2026-10-06'), status: 'active' }],
    )
    expect(result[0]).toMatchObject({ status: 'ready', reason: 'One-time approval verified' })
  })

  it('rejects unknown people, duplicate assignments, and invalid item IDs', () => {
    expect(() => allocateReceiptItems(items, [
      { itemId: 'tickets', memberIds: ['jamie', 'unknown'] },
      { itemId: 'upgrade', memberIds: ['jamie'] },
      { itemId: 'shuttle', memberIds: ['jamie'] },
    ], ['jamie'])).toThrow('unknown member')
    expect(() => allocateReceiptItems(items, [
      { itemId: 'tickets', memberIds: ['jamie'] },
      { itemId: 'tickets', memberIds: ['alex'] },
      { itemId: 'shuttle', memberIds: ['jamie'] },
    ])).toThrow('receipt item once')
  })
})
