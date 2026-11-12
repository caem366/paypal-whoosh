import type { PersistentGroupSummary } from '../api/whoosh'

export function orderCheckoutGroups(groups: PersistentGroupSummary[], search: string, sort: string) {
  const query = search.trim().toLocaleLowerCase()
  return groups.filter((group) => !query || group.name.toLocaleLowerCase().includes(query) || group.id.toLocaleLowerCase().includes(query))
    .sort((a, b) => sort === 'name'
      ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      : b.purchaseCount - a.purchaseCount || b.activeCheckoutCount - a.activeCheckoutCount || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}
