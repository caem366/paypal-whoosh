import { WhooshLogo } from '../components/WhooshLogo'
import { useCallback, useEffect, useState } from 'react'
import { askCheckoutCoordinator, cancelAndRefundIndependentCheckout, confirmSimulatedNorthlineBooking, createParticipantApprovalLinks, getIndependentPaymentCheckout, startIndependentPaymentCheckout, type IndependentPaymentCheckout, type ParticipantApprovalLink } from '../api/whoosh'
import { fundingPercentage } from './pay-track-progress'

const money = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'USD' }).format(cents / 100)
const moneyShort = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(cents / 100)
const statusCopy: Record<string, string> = {
  ready_to_pay: 'Awaiting PayPal payment', order_created: 'Awaiting PayPal approval', approved: 'PayPal approved · capturing', capturing: 'Confirming payment', paid_verified: 'Captured and verified', failed: 'Payment failed', cancelled: 'PayPal checkout not completed', refund_pending: 'Refund pending or under review', refunded: 'Refunded by PayPal', superseded: 'Replaced by a new attempt',
}
const fundingStatusCopy: Record<IndependentPaymentCheckout['fundingStatus'], string> = {
  awaiting_payments: 'Awaiting payments',
  partially_funded: 'Partially funded',
  fully_funded: 'Fully funded',
  needs_review: 'Funding needs review',
}

function purchaseTitle(cart: unknown) {
  if (typeof cart !== 'object' || cart === null || !('product' in cart)) return 'Group purchase'
  return typeof cart.product === 'string' ? cart.product : 'Group purchase'
}

