import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { previewAllocation, type AllocationPreviewResponse, type PersistentGroupDetail } from '../api/whoosh'
import { previewCheckoutAllocation, previewManualCheckoutAllocation } from '../allocation-flow'
import { northlineCart } from '../demo/northline'
import { AllocationPreview } from './AllocationPreview'
import { CreateGroupSplit } from './CreateGroupSplit'

const members = ['Jamie Cooper', 'Alex Chen', 'Jordan Ellis', 'Maya Patel'].map((name, index) => ({ id: `member-${index}`, name, contactEmail: null, role: index === 0 ? 'host' as const : 'member' as const, status: 'active' }))
const group: PersistentGroupDetail = { group: { id: 'saved-group', name: 'Montreal Crew', currency: 'USD' }, members, permissions: members.map((member) => ({ memberId: member.id, groupId: 'saved-group', limitCents: 50_000, expiresAt: null, status: 'active' })), rules: null, purchases: [], sessions: [] }
const allocation: AllocationPreviewResponse = {
  interpretation: { status: 'READY', assignments: [{ itemId: 'tickets', memberIds: members.map((member) => member.id) }, { itemId: 'upgrade', memberIds: [members[0]!.id, members[1]!.id] }, { itemId: 'shuttle', memberIds: [members[0]!.id, members[1]!.id, members[2]!.id] }], clarifications: [] },
  needsClarification: false,
  allocations: [{ memberId: members[0]!.id, amountCents: 35_000, itemIds: ['tickets', 'upgrade', 'shuttle'] }, { memberId: members[1]!.id, amountCents: 35_000, itemIds: ['tickets', 'upgrade', 'shuttle'] }, { memberId: members[2]!.id, amountCents: 30_000, itemIds: ['tickets', 'shuttle'] }, { memberId: members[3]!.id, amountCents: 28_400, itemIds: ['tickets'] }],
  reconciliation: { receiptTotalCents: 128_400, allocatedCents: 128_400, differenceCents: 0 },
}

