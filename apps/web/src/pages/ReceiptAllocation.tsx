import { WhooshLogo } from '../components/WhooshLogo'
import { useState } from 'react'
import type { ItemAssignment } from '@whoosh/shared'
import type { PersistentGroupDetail } from '../api/whoosh'
import { formatUsd, type NorthlineCart } from '../demo/northline'
import { CheckoutPhases } from '../components/CheckoutPhases'

export function ReceiptAllocation({ onBack, onReview, group, cart, error, busy }: { onBack: () => void; onReview: (assignments: ItemAssignment[]) => void; group?: PersistentGroupDetail; cart: NorthlineCart; error?: string; busy?: boolean }) {
  const members = group?.members.filter((member) => member.status === 'active') ?? []
  const [selected, setSelected] = useState<Record<string, string[]>>(() => Object.fromEntries(cart.items.map((item) => [item.id, item.id === 'upgrade' ? members.slice(0, 2).map((member) => member.id) : item.id === 'shuttle' ? members.slice(0, -1).map((member) => member.id) : members.map((member) => member.id)])))
  const [localError, setLocalError] = useState('')
  const toggle = (itemId: string, memberId: string) => setSelected((current) => ({ ...current, [itemId]: current[itemId]?.includes(memberId) ? current[itemId]!.filter((id) => id !== memberId) : [...(current[itemId] ?? []), memberId] }))
  const submit = () => {
    const assignments = cart.items.map((item) => ({ itemId: item.id, memberIds: selected[item.id] ?? [] }))
    if (assignments.some((row) => row.memberIds.length === 0)) { setLocalError('Select at least one person for every receipt item.'); return }
    if (members.some((member) => !assignments.some((row) => row.memberIds.includes(member.id)))) { setLocalError('Every group member needs a share of at least one item.'); return }
    setLocalError('')
    onReview(assignments)
  }
  return <main className="split-page receipt-manual-page"><header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onBack} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p><div className="group-profile"><strong>{group?.group.name ?? 'Your group'}</strong></div></header>
    <div className="checkout-utility"><button className="text-button" onClick={onBack} type="button">← Back to instructions</button><p>SPLIT · MANUAL</p><button className="close-button" onClick={onBack} type="button" aria-label="Close">×</button></div><CheckoutPhases current="split" />
    <div className="split-layout"><section className="split-main"><p className="trip-kicker">MANUAL RECEIPT SPLIT</p><h1>Assign each item.</h1><p className="trip-subtitle">Select who shares each item. WHOOSH divides cents exactly and checks the total before anyone approves.</p>
      {cart.items.map((item) => <fieldset className="manual-item-card" key={item.id}><legend>{item.label} · {formatUsd(item.cents)}</legend><div>{members.map((member) => <label key={member.id}><input type="checkbox" checked={selected[item.id]?.includes(member.id) ?? false} onChange={() => toggle(item.id, member.id)} /> {member.name}</label>)}</div></fieldset>)}
      {(localError || error) && <p className="sandbox-notice" role="alert">{localError || error}</p>}
      <button className="preview-button" type="button" disabled={!group || busy} onClick={submit}>{busy ? 'Calculating split…' : 'Preview manual split'} →</button>
    </section><aside className="split-summary"><p>{cart.merchant.toUpperCase()} · {cart.currency}</p><h2>{cart.product}</h2><div className="summary-items">{cart.items.map((item) => <div key={item.id}><span>{item.label}</span><strong>{formatUsd(item.cents)}</strong></div>)}</div><div className="summary-total"><p>TOTAL TO MERCHANT</p><strong>{formatUsd(cart.totalCents)}</strong><span>No payment requested</span></div></aside></div>
  </main>
}
