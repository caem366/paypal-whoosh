import { WhooshLogo } from '../components/WhooshLogo'
import { useEffect, useState } from 'react'
import { confirmAgentProposal, createAgentProposal, editAgentAllocation, getAgentProposal, getPersistentCheckoutSession, listPersistentGroups, type AgentProposal, type PersistentCheckoutSession, type PersistentGroupSummary } from '../api/whoosh'
import { agentProgress } from './agent-progress'

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const starter = 'Plan the Northline Montréal trip for our group. Split tickets four ways, the upgrade between the first two members, and the shuttle between the first three.'

export function AgentPurchase({ initialGroupId, proposalId, onBack, onProposal, onRevise, onContinue }: {
  initialGroupId?: string
  proposalId?: string
  onBack: () => void
  onProposal: (id: string) => void
  onRevise: (groupId: string) => void
  onContinue: (groupId: string, sessionId: string) => void
}) {
  const [groups, setGroups] = useState<PersistentGroupSummary[]>([])
  const [groupId, setGroupId] = useState(initialGroupId ?? '')
  const [request, setRequest] = useState('')
  const [proposal, setProposal] = useState<AgentProposal | null>(null)
  const [session, setSession] = useState<PersistentCheckoutSession | null>(null)
  const [questions, setQuestions] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [assignments, setAssignments] = useState<AgentProposal['assignments']>([])

  useEffect(() => {
    let active = true
    listPersistentGroups().then((rows) => { if (active) { setGroups(rows); setGroupId((current) => current || rows[0]?.id || '') } }).catch(() => active && setError('Could not load saved groups.'))
    if (proposalId) getAgentProposal(proposalId).then((saved) => { if (active) { setProposal(saved); setGroupId(saved.groupId); setRequest(saved.request); setAssignments(saved.assignments) } }).catch(() => active && setError('Could not restore this AI proposal.'))
    return () => { active = false }
  }, [proposalId])

  useEffect(() => {
    if (!proposal?.checkoutSessionId) return
    let active = true
    const refresh = () => getPersistentCheckoutSession(proposal.checkoutSessionId!).then((saved) => { if (active) setSession(saved) }).catch(() => { if (active) setError('Checkout progress is temporarily unavailable. Open checkout to retry.') })
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [proposal?.checkoutSessionId])

  const generate = async () => {
    setBusy(true); setError(''); setQuestions([])
    try {
      const result = await createAgentProposal(groupId, request)
      if (result.status === 'NEEDS_CLARIFICATION') setQuestions(result.questions)
      else { setProposal(result); setAssignments(result.assignments); onProposal(result.id) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'WHOOSH could not prepare a purchase proposal.') }
    finally { setBusy(false) }
  }

  const saveAllocation = async () => {
    if (!proposal) return
    setBusy(true); setError('')
    try { const saved = await editAgentAllocation(proposal.id, assignments); setProposal(saved); setAssignments(saved.assignments); setEditing(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The allocation could not be saved.') }
    finally { setBusy(false) }
  }

  const confirm = async () => {
    if (!proposal) return
    setBusy(true); setError('')
    try { const checkout = await confirmAgentProposal(proposal.id); onContinue(checkout.groupId, checkout.sessionId) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The checkout could not be created.') }
    finally { setBusy(false) }
  }

  const toggle = (itemId: string, memberId: string) => setAssignments((current) => current.map((assignment) => assignment.itemId !== itemId ? assignment : ({ ...assignment, memberIds: assignment.memberIds.includes(memberId) ? assignment.memberIds.filter((id) => id !== memberId) : [...assignment.memberIds, memberId] })))
  const progress = agentProgress(proposal, session)
  const groupName = groups.find((group) => group.id === groupId)?.name ?? 'your group'

  return <main className="split-page agent-purchase-page">
    <header className="merchant-header"><button className="whoosh-brand brand-button" type="button" onClick={onBack}><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p><strong className="agent-header-label">AI purchasing assistant</strong></header>
    <div className="agent-purchase-shell">
      <nav className="agent-topline" aria-label="Agent navigation"><button className="text-button" type="button" onClick={onBack}>← Your groups</button><span>AI proposal · human-approved checkout</span></nav>
      <div className="agent-workspace">
        <section className="agent-conversation" aria-labelledby="agent-title">
          <div className="agent-intro"><p className="trip-kicker">WHOOSH AGENT</p><h1 id="agent-title">Make plans together.</h1><p>Your AI-powered group purchasing assistant. Describe the purchase and split; your group approves before any payment.</p></div>
          <div className="agent-thread" aria-live="polite">
            <div className="agent-chat agent-chat-assistant"><WhooshLogo iconOnly className="agent-chat-icon" /><div><strong>WHOOSH Agent</strong><p>I can prepare the simulated Northline Montréal trip for four people in a saved group. Tell me who shares each receipt item, or give each person a total contribution.</p></div></div>
            {proposal && <div className="agent-chat agent-chat-user"><div><strong>Your request</strong><p>{proposal.request}</p></div></div>}
            {proposal && <div className="agent-chat agent-chat-assistant"><WhooshLogo iconOnly className="agent-chat-icon" /><div><strong>Proposal ready for review</strong><p>I matched the saved group to the Northline receipt and checked the allocation in integer cents. Review the shares and assumptions before preparing checkout.</p></div></div>}
            {questions.length > 0 && <div className="agent-chat agent-chat-assistant" role="alert"><span className="agent-chat-icon" aria-hidden="true">?</span><div><strong>I need a little more detail</strong>{questions.map((question) => <p key={question}>{question}</p>)}</div></div>}
            {busy && <p className="agent-working" role="status">{editing ? 'Validating the updated allocation…' : 'Working with the saved group and receipt…'}</p>}
            {error && <p className="agent-error" role="alert">{error}</p>}
          </div>
          {!proposal && <div className="agent-composer">
            <label className="agent-field" htmlFor="agent-group">Purchase with</label><select id="agent-group" value={groupId} disabled={busy} onChange={(event) => setGroupId(event.target.value)}><option value="">Select a saved group</option>{groups.map((group) => <option value={group.id} key={group.id}>{group.name} · {group.memberCount} people</option>)}</select>
            <label className="agent-field" htmlFor="agent-request">Describe your group purchase</label><textarea id="agent-request" rows={4} value={request} disabled={busy} onChange={(event) => setRequest(event.target.value)} placeholder="Plan the Montréal trip. Split tickets four ways; tell me who shares the upgrade and shuttle." />
            <div className="agent-composer-footer"><small>Item-based requests may go to the configured AI provider. Exact contribution requests are checked locally. Payment details do not.</small><button className="preview-button" type="button" disabled={busy || !groupId || request.trim().length < 10} onClick={() => void generate()}>{busy ? 'Preparing…' : 'Create proposal →'}</button></div>
            <div className="agent-starters"><span>Try a starting point</span><button type="button" onClick={() => setRequest(starter)} disabled={busy}>Four-way Northline trip ↗</button></div>
          </div>}
          {proposal && <section className="agent-activity" aria-labelledby="agent-activity-title"><h2 id="agent-activity-title">What the agent checked</h2><ol><li><strong>Group retrieved</strong><span>{groupName} · {proposal.participants.length} active participants</span></li><li><strong>Receipt matched</strong><span>Simulated Northline · {money(proposal.totalCents)} USD</span></li><li><strong>Allocation validated</strong><span>Exact difference: {money(proposal.reconciliation.differenceCents)}</span></li><li><strong>Spending constraints checked</strong><span>Individual consent remains required before payment</span></li></ol></section>}
        </section>
        <aside className="agent-purchase-panel" aria-label="Live purchase status">
          <div className="agent-panel-head"><WhooshLogo iconOnly className="agent-panel-mark" /><div><strong>Purchase workspace</strong><small>{proposal ? 'Validated proposal' : 'Awaiting your request'}</small></div><span className="agent-state-pill">{!proposal ? 'Draft' : !session ? proposal.checkoutSessionId ? 'Loading checkout' : 'Proposal ready' : session.bookingStatus === 'confirmed_simulated' ? 'Booking confirmed' : ['recovery_required', 'refund_pending', 'refunded', 'cancelled'].includes(session.bookingStatus) ? 'Recovery' : session.bookingStatus === 'merchant_booking_pending' ? 'Funding verified' : 'Checkout prepared'}</span></div>
          <ol className="agent-steps" aria-label="Purchase progress">{progress.map((step) => <li key={step.label} data-state={step.state}><span aria-hidden="true">{step.state === 'complete' ? '✓' : step.number}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></li>)}</ol>
          <div className="agent-purchase-summary"><div className="agent-summary-title"><span>MERCHANT</span><strong>{proposal?.merchant ?? 'Northline Travel'}</strong><small>{proposal?.product ?? 'Montréal Weekend Escape'} · simulated merchant · USD</small></div><div className="agent-summary-total"><span>Purchase total</span><strong>{proposal ? money(proposal.totalCents) : '—'}</strong></div><div className="agent-summary-members"><span>PARTICIPANTS</span>{proposal ? proposal.participants.map((person) => { const funding = session?.funding.find((row) => row.memberId === person.id); const permission = proposal.permissions.find((row) => row.memberId === person.id); return <div className="agent-member" key={person.id}><span className="agent-avatar" aria-hidden="true">{person.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><span className="agent-member-copy">{person.name}<small>{funding?.fundingStatus === 'verified' ? 'Capture verified' : funding?.consentStatus === 'consented' ? 'Approved · payment pending' : funding ? 'Awaiting participant consent' : permission?.status === 'ready' ? 'Within saved limit · consent required' : permission?.reason ?? 'Approval required'}{permission?.limitCents != null ? ` · limit ${money(permission.limitCents)}` : ''}</small></span><strong>{money(person.amountCents)}</strong></div> }) : <p>Select a group and describe the split to see participant shares.</p>}</div>{session && <p className="agent-funding-note">{['recovery_required', 'refund_pending', 'refunded', 'cancelled'].includes(session.bookingStatus) ? 'Payment recovery or refunds are in progress.' : `${session.funding.filter((row) => row.fundingStatus === 'verified').length}/${session.funding.length} verified PayPal captures`}{' · '}{session.bookingStatus === 'confirmed_simulated' ? 'simulated booking confirmed' : 'booking not confirmed'}</p>}</div>
        </aside>
      </div>
      {proposal && <section className="agent-review" aria-labelledby="agent-review-title"><div className="agent-review-heading"><div><p className="trip-kicker">ORGANIZER REVIEW · AI PROPOSAL</p><h2 id="agent-review-title">{proposal.product}</h2><p>{proposal.merchant} · simulated merchant · {proposal.currency}</p></div><strong>{money(proposal.totalCents)}</strong></div>
        <p className="agent-reconcile">Exact reconciliation: {money(proposal.reconciliation.allocatedCents)} allocated · {money(proposal.reconciliation.differenceCents)} difference</p>
        {editing ? <div className="agent-allocation-edit"><h3>Edit item allocation</h3><p>Choose who shares each item. WHOOSH will recalculate every cent before saving.</p>{proposal.items.map((item) => <fieldset key={item.id}><legend>{item.label} · {money(item.cents)}</legend><div>{proposal.participants.map((person) => <label key={person.id}><input type="checkbox" checked={assignments.find((row) => row.itemId === item.id)?.memberIds.includes(person.id) ?? false} onChange={() => toggle(item.id, person.id)} /> {person.name}</label>)}</div></fieldset>)}<div className="agent-actions"><button type="button" className="preview-button" disabled={busy} onClick={() => void saveAllocation()}>Validate & save allocation</button><button type="button" className="manual-button" disabled={busy} onClick={() => { setAssignments(proposal.assignments); setEditing(false) }}>Cancel edit</button></div></div> : <><div className="agent-review-grid"><div><h3>Participant shares</h3>{proposal.participants.map((person) => <div className="agent-share-row" key={person.id}><span>{person.name}<small>{proposal.directAmounts ? 'Contribution toward the full receipt; item use not specified' : proposal.allocations.find((row) => row.memberId === person.id)?.itemIds.map((id) => proposal.items.find((item) => item.id === id)?.label ?? id).join(' · ')}</small></span><strong>{money(person.amountCents)}</strong></div>)}</div><div><h3>Assumptions & checks</h3>{proposal.assumptions.length ? <ul>{proposal.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul> : <p>No extra assumptions recorded.</p>}{proposal.questions.length > 0 && <ul>{proposal.questions.map((question) => <li key={question}>{question}</li>)}</ul>}<p>Saved spending limits were checked. Each payer must still give explicit consent and approve their own PayPal payment.</p></div></div><p className="agent-disclaimer">AI-generated proposal only. No payment has been requested by this action. Northline booking is simulated and occurs only after verified full funding.</p><div className="agent-actions"><button className="preview-button" type="button" disabled={busy || proposal.questions.length > 0} onClick={() => void confirm()}>{busy ? 'Preparing checkout…' : proposal.checkoutSessionId ? 'Resume checkout →' : 'Approve & prepare checkout →'}</button><button className="manual-button" type="button" disabled={busy || !!proposal.checkoutSessionId} onClick={() => { setAssignments(proposal.assignments); setEditing(true) }}>Edit allocation</button><button className="manual-button" type="button" disabled={busy} onClick={() => { onRevise(proposal.groupId); setProposal(null); setQuestions([]); setSession(null) }}>Cancel</button></div></>}
      </section>}
    </div>
  </main>
}
