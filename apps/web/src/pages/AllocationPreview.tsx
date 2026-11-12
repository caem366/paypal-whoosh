import { WhooshLogo } from '../components/WhooshLogo'
import { splitEvenly } from '@whoosh/shared'
import type { AllocationPreviewResponse, PersistentGroupDetail } from '../api/whoosh'
import { formatUsd, type NorthlineCart } from '../demo/northline'

interface PreviewProps {
  onContinue: () => void
  allocation?: AllocationPreviewResponse
  group?: PersistentGroupDetail
  cart: NorthlineCart
}

function AllocationBreakdown({ allocation, group, cart }: Omit<PreviewProps, 'onContinue'>) {
  const itemShare = (itemId: string, memberId: string) => {
    const item = cart.items.find((candidate) => candidate.id === itemId)
    const assignment = allocation?.interpretation.assignments.find((candidate) => candidate.itemId === itemId)
    if (!item || !assignment) return null
    const index = assignment.memberIds.indexOf(memberId)
    return index < 0 ? null : splitEvenly(item.cents, assignment.memberIds.length)[index] ?? null
  }
  return <>
    <article className="allocation-card"><div className="allocation-items">{cart.items.map((item) => <div key={item.id}><small>{item.label.toUpperCase()}</small><strong>{formatUsd(item.cents)}</strong></div>)}</div>
      <div className="allocation-people">{allocation?.allocations?.map((row, index) => {
        const person = group?.members.find((member) => member.id === row.memberId)
        return <div key={row.memberId}><span className={`person-avatar ${['lime', 'lavender', 'sand', 'blue'][index % 4]}`}>{person?.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() ?? '?'}</span><p><strong>{person?.name ?? 'Unknown member'}</strong><small>{allocation?.interpretation.directAmounts ? 'Contribution toward the full receipt; item use not specified' : row.itemIds.map((itemId) => { const share = itemShare(itemId, row.memberId); const label = cart.items.find((item) => item.id === itemId)?.label ?? itemId; return `${label} ${share === null ? '' : formatUsd(share)}` }).join(' · ')}</small></p><b>{formatUsd(row.amountCents)}</b></div>
      })}</div></article>
    <p className="allocation-disclaimer">Exact reconciliation: <strong>{formatUsd(allocation?.reconciliation?.allocatedCents ?? 0)} / {formatUsd(allocation?.reconciliation?.receiptTotalCents ?? 0)} · difference {formatUsd(allocation?.reconciliation?.differenceCents ?? 0)}</strong></p>
  </>
}

function isReconciled(allocation: AllocationPreviewResponse | undefined, cart: NorthlineCart) {
  return !!allocation && allocation.reconciliation?.differenceCents === 0 && allocation.reconciliation.receiptTotalCents === cart.totalCents
}

export function SplitPreview({ onContinue, allocation, group, cart }: PreviewProps) {
  return <section className="inline-preview" aria-label="Split preview"><header><h2>Review the split</h2><span>No payment yet</span></header><AllocationBreakdown allocation={allocation} group={group} cart={cart} /><button className="checking-button" type="button" disabled={!isReconciled(allocation, cart)} onClick={onContinue}>Confirm split & invite participants <span>→</span></button></section>
}

export function AllocationPreview({ onBack, onContinue, allocation, group, cart }: PreviewProps & { onBack: () => void }) {
  return <main className="split-page">
    <header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onBack} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p><div className="group-profile"><strong>Your groups</strong><span>YC</span></div></header>
    <div className="checkout-utility"><button className="text-button" onClick={onBack} type="button">← Back to instructions</button><p>SPLIT / REVIEW</p><button className="close-button" onClick={onBack} type="button">×</button></div>
    <div className="split-layout allocation-layout"><section className="split-main"><p className="trip-kicker">SPLIT → REVIEW</p><h1>Every cent, in place.</h1><p className="allocation-subtitle">Review each item and share before inviting anyone.</p><AllocationBreakdown allocation={allocation} group={group} cart={cart} /><button className="checking-button" type="button" disabled={!isReconciled(allocation, cart)} onClick={onContinue}>Check permissions <span>→</span></button></section>
      <aside className="split-summary"><p>NORTHLINE TRAVEL · USD</p><h2>A long weekend. Four good friends.</h2><span>{cart.product} · {cart.dates}</span><div className="summary-items">{cart.items.map((item) => <div key={item.id}><span>{item.label}</span><strong>{formatUsd(item.cents)}</strong></div>)}</div><div className="summary-total"><p>TOTAL TO MERCHANT</p><strong>{formatUsd(cart.totalCents)}</strong><span>Taxes included · no WHOOSH fee</span></div><div className="summary-difference"><span>Reconciliation difference</span><strong>{formatUsd(allocation?.reconciliation?.differenceCents ?? 0)}</strong></div><p className="summary-footnote">No payment has been requested or captured.</p></aside></div>
  </main>
}
