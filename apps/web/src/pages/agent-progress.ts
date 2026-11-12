import type { AgentProposal, PersistentCheckoutSession } from '../api/whoosh'

export function agentProgress(proposal: AgentProposal | null, session: PersistentCheckoutSession | null) {
  const captures = session?.funding.filter((row) => row.fundingStatus === 'verified').length ?? 0
  const total = session?.funding.length ?? proposal?.participants.length ?? 4
  const recovering = !!session && ['recovery_required', 'refund_pending', 'refunded', 'cancelled'].includes(session.bookingStatus)
  return [
    { number: 1, label: 'Purchase intent', detail: proposal ? 'Interpreted from your request' : 'Describe the purchase', state: proposal ? 'complete' : 'current' },
    { number: 2, label: 'Validate the split', detail: proposal ? `${total} shares · exact cents` : 'Receipt and constraints', state: proposal ? 'complete' : 'pending' },
    { number: 3, label: 'Organizer approval', detail: session ? 'Checkout prepared' : 'Review before checkout', state: session ? 'complete' : proposal ? 'current' : 'pending' },
    { number: 4, label: 'Participant payments', detail: recovering ? 'Recovery or refunds in progress' : session ? `${captures}/${total} verified captures` : 'Each payer approves in PayPal', state: !recovering && captures === total && total > 0 ? 'complete' : session ? 'current' : 'pending' },
    { number: 5, label: 'Merchant booking', detail: session?.bookingStatus === 'confirmed_simulated' ? 'Simulated booking confirmed' : recovering ? 'Booking not confirmed' : 'Only after full verified funding', state: session?.bookingStatus === 'confirmed_simulated' ? 'complete' : 'pending' },
  ]
}
