import { describe, expect, it } from 'vitest'
import type { PersistentGroupSummary } from '../api/whoosh'
import { orderDashboardGroups } from './dashboard-groups'

const group = (id: string, name: string, updatedAt: string): PersistentGroupSummary =>
  ({ id, name, updatedAt, currency: 'CAD', memberCount: 4, purchaseCount: 0, activeCheckoutCount: 0 })

describe('dashboard group ordering', () => {
  const groups = [
    group('old-crew', 'Montréal Crew', '2026-11-09T12:00:00Z'),
    group('recent-sandbox', 'WHOOSH Sandbox Group', '2026-11-11T12:00:00Z'),
    group('recent-crew', 'Sunday table', '2026-11-11T12:00:00Z'),
  ]

  it('shows recent updates first and prefers a named group on ties without dropping records', () => {
    expect(orderDashboardGroups(groups, '').map(({ id }) => id)).toEqual(['recent-crew', 'recent-sandbox', 'old-crew'])
    expect(groups[0]?.id).toBe('old-crew')
  })

  it('finds older groups by name or id', () => {
    expect(orderDashboardGroups(groups, 'Montréal').map(({ id }) => id)).toEqual(['old-crew'])
    expect(orderDashboardGroups(groups, 'recent-sandbox').map(({ id }) => id)).toEqual(['recent-sandbox'])
  })
})
