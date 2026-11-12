import { WhooshLogo } from '../components/WhooshLogo'
import { useEffect, useMemo, useState } from 'react'
import { getPersistentGroup, listPersistentGroups, type PersistentGroupDetail, type PersistentGroupSummary } from '../api/whoosh'
import { orderDashboardGroups } from './dashboard-groups'

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
const avatarTone = ['lime', 'lavender', 'sand', 'blue']
const initials = (name: string) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()

export function GroupsDashboard({ initialGroupId, incomingCheckout, onClose, onCreate, onContinueWithGroup, onOpenGroup, onResume, onPlanPurchase }: { initialGroupId?: string; incomingCheckout?: { title: string; total: string; reference: string }; onClose: () => void; onCreate: () => void; onContinueWithGroup?: () => void; onOpenGroup: (groupId: string) => void; onResume: (groupId: string, sessionId?: string) => void; onPlanPurchase?: (groupId: string) => void }) {
  const [groups, setGroups] = useState<PersistentGroupSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PersistentGroupDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [shownCount, setShownCount] = useState(6)

  useEffect(() => {
    let active = true
    listPersistentGroups()
      .then((loaded) => { if (active) { setGroups(loaded); setSelectedId(loaded.some((group) => group.id === initialGroupId) ? initialGroupId! : loaded[0]?.id ?? null) } })
      .catch(() => active && setError('Your saved groups are unavailable right now. Please try again.'))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [initialGroupId])

  useEffect(() => {
    if (!selectedId) return
    let active = true
    getPersistentGroup(selectedId).then((loaded) => active && setDetail(loaded)).catch(() => active && setDetail(null))
    return () => { active = false }
  }, [selectedId])

  const selectedGroup = useMemo(() => groups.find((group) => group.id === selectedId) ?? groups[0], [groups, selectedId])
  const matchingGroups = useMemo(() => orderDashboardGroups(groups, search), [groups, search])
  const visibleGroups = matchingGroups.slice(0, shownCount)
  const visibleDetail = detail?.group.id === selectedId ? detail : null
  const activeSession = visibleDetail?.sessions.find((session) => !['completed', 'cancelled'].includes(session.status))
  const maya = visibleDetail?.members.find((member) => member.name.toLowerCase().includes('maya'))
  const mayaLimit = maya ? visibleDetail?.permissions.find((permission) => permission.memberId === maya.id)?.limitCents : undefined

  return <main className="split-page groups-dashboard-page">
    <header className="merchant-header">
      <button className="whoosh-brand brand-button" onClick={onClose} type="button"><WhooshLogo /></button>
      <p className="brand-tagline">Split now. Not later.</p>
      <div className="group-profile"><strong>Your groups</strong><span>YC</span></div>
    </header>

    <section className="groups-dashboard-shell">
      <div className="groups-heading"><div><p className="trip-kicker">HEY, JAMIE</p><h1>Good company.<br />Clear balances.</h1><p>Less chasing. More doing things together.</p></div><button className="groups-create-button" type="button" onClick={onCreate}>Create group <span>→</span></button></div>
      {incomingCheckout && <article className="incoming-northline-card"><div><span>↗ NORTHLINE CART SYNCED</span><strong>{incomingCheckout.title}</strong><small>{incomingCheckout.reference} · 4 travelers · USD</small></div><b>{incomingCheckout.total}</b><button type="button" onClick={onContinueWithGroup}>Continue with a group <i>→</i></button><p>No payment has been taken. WHOOSH will ask your group for allocation and consent next.</p></article>}
      {onPlanPurchase && selectedGroup && <button className="agent-entry-button" type="button" onClick={() => onPlanPurchase(selectedGroup.id)}>Plan a purchase with AI <span aria-hidden="true">→</span></button>}
      {loading && <p className="groups-loading">Loading saved groups…</p>}
      {error && <p className="sandbox-notice">{error}</p>}
      {!loading && !error && <div className="groups-dashboard-grid">
        <section className="groups-left-column">
          <div className="groups-list-heading"><h2>Your groups <small>{groups.length.toLocaleString('en-CA')}</small></h2><input type="search" aria-label="Search your groups" value={search} onChange={(event) => { setSearch(event.target.value); setShownCount(6) }} placeholder="Search groups" /></div>
          <div className="groups-card-grid">{visibleGroups.map((group) => <article className={`groups-summary-card ${group.id === selectedGroup?.id ? 'is-selected' : ''}`} key={group.id}>
            <button className="groups-card-open" type="button" onClick={() => onOpenGroup(group.id)} aria-label={`View ${group.name}`}>↗</button><h3>{group.name}</h3><p>{group.memberCount} members · {group.purchaseCount} {group.purchaseCount === 1 ? 'purchase' : 'purchases'}</p>
            <div className="groups-avatar-row">{visibleDetail?.group.id === group.id ? visibleDetail.members.slice(0, 4).map((member, index) => <span className={`person-avatar ${avatarTone[index]}`} key={member.id}>{initials(member.name)}</span>) : <span className="groups-avatar-placeholder">•••</span>}</div>
            <span className={group.activeCheckoutCount ? 'groups-status pending' : 'groups-status'}>{group.activeCheckoutCount ? `• ${group.activeCheckoutCount} checkout in progress` : '• All caught up'}</span><small>{group.activeCheckoutCount ? 'A group checkout is waiting for the next step.' : 'Members, permissions, and purchase history are saved.'}</small><button className="groups-view-button" type="button" onClick={() => onOpenGroup(group.id)}>View group</button>
          </article>)}</div>
          {matchingGroups.length === 0 && <p className="groups-empty-activity">No groups match your search.</p>}
          {shownCount < matchingGroups.length && <button className="groups-show-more" type="button" onClick={() => setShownCount((count) => count + 6)}>Show more groups <span>{Math.min(6, matchingGroups.length - shownCount)} next · {matchingGroups.length - shownCount} remaining</span></button>}
          <p className="groups-stay-copy">Same people. New plans. Your groups stay here between purchases.</p>
          <article className="groups-activity-card"><header><h2>Recent activity</h2><span>{selectedGroup?.name?.toUpperCase() ?? 'YOUR GROUPS'}</span></header>
            {visibleDetail?.purchases.slice(0, 3).map((purchase) => <div className="groups-activity-row" key={purchase.id}><i>✓</i><div><strong>{purchase.title}</strong><small>{purchase.merchant} · {purchase.isDemoData ? 'Demo history' : 'Verified merchant payment'}</small></div><section><b>{money(purchase.totalCents)}</b><em>{purchase.isDemoData ? 'Saved' : 'Verified'}</em></section></div>)}
            {activeSession && <div className="groups-activity-row groups-approval-row"><i>⌁</i><div><strong>Checkout ready to resume</strong><small>{activeSession.merchant} · authorization only, not a payment</small></div><section><b>{money(activeSession.totalCents)}</b><em>Open</em></section></div>}
            {!visibleDetail?.purchases.length && !activeSession && <p className="groups-empty-activity">Activity will appear here when your group starts a shared plan.</p>}
          </article>
          <aside className="groups-safety-note"><span>♢</span><div><strong>A group isn’t payment permission.</strong><p>Each member consents separately and can revoke. Saved rules never authorize arbitrary member spending.</p></div></aside>
        </section>
        <aside className="groups-right-column">
          <article className="groups-checkout-card">{activeSession ? <><p>{activeSession.merchant.toUpperCase()} · USD</p><h2>Ready when<br />your group is.</h2><span>{selectedGroup?.name} · saved checkout</span><strong>{money(activeSession.totalCents)}</strong><em>• {activeSession.status === 'authorized_unpaid' ? 'Authorized, not paid' : 'Checkout in progress'}</em><small>{activeSession.status === 'authorized_unpaid' ? 'Consent is recorded. No merchant payment has been verified.' : 'Your cart and group settings are saved.'}</small><button type="button" onClick={() => selectedGroup && onResume(selectedGroup.id, activeSession.id)}>Resume checkout <b>→</b></button></> : <><p>{selectedGroup?.name?.toUpperCase() ?? 'YOUR GROUP'}</p><h2>Plans stay<br />together.</h2><span>Saved members · saved rules</span><strong>$0.00</strong><em>• No checkout in progress</em><small>Start from a participating merchant to create a shared checkout for this group.</small><button type="button" onClick={onClose}>Find a trip <b>→</b></button></>}</article>
          {maya && <section className="groups-permission-section"><h2>Saved permissions</h2><article className="groups-permission-card"><header><span className="person-avatar blue">{initials(maya.name)}</span><div><strong>{maya.name}</strong><small>{selectedGroup?.name} · active, revocable</small></div><b>♢</b></header><div><span>Standing limit</span><strong>{mayaLimit === undefined ? 'Not set' : money(mayaLimit)}</strong></div><p>Maya’s own share, per purchase, in this group only. Only Maya can change her limit or expiry.</p></article><p className="groups-permission-footnote">Purchase-specific approvals never change a saved standing limit.</p></section>}
        </aside>
      </div>}
    </section>
  </main>
}
