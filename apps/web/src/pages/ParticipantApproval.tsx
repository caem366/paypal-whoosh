import { useEffect, useState } from 'react'
import { decideParticipantApproval, inspectParticipantApproval, openParticipantPayPalOrder, type ParticipantApproval as ApprovalDetails } from '../api/whoosh'
import './ParticipantApproval.css'

const money = (cents: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)

export function ParticipantApproval() {
  const [token, setToken] = useState(() => window.location.hash.slice(1))
  const [approval, setApproval] = useState<ApprovalDetails>()
  const [loading, setLoading] = useState(() => Boolean(window.location.hash.slice(1)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    let active = true
    if (!token) {
      return () => { active = false }
    }
    const refresh = () => inspectParticipantApproval(token).then(({ approval: details }) => {
      if (active) setApproval(details)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'This participant link could not be loaded.')
    }).finally(() => { if (active) setLoading(false) })
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 4000)
    return () => { active = false; window.clearInterval(timer) }
  }, [token])

  const beginPayment = async () => {
    if (busy) return
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const result = await openParticipantPayPalOrder(token)
      if (result.mode !== 'sandbox' || !result.commitment.approvalUrl) throw new Error('PayPal Sandbox did not return an approval link. No payment was captured.')
      window.sessionStorage.setItem(`whoosh-participant-${result.commitment.id}`, token)
      window.location.assign(result.commitment.approvalUrl)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'PayPal checkout could not be opened.') }
    finally { setBusy(false) }
  }

  const decide = async (decision: 'approve' | 'decline' | 'withdraw') => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await decideParticipantApproval(token, decision)
      if (result.withdrawalToken) {
        const nextToken = result.withdrawalToken
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${nextToken}`)
        setLoading(true)
        setToken(nextToken)
        setNotice('Your approval is recorded. Keep this link if you need to withdraw before payment begins.')
      } else if (decision === 'withdraw') {
        setApproval((current) => current ? { ...current, consentStatus: result.consentStatus, canDecide: false, canWithdraw: false } : current)
        setNotice('Your approval has been withdrawn. Ask the organizer for a new approval link if you want to decide again.')
      } else {
        setApproval((current) => current ? { ...current, consentStatus: result.consentStatus, canDecide: false, canWithdraw: false } : current)
        setNotice(decision === 'approve' ? 'Your approval is recorded. No payment has been made.' : 'You declined this purchase. No payment has been made.')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your decision could not be saved.')
    } finally { setBusy(false) }
  }

  if (loading) return <main className="maya-page"><div className="phone-shell"><section className="maya-content"><p role="status">Loading participant approval…</p></section></div></main>
  if ((error || !token) && !approval) return <main className="maya-page"><div className="phone-shell"><section className="maya-content"><p className="trip-kicker">PARTICIPANT APPROVAL</p><h1>Link unavailable</h1><p className="sandbox-notice" role="alert">{error ?? 'This participant link is missing its access token. Ask the organizer to generate a new link.'}</p></section></div></main>
  if (!approval) return null

  const statusText = approval.consentStatus === 'consented' ? 'Approved' : approval.consentStatus === 'declined' ? 'Declined' : 'Awaiting your decision'
  return <main className="maya-page participant-approval-page">
    <div className="phone-shell">
      <div className="phone-status"><span>WHOOSH</span><span>Local demo</span></div>
      <header className="maya-header"><strong>Participant approval</strong></header>
      <section className="maya-content">
        <p className="trip-kicker">YOUR SHARE · {approval.groupName}</p>
        <h1>{approval.merchant}</h1>
        <p className="participant-specific-name">Approval for {approval.participantName}</p>
        <p className="maya-intro">Review your share of this simulated Northline purchase. PayPal approval is a separate step.</p>
        <article className="maya-share-card">
          <header><div><strong>{approval.merchant}</strong><p>Reference {approval.reference}</p></div></header>
          <p className="maya-label">YOUR PROPOSED SHARE · {approval.currency}</p>
          <strong className="maya-amount">{money(approval.amountCents, approval.currency)}</strong>
          <p>Group purchase total: {money(approval.purchaseTotalCents, approval.currency)}</p>
          <div className="participant-items">{approval.items.map((item) => <div className="maya-item" key={item.id}><span>{item.label}</span><strong>{money(item.amountCents, approval.currency)}</strong></div>)}</div>
          <p>Status: <strong>{statusText}</strong></p>
        </article>
        <aside className="maya-limit-note"><span>i</span><div><strong>Two approvals</strong><p>WHOOSH records your share approval here. PayPal will separately ask you to approve your own payment.</p></div></aside>
        {approval.paymentStarted && <p className="sandbox-notice" role="status">Payment processing has started, so this approval can no longer be changed.</p>}
        {!approval.paymentStarted && approval.canDecide && <div className="participant-actions">
          <button className="maya-approve" disabled={busy} type="button" onClick={() => void decide('approve')}>{busy ? 'Saving…' : `Approve ${money(approval.amountCents, approval.currency)}`} <span>✓</span></button>
          <button className="maya-decline" disabled={busy} type="button" onClick={() => void decide('decline')}>Decline this purchase</button>
        </div>}
        {!approval.paymentStarted && approval.canWithdraw && <button className="maya-decline participant-withdraw" disabled={busy} type="button" onClick={() => void decide('withdraw')}>{busy ? 'Saving…' : 'Withdraw approval'}</button>}
        {!approval.paymentStarted && !approval.canDecide && !approval.canWithdraw && approval.consentStatus === 'pending' && <p className="approval-status" role="status">This link is no longer active. Ask the organizer for a current participant link.</p>}
        {approval.consentStatus === 'consented' && approval.paymentReady && !['paid_verified', 'approved', 'capturing', 'refund_pending', 'refunded', 'superseded'].includes(approval.paymentStatus ?? '') && <button className="maya-approve" disabled={busy} type="button" onClick={() => void beginPayment()}>{busy ? 'Opening PayPal…' : approval.paymentStatus === 'order_created' ? 'Continue to PayPal' : `Pay ${money(approval.amountCents, approval.currency)} with PayPal`}</button>}
        {approval.consentStatus === 'consented' && !approval.paymentReady && <p className="approval-status" role="status">Your share is approved. Waiting for the remaining participants before PayPal checkout opens.</p>}
        {approval.paymentStatus === 'paid_verified' && <p className="approval-status" role="status">PayPal capture verified for {money(approval.amountCents, approval.currency)}. {approval.payerIdentityVerified ? 'Payer identity matched.' : 'The PayPal payer was recorded; this invitation does not verify personal identity.'}</p>}
        {approval.paymentStatus === 'refund_pending' && <p className="approval-status" role="status">Refund recovery is pending. Your share is not counted as funded.</p>}
        {notice && <p className="approval-status" role="status">{notice}</p>}
        {error && <p className="sandbox-notice" role="alert">{error}</p>}
        <p className="maya-privacy">Local Sandbox demo only. This bearer link does not verify identity. Anyone with the link may act for this participant until it expires.</p>
      </section>
      <div className="phone-home" />
    </div>
  </main>
}