describe('Northline split screens', () => {
  it('saves a valid split before navigating to the preview', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      calls.push(`${options?.method ?? 'GET'} ${path}`)
      const payload = path.endsWith('/preview') ? allocation : path.endsWith('/allocation') ? {} : path.endsWith('/sessions/session-1') ? { funding: [] } : group
      return { ok: true, text: async () => JSON.stringify(payload) }
    }))
    const navigate = vi.fn()
    try {
      await previewCheckoutAllocation('Northline instructions', { groupId: 'saved-group', sessionId: 'session-1' }, northlineCart, (result) => { expect(result).toEqual(allocation); navigate('allocation') })
      expect(calls).toEqual(['GET /api/persistent-groups/saved-group', 'POST /api/allocation/preview', 'PUT /api/persistent-groups/sessions/session-1/allocation', 'GET /api/persistent-groups/sessions/session-1'])
      expect(navigate).toHaveBeenCalledExactlyOnceWith('allocation')
    } finally { vi.unstubAllGlobals() }
  })

  it('stays on instructions when interpretation needs clarification', async () => {
    const fetchMock = vi.fn(async (path: string) => ({ ok: true, text: async () => JSON.stringify(path.endsWith('/preview') ? { interpretation: { status: 'NEEDS_CLARIFICATION', assignments: [], clarifications: ['Name each person.'] }, needsClarification: true } : group) }))
    vi.stubGlobal('fetch', fetchMock)
    const navigate = vi.fn()
    try {
      await expect(previewCheckoutAllocation('unclear', { groupId: 'saved-group', sessionId: 'session-1' }, northlineCart, () => navigate('allocation'))).rejects.toThrow('Name each person.')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(navigate).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('surfaces the actual API error and does not save or navigate', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(group) })
      .mockRejectedValueOnce(new Error('AI provider returned 503'))
    vi.stubGlobal('fetch', fetchMock)
    const navigate = vi.fn()
    try {
      await expect(previewCheckoutAllocation('Northline instructions', { groupId: 'saved-group', sessionId: 'session-1' }, northlineCart, () => navigate('allocation'))).rejects.toThrow('AI provider returned 503')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(navigate).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('turns an unreachable preview API into an actionable error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(group) })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const navigate = vi.fn()
    try {
      await expect(previewCheckoutAllocation('Northline instructions', { groupId: 'saved-group', sessionId: 'session-1' }, northlineCart, () => navigate('allocation'))).rejects.toThrow('WHOOSH could not complete the split preview. Check your connection and try again. (Failed to fetch)')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(navigate).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('does not save or navigate when the receipt total differs', async () => {
    const wrong = { ...allocation, reconciliation: { receiptTotalCents: 128_300, allocatedCents: 128_300, differenceCents: 0 } }
    const fetchMock = vi.fn(async (path: string) => ({ ok: true, text: async () => JSON.stringify(path.endsWith('/preview') ? wrong : group) }))
    vi.stubGlobal('fetch', fetchMock)
    const navigate = vi.fn()
    try {
      await expect(previewCheckoutAllocation('wrong receipt', { groupId: 'saved-group', sessionId: 'session-1' }, northlineCart, () => navigate('allocation'))).rejects.toThrow('does not reconcile')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(navigate).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('sends saved member IDs and the actual cart to allocation preview', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(allocation) })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await previewAllocation("Maya isn't taking the shuttle. Alex and I are covering the upgrade. Split everything else.", group, northlineCart)
      const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit]
      const payload = JSON.parse(String(options.body)) as { groupId: string; members: Array<{ id: string }>; items: Array<{ unitCents: number }>; permissions: Array<{ expiresAt: string | null }> }
      expect(path).toContain('/api/allocation/preview')
      expect(payload.groupId).toBe('saved-group')
      expect(payload.members.map((member) => member.id)).toEqual(members.map((member) => member.id))
      expect(payload.items.map((item) => item.unitCents)).toEqual([113_600, 10_000, 4_800])
      expect(payload.permissions[0]?.expiresAt).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('shows the selected saved group and a visible preview failure', () => {
    const html = renderToStaticMarkup(<CreateGroupSplit cart={northlineCart} group={group} error="Clarify who pays for the upgrade." onBack={() => {}} onChangeGroup={() => {}} onPreview={() => {}} onReceipt={() => {}} />)
    expect(html).toContain('Montreal Crew')
    expect(html).toContain('Maya Patel')
    expect(html).toContain('Clarify who pays for the upgrade.')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Preview the split')
  })

  it('shows the exact saved preview inline before inviting participants', () => {
    const html = renderToStaticMarkup(<CreateGroupSplit cart={northlineCart} group={group} allocation={allocation} onBack={() => {}} onChangeGroup={() => {}} onPreview={() => {}} onConfirmSplit={() => {}} onReceipt={() => {}} />)
    expect(html).toContain('Review the split')
    expect(html).toContain('Confirm split &amp; invite participants')
    expect(html).not.toContain('35,000.00')
    expect(html).toContain('$350.00')
    expect(html).toContain('$300.00')
    expect(html).toContain('$284.00')
    expect(html).toContain('$1,284.00 / $1,284.00')
  })

  it('calculates a manual split in cents and persists it before showing the inline preview', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      calls.push(`${options?.method ?? 'GET'} ${path}`)
      return { ok: true, text: async () => JSON.stringify(path.endsWith('/sessions/session-1') ? { id: 'session-1', funding: [] } : group) }
    }))
    const assignments = allocation.interpretation.assignments
    try {
      await previewManualCheckoutAllocation(assignments, { groupId: 'saved-group', sessionId: 'session-1' }, northlineCart, (result) => {
        expect(result.reconciliation).toEqual({ receiptTotalCents: 128_400, allocatedCents: 128_400, differenceCents: 0 })
        expect(Object.fromEntries(result.allocations!.map((row) => [row.memberId, row.amountCents]))).toEqual(Object.fromEntries(allocation.allocations!.map((row) => [row.memberId, row.amountCents])))
      })
      expect(calls).toEqual(['GET /api/persistent-groups/saved-group', 'PUT /api/persistent-groups/sessions/session-1/allocation', 'GET /api/persistent-groups/sessions/session-1'])
    } finally { vi.unstubAllGlobals() }
  })

  it('explains why preview is unavailable for an empty transcript', () => {
    const props = { cart: northlineCart, onBack: () => {}, onChangeGroup: () => {}, onPreview: () => {}, onReceipt: () => {} }
    const html = renderToStaticMarkup(<CreateGroupSplit {...props} group={{ ...group, members: ['Avery Chen', 'Jordan Bell', 'Morgan Rivera', 'Sam Patel'].map((name, index) => ({ ...members[index]!, name })) }} />)
    expect(html).toContain('Enter an instruction before previewing the split.')
    expect(html).toContain('Standing permissions are not required to preview')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Preview the split/)
    expect(html).toContain('Split manually')
  })

  it('restores a saved instruction and allows preview without standing permissions', () => {
    const instruction = "Morgan isn't taking the shuttle. Avery and Jordan are covering the upgrade. Split tickets four ways."
    const sandboxGroup = { ...group, permissions: [], members: ['Avery Chen', 'Jordan Bell', 'Morgan Rivera', 'Sam Patel'].map((name, index) => ({ ...members[index]!, name })) }
    const html = renderToStaticMarkup(<CreateGroupSplit cart={northlineCart} group={sandboxGroup} initialTranscript={instruction} onBack={() => {}} onChangeGroup={() => {}} onPreview={() => {}} onReceipt={() => {}} />)
    expect(html).toContain(instruction.replaceAll("'", '&#x27;'))
    expect(html).toContain('Standing permissions are not required to preview')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Preview the split/)
  })

  it('only pre-fills the Montréal example for its actual four members', () => {
    const props = { cart: northlineCart, onBack: () => {}, onChangeGroup: () => {}, onPreview: () => {}, onReceipt: () => {} }
    const matching = renderToStaticMarkup(<CreateGroupSplit {...props} group={group} />)
    const otherGroup = { ...group, group: { ...group.group, id: 'sandbox', name: 'WHOOSH Sandbox Group' }, members: ['Avery Chen', 'Jordan Bell', 'Morgan Rivera', 'Sam Patel'].map((name, index) => ({ ...members[index]!, name })) }
    const different = renderToStaticMarkup(<CreateGroupSplit {...props} group={otherGroup} />)
    expect(matching).toContain('Maya isn&#x27;t taking the shuttle')
    expect(different).not.toContain('Maya isn&#x27;t taking the shuttle')
    expect(different).toContain('Describe item shares, or say: Jordan pays $350. Avery pays the same. Morgan pays $284. Sam covers the rest.')
    expect(different).toMatch(/<button[^>]*disabled=""[^>]*>Preview the split/)
  })

  it('shows pending navigation and disables a duplicate preview request', () => {
    const html = renderToStaticMarkup(<CreateGroupSplit cart={northlineCart} group={group} busy onBack={() => {}} onChangeGroup={() => {}} onPreview={() => {}} onReceipt={() => {}} />)
    expect(html).toContain('Previewing the split…')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Previewing the split/)
  })

  it('renders four saved members, item shares, and zero-cent reconciliation', () => {
    const html = renderToStaticMarkup(<AllocationPreview cart={northlineCart} group={group} allocation={allocation} onBack={() => {}} onContinue={() => {}} />)
    for (const member of members) expect(html).toContain(member.name)
    for (const amount of ['$350.00', '$300.00', '$284.00', '$50.00', '$16.00']) expect(html).toContain(amount)
    expect(html).toContain('$1,284.00 / $1,284.00')
    expect(html).toContain('difference $0.00')
    expect(html).toContain('Check permissions')
  })
})