export function IndependentPayerCheckout({ sessionId, onBack, onLeave, onFailure, onReturnToMerchant, onDemoModes }: { sessionId: string; onBack: () => void; onLeave: () => void; onFailure: () => void; onReturnToMerchant: () => void; onDemoModes?: () => void }) {
  const [checkout, setCheckout] = useState<IndependentPaymentCheckout>()
  const [links, setLinks] = useState<ParticipantApprovalLink[]>(() => { try { return JSON.parse(window.sessionStorage.getItem(`whoosh-invites-${sessionId}`) ?? '[]') as ParticipantApprovalLink[] } catch { return [] } })
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [agentQuestion, setAgentQuestion] = useState('')
  const [agentBusy, setAgentBusy] = useState(false)
  const [agentError, setAgentError] = useState('')
  const [agentMessages, setAgentMessages] = useState<Array<{ question: string; response: string; toolsUsed: string[] }>>([])
  const accept = useCallback((next: IndependentPaymentCheckout) => setCheckout(next), [])

  useEffect(() => {
    let active = true
    void getIndependentPaymentCheckout(sessionId)
      .then((existing) => ['completed', 'cancelled', 'failed'].includes(existing.session.status) ? existing : startIndependentPaymentCheckout(sessionId))
      .then((next) => { if (active) accept(next) })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'WHOOSH could not load participant payments.') })
    const timer = window.setInterval(() => {
      void getIndependentPaymentCheckout(sessionId).then((next) => { if (active) { accept(next); setError(undefined) } }).catch(() => { if (active) setError('Funding status could not be refreshed. Try again shortly.') })
    }, 4000)
    return () => { active = false; window.clearInterval(timer) }
  }, [sessionId, accept])

  const activeCommitments = checkout?.commitments.filter((commitment) => commitment.status !== 'superseded') ?? []
  const allPaid = checkout?.fullyVerified === true
  const recovering = ['recovery_required', 'refund_pending', 'refunded', 'cancelled'].includes(checkout?.session.bookingStatus ?? '')
  const expired = Boolean(checkout?.session.expiresAt && new Date(checkout.session.expiresAt) <= new Date())
  const capturedTotal = checkout?.commitments.reduce((sum, commitment) => sum + (commitment.capturedCents ?? 0), 0) ?? 0
  const refundedTotal = checkout?.commitments.reduce((sum, commitment) => sum + (commitment.refundedCents ?? 0), 0) ?? 0
  const progressPercent = checkout ? fundingPercentage(checkout.fundedCents, checkout.session.totalCents) : 0
  const askAgent = async (question = agentQuestion) => {
    const text = question.trim()
    if (!text || agentBusy) return
    setAgentBusy(true)
    setAgentError('')
    try {
      const answer = await askCheckoutCoordinator(sessionId, text)
      setAgentMessages((current) => [...current, { question: text, response: answer.response, toolsUsed: answer.toolsUsed }].slice(-4))
      setAgentQuestion('')
    } catch (reason) {
      setAgentError(reason instanceof Error ? reason.message : 'WHOOSH Agent could not check this checkout.')
    } finally {
      setAgentBusy(false)
    }
  }
  const recover = async () => { setBusy('recovery'); setError(undefined); try { accept(await cancelAndRefundIndependentCheckout(sessionId)) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Recovery status could not be verified.') } finally { setBusy(undefined) } }
  const restoreLinks = async () => { setBusy('links'); setError(undefined); try { const { links: generated } = await createParticipantApprovalLinks(sessionId); setLinks(generated); window.sessionStorage.setItem(`whoosh-invites-${sessionId}`, JSON.stringify(generated)) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Checkout links could not be restored.') } finally { setBusy(undefined) } }
  const acknowledge = async () => { setBusy('booking'); setError(undefined); try { accept(await confirmSimulatedNorthlineBooking(sessionId)) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Demo booking could not be acknowledged.') } finally { setBusy(undefined) } }
  const copyLink = async (token: string) => {
    const url = new URL(window.location.href); url.search = '?whoosh=participant'; url.hash = token
    try { await navigator.clipboard.writeText(url.toString()); setError(undefined) }
    catch { setError('Could not copy the invitation link. Check browser clipboard access.') }
  }

  return <main className="split-page pay-track-page">
    <header className="merchant-header">
      <button className="whoosh-brand brand-button" onClick={onLeave} type="button"><WhooshLogo /></button>
      <p className="brand-tagline">Split now. Not later.</p>
      <button className="group-profile group-profile-button" onClick={onLeave} type="button"><strong>Your groups</strong><span>YC</span></button>
    </header>
    <div className="checkout-utility pay-track-utility">
      <button className="text-button" onClick={onBack} type="button">← Back to approvals</button>
      <p>SPLIT › INVITE › PAY › TRACK</p>
      <button className="close-button" onClick={onLeave} type="button" aria-label="Return to your groups">×</button>
    </div>
    <div className="pay-track-shell">
      <div className="pay-track-grid">
        <section className="pay-track-main">
          <div className="pay-track-heading">
            <div><p className="trip-kicker">{checkout?.session.merchant.toUpperCase() ?? 'NORTHLINE TRAVEL'} · {checkout ? purchaseTitle(checkout.session.cart).toUpperCase() : 'GROUP PURCHASE'}</p>
              <h1>Group payment overview</h1>
              <p>Track funding, participant payments, and next steps for this shared purchase.</p></div>
            <span className="pay-track-status">{checkout ? fundingStatusCopy[checkout.fundingStatus] : 'Loading payments'}</span>
          </div>
          <article className="pay-track-funding-card" aria-label="Verified funding overview">
            <div className="pay-track-funding-top">
              <div><span>Total verified funding</span><p><strong>{checkout ? moneyShort(checkout.fundedCents) : '—'}</strong><span> / {checkout ? moneyShort(checkout.session.totalCents) : '—'}</span></p></div>
              <div className="pay-track-percent"><strong>{progressPercent.toFixed(1)}%</strong><span>funded</span></div>
            </div>
            <div className="pay-track-progress" role="progressbar" aria-label="Verified group funding" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><i style={{ width: `${progressPercent}%` }} /></div>
            <div className="pay-track-metrics">
              <div><span className="pay-track-metric-icon" aria-hidden="true">♙</span><p>Participants paid<strong>{checkout ? `${checkout.fundedParticipants} / ${checkout.participantCount}` : '—'}</strong></p></div>
              <div><span className="pay-track-metric-icon" aria-hidden="true">▤</span><p>Still needed<strong>{checkout ? moneyShort(checkout.remainingCents) : '—'}</strong></p></div>
              <div><span className="pay-track-metric-icon" aria-hidden="true">✓</span><p>Total purchase<strong>{checkout ? moneyShort(checkout.session.totalCents) : '—'}</strong></p></div>
            </div>
          </article>
          <article className="pay-track-contributions">
            <header><h2>Participant contributions</h2><span>{checkout ? `${checkout.fundedParticipants} of ${checkout.participantCount} verified` : 'Loading…'}</span></header>
            {activeCommitments.map((commitment, index) => <div className="pay-track-contribution" key={commitment.id}>
              <span className={`person-avatar ${['lime', 'lavender', 'sand', 'blue'][index % 4]}`}>{commitment.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span>
              <div className="pay-track-contribution-copy"><strong>{commitment.name}</strong><small>{statusCopy[commitment.status] ?? commitment.status}</small>
                {commitment.status === 'paid_verified' && !commitment.expectedPayerEmail && <small>PayPal capture verified; participant identity unverified</small>}
                {commitment.failureMessage && <small className="payment-error-detail">{commitment.failureMessage}</small>}</div>
              <strong className="pay-track-contribution-amount">{money(commitment.allocationCents)}</strong>
              <span className={`pay-track-contribution-status ${commitment.status === 'paid_verified' ? 'is-paid' : ''}`}>{commitment.status === 'paid_verified' ? '✓ Paid' : commitment.status === 'refunded' ? 'Refunded' : commitment.status === 'refund_pending' ? 'Refund pending' : commitment.status === 'failed' ? 'Failed' : 'Pending'}</span>
            </div>)}
            {!checkout && <p className="pay-track-loading">Loading verified payment records…</p>}
          </article>
          {checkout?.fundingStatus === 'needs_review' && <p className="sandbox-notice" role="alert">A payment does not reconcile with this purchase and is excluded from verified funding. Review the PayPal capture before proceeding.</p>}
          {allPaid && <div className="pay-track-action"><p role="status">All {checkout?.fundedParticipants} captures reconcile to {money(checkout?.session.totalCents ?? 0)}. Group funding is complete; simulated merchant booking: {checkout?.merchantBooking?.status ?? 'unavailable'}.</p>
            {checkout?.session.bookingStatus === 'merchant_booking_pending' && ['pending', 'confirmation_pending'].includes(checkout?.merchantBooking?.status ?? '') && <button className="preview-button payment-action" type="button" disabled={Boolean(busy)} onClick={() => void acknowledge()}>Confirm simulated booking</button>}
            {checkout?.session.bookingStatus === 'confirmed_simulated' && <button className="preview-button payment-action" type="button" onClick={onReturnToMerchant}>View simulated booking confirmation</button>}
            {checkout?.merchantBooking?.failureReason && <p className="sandbox-notice" role="alert">Simulated Northline could not confirm: {checkout.merchantBooking.failureReason}</p>}</div>}
          {recovering && <p className="sandbox-notice" role="status">Recovery: {checkout?.session.bookingStatus?.replaceAll('_', ' ')}. Captured {money(capturedTotal)}; verified refunds {money(refundedTotal)}. Any difference is still pending.</p>}
          {error && <p className="sandbox-notice" role="alert">{error}</p>}
          {checkout && !['confirmed_simulated', 'refunded', 'cancelled'].includes(checkout.session.bookingStatus) && <button className="manual-button pay-track-recovery" type="button" disabled={Boolean(busy)} onClick={() => void recover()}>{busy === 'recovery' ? 'Checking PayPal refunds…' : recovering ? 'Check refund status' : 'Cancel checkout and refund captured shares'}</button>}
        </section>
        <aside className="pay-track-side">
          <section className="pay-track-agent" aria-label="WHOOSH Agent">
            <header><span className="pay-track-agent-mark" aria-hidden="true">✦</span><div><h2>WHOOSH Agent</h2><p>Your AI checkout coordinator</p></div><span className="pay-track-readonly">♙ Read-only</span></header>
            <div className="pay-track-chat">
              <div className="pay-track-chat-messages" aria-live="polite">
                {!agentMessages.length && <p className="pay-track-chat-intro">Ask about this checkout. The agent checks WHOOSH records before answering.</p>}
                {agentMessages.map((message, index) => <article className="pay-track-chat-turn" key={`${index}-${message.question}`}>
                  <p className="pay-track-chat-user">{message.question}</p>
                  <p className="pay-track-chat-answer"><span aria-hidden="true">✦</span><span>{message.response}</span></p>
                  <small>Checked read-only tools: {message.toolsUsed.join(', ')}</small>
                </article>)}
                {agentBusy && <p role="status">Checking checkout records…</p>}
                {agentError && <p className="pay-track-chat-error" role="alert">{agentError}</p>}
              </div>
              <p className="pay-track-agent-assurance">◈ Agent answers use read-only WHOOSH records. PayPal captures remain the verified payment source.</p>
              <div className="checkout-agent-starters">{["Who's paid?", 'How much is left?', 'What happens next?'].map((prompt) => <button key={prompt} type="button" disabled={agentBusy} onClick={() => void askAgent(prompt)}>{prompt}</button>)}</div>
              <form className="checkout-agent-form" onSubmit={(event) => { event.preventDefault(); void askAgent() }}>
                <label className="pay-track-sr-only" htmlFor="checkout-agent-question">Ask about this checkout</label>
                <input id="checkout-agent-question" value={agentQuestion} onChange={(event) => setAgentQuestion(event.target.value)} maxLength={1000} placeholder="Ask about this checkout…" disabled={agentBusy} />
                <button type="submit" aria-label="Ask WHOOSH Agent" disabled={agentBusy || agentQuestion.trim().length < 2}>{agentBusy ? '…' : '↑'}</button>
              </form>
            </div>
          </section>
          <details className="pay-track-links">
            <summary><span aria-hidden="true">↗</span><span><strong>Participant checkout links</strong><small>Share private links for participants to approve and pay their share.</small></span><span aria-hidden="true">⌄</span></summary>
            <div className="pay-track-links-body"><p>Participants approve their share, then approve their own PayPal Sandbox payment. No organizer-entered PayPal email is needed.</p>
              {links.map((link) => <div className="participant-link-row" key={link.participantName}><span>{link.participantName}</span><button type="button" onClick={() => void copyLink(link.token)}>Copy invite link</button></div>)}
              {!links.length && <p>Invitation links are not saved in this browser tab.</p>}
              {expired && <p className="sandbox-notice" role="status">This Northline checkout has expired. Start a new purchase to invite participants.</p>}
              {!expired && checkout?.session.bookingStatus === 'awaiting_payments' && activeCommitments.length > 0 && activeCommitments.every((row) => row.status === 'ready_to_pay' && !row.providerOrderId && !row.providerCaptureId) && <button className="manual-button" type="button" disabled={Boolean(busy)} onClick={() => void restoreLinks()}>{busy === 'links' ? 'Generating links…' : links.length ? 'Generate fresh links' : 'Generate checkout links'}</button>}
            </div>
          </details>
          <details className="sandbox-controls pay-track-developer"><summary>Developer Mode</summary><p>PayPal uses separate orders; captures are not atomic. Refund recovery and booking acknowledgment are tracked separately.</p>
            <button className="processing-links failure-demo-link" type="button" onClick={onFailure}>Explore simulated failure recovery</button>{onDemoModes && <button className="processing-links failure-demo-link" type="button" onClick={onDemoModes}>Other demo payment modes</button>}
          </details>
        </aside>
      </div>
    </div>
  </main>
}
