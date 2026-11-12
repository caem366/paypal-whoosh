import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allocationRouter } from './allocation.routes.js'

const members = [
  { id: 'member-jamie', name: 'Jamie Cooper' },
  { id: 'member-alex', name: 'Alex Chen' },
  { id: 'member-jordan', name: 'Jordan Ellis' },
  { id: 'member-maya', name: 'Maya Patel' },
]
const body = {
  transcript: "Maya isn't taking the shuttle. Alex and I are covering the upgrade. Split everything else.",
  groupId: 'saved-montreal-group', members,
  items: [
    { id: 'tickets', label: '4 traveler passes', unitCents: 113_600, quantity: 1 },
    { id: 'upgrade', label: 'Cabin upgrade', unitCents: 10_000, quantity: 1 },
    { id: 'shuttle', label: 'Station shuttle', unitCents: 4_800, quantity: 1 },
  ],
  permissions: members.map((member) => ({ memberId: member.id, groupId: 'saved-montreal-group', limitCents: member.id === 'member-maya' ? 25_000 : 50_000, expiresAt: null, status: 'active' })),
}
const sandboxMembers = [
  { id: 'member-avery', name: 'Avery Chen' },
  { id: 'member-jordan-bell', name: 'Jordan Bell' },
  { id: 'member-morgan', name: 'Morgan Rivera' },
  { id: 'member-sam', name: 'Sam Patel' },
]
const sandboxBody = {
  ...body,
  groupId: 'whoosh-sandbox-group',
  members: sandboxMembers,
  permissions: [],
  transcript: "Morgan isn't taking the shuttle. Avery and Jordan are covering the upgrade. Split tickets four ways.",
}

describe('Northline allocation preview API', () => {
  const app = express().use(express.json()).use('/api/allocation', allocationRouter)
  let server: ReturnType<typeof app.listen>
  let url: string
  const priorProvider = process.env.AI_PROVIDER
  beforeAll(() => { process.env.AI_PROVIDER = 'mock'; server = app.listen(0); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/allocation/preview` })
  afterAll(async () => { if (priorProvider === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = priorProvider; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) })

  it('allocates saved member IDs and all receipt items to exactly $1,284', async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    const result = await response.json() as { allocations: Array<{ memberId: string; amountCents: number; itemIds: string[] }>; reconciliation: { receiptTotalCents: number; allocatedCents: number; differenceCents: number }; permissions: Array<{ memberId: string; status: string }> }
    expect(Object.fromEntries(result.allocations.map((row) => [row.memberId, row.amountCents]))).toEqual({ 'member-jamie': 35_000, 'member-alex': 35_000, 'member-jordan': 30_000, 'member-maya': 28_400 })
    expect(result.allocations.find((row) => row.memberId === 'member-maya')?.itemIds).toEqual(['tickets'])
    expect(result.reconciliation).toEqual({ receiptTotalCents: 128_400, allocatedCents: 128_400, differenceCents: 0 })
    expect(result.permissions.find((row) => row.memberId === 'member-maya')?.status).toBe('approval_required')
  })

  it('asks for clarification instead of previewing a conflicting instruction', async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, transcript: 'Maya pays for the shuttle and Jordan covers the upgrade.' }) })
    const result = await response.json() as { needsClarification: boolean; allocations?: unknown; interpretation: { clarifications: string[] } }
    expect(result.needsClarification).toBe(true)
    expect(result.allocations).toBeUndefined()
    expect(result.interpretation.clarifications.length).toBeGreaterThan(0)
  })

  it('previews the sandbox group without payment consent and reconciles exactly to $1,284', async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sandboxBody) })
    expect(response.status).toBe(200)
    const result = await response.json() as { allocations: Array<{ memberId: string; amountCents: number }>; reconciliation: { receiptTotalCents: number; allocatedCents: number; differenceCents: number } }
    expect(Object.fromEntries(result.allocations.map((row) => [row.memberId, row.amountCents]))).toEqual({ 'member-avery': 35_000, 'member-jordan-bell': 35_000, 'member-morgan': 28_400, 'member-sam': 30_000 })
    expect(result.reconciliation).toEqual({ receiptTotalCents: 128_400, allocatedCents: 128_400, differenceCents: 0 })
  })

  it('previews explicit whole-receipt contributions without inventing item assignments', async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sandboxBody, transcript: 'Jordan pays three hundred and fifty dollars. Avery pays the same. Morgan pays two hundred and eighty-four. Sam covers the rest.' }) })
    const result = await response.json() as { interpretation: { directAmounts: boolean; assignments: unknown[] }; allocations: Array<{ memberId: string; amountCents: number; itemIds: string[] }>; reconciliation: { differenceCents: number } }
    expect(response.status).toBe(200)
    expect(result.interpretation).toMatchObject({ directAmounts: true, assignments: [] })
    expect(Object.fromEntries(result.allocations.map((row) => [row.memberId, row.amountCents]))).toEqual({ 'member-avery': 35_000, 'member-jordan-bell': 35_000, 'member-morgan': 28_400, 'member-sam': 30_000 })
    expect(result.allocations.every((row) => row.itemIds.length === 0)).toBe(true)
    expect(result.reconciliation.differenceCents).toBe(0)
  })

  it('returns an actionable clarification for a participant outside the selected group', async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sandboxBody, transcript: "Chris isn't taking the shuttle. Avery and Jordan are covering the upgrade. Split tickets four ways." }) })
    const result = await response.json() as { needsClarification: boolean; interpretation: { clarifications: string[] }; allocations?: unknown }
    expect(response.status).toBe(200)
    expect(result.needsClarification).toBe(true)
    expect(result.allocations).toBeUndefined()
    expect(result.interpretation.clarifications[0]).toContain("Chris” isn't in the selected group")
    expect(result.interpretation.clarifications[0]).toContain('Avery Chen, Jordan Bell, Morgan Rivera, Sam Patel')
  })
})
