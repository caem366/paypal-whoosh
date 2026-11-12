import { describe, expect, it } from 'vitest'
import type { PersistentGroupSummary } from '../api/whoosh'
import { orderCheckoutGroups } from './group-picker-order'

const group = (id: string, name: string, purchaseCount = 0, activeCheckoutCount = 0): PersistentGroupSummary => ({ id, name, currency: 'USD', memberCount: 4, purchaseCount, activeCheckoutCount })

describe('checkout group selection', () => {
  const groups = [group('sandbox-1', 'WHOOSH Sandbox Group'), group('crew', 'Montreal Crew', 3, 4), group('sandbox-2', 'WHOOSH Sandbox Group', 0, 2)]

  it('prioritizes a group with purchase history and keeps distinct same-named groups', () => {
    expect(orderCheckoutGroups(groups, '', 'recommended').map(({ id }) => id)).toEqual(['crew', 'sandbox-2', 'sandbox-1'])
    expect(groups[0]?.id).toBe('sandbox-1')
  })

  it('searches all groups by name or reference and supports alphabetical sorting', () => {
    expect(orderCheckoutGroups(groups, 'sandbox-1', 'recommended').map(({ id }) => id)).toEqual(['sandbox-1'])
    expect(orderCheckoutGroups(groups, 'WHOOSH', 'recommended')).toHaveLength(2)
    expect(orderCheckoutGroups(groups, '', 'name')[0]?.id).toBe('crew')
  })
})
