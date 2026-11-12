import { WhooshLogo } from '../components/WhooshLogo'
import { useState } from 'react'
import { saveGroupContactEmail, type ParticipantApprovalLink, type PersistentCheckoutSession, type PersistentGroupDetail } from '../api/whoosh'
import type { NorthlineCart } from '../demo/northline'
import { CheckoutPhases } from '../components/CheckoutPhases'

interface AwaitingApprovalProps {
  onBack: () => void
  onLeave: () => void
  onContinue: () => void
  onIssueLinks: () => Promise<ParticipantApprovalLink[]>
  groupName: string
  group: PersistentGroupDetail
  onContactSaved?: (memberId: string, email: string) => void
  session: PersistentCheckoutSession
  cart: NorthlineCart
  error?: string
}

const money = (cents: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)

export function AwaitingApproval({ onBack, onLeave, onContinue, onIssueLinks, groupName, group, onContactSaved, session, cart, error }: AwaitingApprovalProps) {
  const [links, setLinks] = useState<ParticipantApprovalLink[]>(() => {
    try { return JSON.parse(window.sessionStorage.getItem(`whoosh-invites-${session.id}`) ?? '[]') as ParticipantApprovalLink[] }
    catch { return [] }
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [contacts, setContacts] = useState<Record<string, string>>({})
  const accepted = session.funding.filter((row) => row.consentStatus === 'consented').length
  const ready = accepted === session.funding.length && session.funding.length > 0
  const paymentStarted = session.paymentMode !== 'single_payer' || session.merchantPaymentStatus !== 'not_started' || !['active', 'authorized_unpaid'].includes(session.status)
  const canContinue = ready && !['completed', 'cancelled'].includes(session.status)

  const issueLinks = async () => {
    if (busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      const generated = await onIssueLinks()
      setLinks(generated)
      if (generated.length) window.sessionStorage.setItem(`whoosh-invites-${session.id}`, JSON.stringify(generated))
      if (generated.length === 0) setMessage('No new links are available. Refresh the approval status or check whether payment processing has begun.')
    }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Participant links could not be created.') }
    finally { setBusy(false) }
  }

  const linkFor = (token: string) => {
    const url = new URL(window.location.href)
    url.search = '?whoosh=participant'
    url.hash = token
    return url.toString()
  }

  const copyLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(linkFor(token))
      setMessage('Participant link copied. Share it privately with the named participant.')
    } catch { setMessage('Could not copy the link. Open it on this device or try again with clipboard access enabled.') }
  }

  const saveContact = async (memberId: string, email: string) => {
    setBusy(true)
    setMessage(undefined)
    try {
      const saved = await saveGroupContactEmail(group.group.id, memberId, email)
      setContacts((current) => ({ ...current, [memberId]: saved.contactEmail }))
      onContactSaved?.(memberId, saved.contactEmail)
      setMessage('Contact saved for this group. The address is unverified and no invitation was sent.')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Contact could not be saved.') }
    finally { setBusy(false) }
  }

  return <main className="split-page">
    <header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onBack} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p><div className="group-profile"><strong>{groupName}</strong><span>{session.funding.length}</span></div></header>
    <div className="checkout-utility"><button className="text-button" onClick={paymentStarted ? onContinue : onBack} type="button">← <span>{paymentStarted ? 'Back to funding' : 'Back to split'}</span></button><p>INVITE &amp; APPROVE</p><button className="close-button" onClick={onLeave} type="button" aria-label="Return to your groups">×</button></div>
    <CheckoutPhases current="invite" />
    <div className="split-layout approval-layout"><section className="split-main"><p className="trip-kicker">INVITE & APPROVE</p><h1>{ready ? 'Everyone is ready.' : 'Invite your group.'}</h1><p className="trip-subtitle">{ready ? 'Purchase consent is recorded. No one has been charged.' : 'Share each private link so participants can approve their exact amount.'}</p>
      <article className="shares-card"><header><h2>{groupName}</h2><span className={ready ? 'ready-badge' : ''}>•&nbsp; {accepted}/{session.funding.length} approved</span></header>
        {session.funding.map((row) => <div className="share-row" key={row.memberId}><span className="person-avatar lavender">{row.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><p><strong>{row.name}</strong><small>{row.consentStatus === 'consented' ? 'Allocation approved' : row.consentStatus === 'declined' ? 'Declined · can review a new link' : 'Approval needed'}</small></p><div><strong>{money(row.allocationCents, cart.currency)}</strong><small className={row.consentStatus === 'consented' ? 'ready-text' : 'approval-text'}>{row.consentStatus === 'consented' ? 'Ready' : row.consentStatus === 'declined' ? 'Declined' : 'Pending'}</small></div></div>)}
        <footer><span>Total allocated</span><strong>{money(session.funding.reduce((sum, row) => sum + row.allocationCents, 0), cart.currency)}</strong><span>Receipt total</span><strong>{money(cart.totalCents, cart.currency)}</strong></footer>
      </article>
      <aside className="approval-note"><span>♢</span><div><strong>{ready ? 'Consent is separate from payment' : 'Share participant-specific approval links'}</strong><p>{ready ? 'Any one-time approvals can still be withdrawn before payment starts. No payment has been authorized here.' : 'Each link lets one participant approve or decline this allocation. It does not collect payment or authorize a PayPal transaction.'}</p></div></aside>
      <div className="approval-actions">{!paymentStarted && <button type="button" disabled={busy} onClick={() => void issueLinks()}>{busy ? 'Creating links…' : 'Generate participant invite links'}</button>}{canContinue && <button type="button" onClick={onContinue}>Track participant payments</button>}<button type="button" onClick={onLeave}>Return to groups · checkout saved</button></div>
      {links.length > 0 && <section className="participant-links"><h2>Participant invites</h2>{links.map((link) => <div className="participant-link-row" key={`${link.participantName}-${link.purpose}`}><span>{link.participantName}</span><button type="button" onClick={() => void copyLink(link.token)}>Copy invite link</button></div>)}<p>Links expire in 24 hours. They are bearer links and do not verify identity. Share each privately with the matching participant.</p></section>}
      <details className="sandbox-controls"><summary>Saved group contacts</summary><p>Contact addresses are unverified and never authorize consent or payment. WHOOSH does not send approval links automatically.</p>{group.members.filter((member) => member.status === 'active').map((member) => <form className="sandbox-control-row" key={member.id} onSubmit={(event) => { event.preventDefault(); void saveContact(member.id, contacts[member.id] ?? member.contactEmail ?? '') }}><label>{member.name}<input type="email" required aria-label={`${member.name} contact email`} value={contacts[member.id] ?? member.contactEmail ?? ''} onChange={(event) => setContacts((current) => ({ ...current, [member.id]: event.target.value }))} placeholder="Add contact email once" /></label><button type="submit" disabled={busy}>Save contact</button></form>)}</details>
      {(error || message) && <p className={error ? 'sandbox-notice' : 'approval-status'} role={error ? 'alert' : 'status'}>{error ?? message}</p>}
      <p className="approval-status">{paymentStarted ? 'Payment processing has begun; this allocation and its approvals can no longer be changed.' : ready ? 'Consent is not payment. No one has been charged.' : <>Waiting for participant consent. <button onClick={onBack} type="button">Edit the split</button></>}</p>
    </section><aside className="split-summary"><p>{cart.merchant.toUpperCase()} · {cart.currency}</p><h2>{cart.product}</h2><span>{cart.reference} · {groupName}</span><div className="summary-items">{cart.items.map((item) => <div key={item.id}><span>{item.label}</span><strong>{money(item.cents, cart.currency)}</strong></div>)}</div><div className="summary-total"><p>TOTAL TO MERCHANT</p><strong>{money(cart.totalCents, cart.currency)}</strong><span>Taxes included · no WHOOSH fee</span></div><div className="summary-difference"><span>Allocation difference</span><strong>{money(session.funding.reduce((sum, row) => sum + row.allocationCents, 0) - cart.totalCents, cart.currency)}</strong></div><p className="summary-footnote">Each person funds their own share. No one fronts the group total.</p></aside></div>
    <p className="paypal-assurance">♙ &nbsp; Secure payments with PayPal</p><footer className="merchant-footer"><span>{cart.reference}&nbsp; · &nbsp;ALL AMOUNTS {cart.currency}</span><span>Need a hand? Get help</span></footer>
  </main>
}
