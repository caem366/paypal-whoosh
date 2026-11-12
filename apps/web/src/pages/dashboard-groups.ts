import type { PersistentGroupSummary } from '../api/whoosh'

export function orderDashboardGroups(groups: PersistentGroupSummary[], search: string) {
  const query = search.trim().toLocaleLowerCase()
  return groups.filter((group) => !query || group.name.toLocaleLowerCase().includes(query) || group.id.toLocaleLowerCase().includes(query))
    .sort((a, b) => {
      const byUpdate = Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '')
      if (Number.isFinite(byUpdate) && byUpdate !== 0) return byUpdate
      const generic = (name: string) => /^whoosh sandbox group$/i.test(name.trim())
      return Number(generic(a.name)) - Number(generic(b.name)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    })
}
