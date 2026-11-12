export type AccountType =
  | 'member_wallet'
  | 'member_expense'
  | 'member_payable'
  | 'member_receivable'

export type SettlementStatus =
  | 'pending'
  | 'processing'
  | 'settled'
  | 'failed'
  | 'cancelled'

export interface GroupAccount {
  id: string
  type: AccountType
  normalBalance: 'debit' | 'credit'
  balanceCents: number
}

export interface GroupMember {
  memberId: string
  userId: string
  displayName: string
  status: 'active' | 'archived'
  joinedAt: string
  walletBalanceCents: number
  accounts: GroupAccount[]
}

export interface GroupSettlement {
  id: string
  transactionId: string
  debtorMemberId: string
  creditorMemberId: string
  merchant: string
  transactionCreatedAt: string
  amountCents: number
  currency: string
  status: SettlementStatus
  attemptCount: number
  failureReason: string | null
  createdAt: string
  settledAt: string | null
}

export interface GroupDetail {
  group: {
    id: string
    name: string
    currency: string
    createdAt: string
  }
  members: GroupMember[]
  settlements: GroupSettlement[]
}

export interface CreateSandboxTransactionRequest {
  groupId: string
  payerMemberId: string
  merchant: string
  totalCents: number
  splitMethod: 'equal'
  participantMemberIds: string[]
}

export interface SandboxTransactionResponse {
  transaction: {
    id: string
    merchant: string
    totalCents: number
    payerMemberId: string
    status: string
  }
  allocations: Array<{ responsibleMemberId: string; amountCents: number }>
  settlements: GroupSettlement[]
  settlementPlan?: Array<{
    debtorMemberId: string
    creditorMemberId: string
    amountCents: number
  }>
  idempotent: boolean
}

export interface SandboxSessionResponse {
  groupId: string
}

export type SettlementSimulation =
  | 'success'
  | 'forced_failure'
  | 'insufficient_funds'

export type WhooshApiError = Error & { status: number; payload: unknown }

export interface AllocationPreviewResponse {
  interpretation: { status: 'READY' | 'NEEDS_CLARIFICATION'; assignments: Array<{ itemId: string; memberIds: string[] }>; directAmounts?: boolean; clarifications: string[] }
  needsClarification: boolean
  allocations?: Array<{ memberId: string; amountCents: number; itemIds: string[] }>
  reconciliation?: { receiptTotalCents: number; allocatedCents: number; differenceCents: number }
  permissions?: Array<{ memberId: string; amountCents: number; status: 'ready' | 'approval_required' | 'blocked'; reason?: string }>
}

export interface PayPalOrderResponse {
  orderId: string
  approvalUrl?: string
  mode: 'sandbox' | 'mock'
  disclaimer: string
}

export interface PayPalCaptureResponse {
  orderId: string
  captureId: string
  status: 'COMPLETED'
  mode: 'sandbox'
  disclaimer: string
}

export interface VoiceTranscriptionResponse {
  transcript: string
  model: string
}

export interface PersistentGroupSummary { id: string; name: string; currency: string; updatedAt?: string; memberCount: number; purchaseCount: number; activeCheckoutCount: number }
export interface PersistentGroupDetail { group: { id: string; name: string; currency: string }; members: Array<{ id: string; name: string; contactEmail: string | null; role: 'host' | 'member'; status: string }>; permissions: Array<{ memberId: string; groupId: string; limitCents: number; expiresAt: string | null; status: 'active' | 'revoked' }>; rules: { allowTemporaryFronting: boolean } | null; purchases: Array<{ id: string; title: string; merchant: string; totalCents: number; isDemoData: boolean }>; sessions: Array<{ id: string; status: string; merchant: string; totalCents: number; merchantPaymentStatus: string; paymentMode: string; paypalOrderId: string | null; paypalCaptureId: string | null }> }

export function isWhooshApiError(error: unknown): error is WhooshApiError {
  return error instanceof Error && 'status' in error && 'payload' in error
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  // Empty in the Vercel all-in-one deployment, so API calls stay same-origin.
  // Set VITE_API_URL only when deliberately deploying the API separately.
  const apiBaseUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '') ?? ''
  let response: Response
  try { response = await fetch(`${apiBaseUrl}${path}`, options) }
  catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('The split preview timed out. Please try again.', { cause: error })
    throw error
  }
  const text = await response.text()
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String(payload.error)
        : 'WHOOSH API request failed'

    const error = new Error(message) as WhooshApiError
    error.status = response.status
    error.payload = payload
    throw error
  }

  return payload as T
}

export function createSandboxSession(): Promise<SandboxSessionResponse> {
  return request<SandboxSessionResponse>('/api/sandbox/sessions', {
    method: 'POST',
  })
}

export function getGroup(groupId: string): Promise<GroupDetail> {
  return request<GroupDetail>(`/api/groups/${groupId}`)
}

export function listPersistentGroups(): Promise<PersistentGroupSummary[]> { return request('/api/persistent-groups') }
export function getPersistentGroup(groupId: string): Promise<PersistentGroupDetail> { return request(`/api/persistent-groups/${groupId}`) }
export function cancelUnpaidCheckoutDraft(groupId: string, sessionId: string): Promise<void> { return request(`/api/persistent-groups/${groupId}/sessions/${sessionId}/cancel-draft`, { method: 'POST' }) }
export function createPersistentCheckoutSession(groupId: string, cart: { merchant: string; reference: string; totalCents: number; currency: string; product: string }, idempotencyKey: string): Promise<{ id: string }> { return request(`/api/persistent-groups/${groupId}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ merchant: cart.merchant, reference: cart.reference, totalCents: cart.totalCents, currency: cart.currency, cart }) }) }
export interface AgentProposal {
  status: 'READY'
  id: string
  groupId: string
  checkoutSessionId: string | null
  request: string
  model: string
  merchant: string
  product: string
  totalCents: number
  currency: 'USD'
  simulatedMerchant: true
  items: Array<{ id: string; label: string; cents: number }>
  assignments: Array<{ itemId: string; memberIds: string[] }>
  directAmounts?: boolean
  allocations: Array<{ memberId: string; amountCents: number; itemIds: string[] }>
  participants: Array<{ id: string; name: string; amountCents: number }>
  permissions: Array<{ memberId: string; status: string; reason?: string; limitCents: number | null }>
  assumptions: string[]
  questions: string[]
  reconciliation: { receiptTotalCents: number; allocatedCents: number; differenceCents: number }
}
export type AgentProposalResult = AgentProposal | { status: 'NEEDS_CLARIFICATION'; questions: string[]; assumptions: string[] }
export function createAgentProposal(groupId: string, purchaseRequest: string): Promise<AgentProposalResult> { return request('/api/agent/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ groupId, request: purchaseRequest }) }) }
export function getAgentProposal(proposalId: string): Promise<AgentProposal> { return request(`/api/agent/proposals/${proposalId}`) }
export function editAgentAllocation(proposalId: string, assignments: AgentProposal['assignments']): Promise<AgentProposal> { return request(`/api/agent/proposals/${proposalId}/allocation`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignments }) }) }
export function confirmAgentProposal(proposalId: string): Promise<{ groupId: string; sessionId: string }> { return request(`/api/agent/proposals/${proposalId}/confirm`, { method: 'POST' }) }
export interface PersistentFunding { memberId: string; name: string; allocationCents: number; consentStatus: 'pending' | 'consented' | 'declined'; fundingStatus: 'not_requested' | 'simulated_pending' | 'verified' | 'failed' | 'cancelled' }
export interface PersistentCheckoutSession { id: string; groupId: string; cart: unknown; instruction?: string | null; allocation?: AllocationPreviewResponse | null; status: string; merchantPaymentStatus: string; paymentMode: string; bookingStatus: string; funding: PersistentFunding[] }
export interface ParticipantApproval { participantName: string; groupName: string; merchant: string; reference: string; currency: string; amountCents: number; purchaseTotalCents: number; items: Array<{ id: string; label: string; amountCents: number }>; consentStatus: 'pending' | 'consented' | 'declined'; purpose: 'decision' | 'withdrawal' | 'payment'; canDecide: boolean; canWithdraw: boolean; paymentStarted: boolean; paymentReady: boolean; paymentStatus: string | null; payerIdentityVerified: boolean }
export interface ParticipantApprovalLink { participantName: string; purpose: 'decision' | 'withdrawal' | 'payment'; token: string; expiresAt: string }
export function getPersistentCheckoutSession(sessionId: string): Promise<PersistentCheckoutSession> { return request(`/api/persistent-groups/sessions/${sessionId}`) }
export function createPersistentGroup(name: string, members: Array<string | { name: string; email?: string }>): Promise<PersistentGroupDetail> { return request('/api/persistent-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, members }) }) }
export function saveGroupContactEmail(groupId: string, memberId: string, email: string): Promise<{ id: string; contactEmail: string }> { return request(`/api/persistent-groups/${groupId}/members/${memberId}/contact`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }) }
export function savePersistentAllocation(sessionId: string, instruction: string, allocation: unknown, memberAmounts: Array<{ memberId: string; amountCents: number }>): Promise<unknown> { return request(`/api/persistent-groups/sessions/${sessionId}/allocation`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, allocation, memberAmounts }) }) }
export function createParticipantApprovalLinks(sessionId: string): Promise<{ localDemoOnly: true; links: ParticipantApprovalLink[] }> { return request(`/api/persistent-groups/sessions/${sessionId}/participant-approval-links`, { method: 'POST' }) }
export function inspectParticipantApproval(token: string): Promise<{ localDemoOnly: true; approval: ParticipantApproval }> { return request('/api/participant-approvals/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }) }
export function decideParticipantApproval(token: string, decision: 'approve' | 'decline' | 'withdraw'): Promise<{ localDemoOnly: true; consentStatus: ParticipantApproval['consentStatus']; withdrawalToken?: string }> { return request('/api/participant-approvals/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, decision }) }) }
export function openParticipantPayPalOrder(token: string): Promise<{ commitment: IndependentPaymentCommitment; mode: 'sandbox' | 'mock' }> { return request('/api/payments/paypal/participant/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }) }
export function captureParticipantPayPalOrder(token: string, orderId: string): Promise<IndependentPaymentCheckout> { return request('/api/payments/paypal/participant/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, orderId }) }) }
export function cancelParticipantPayPalOrder(token: string): Promise<IndependentPaymentCheckout> { return request('/api/payments/paypal/participant/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }) }
export function simulateParticipantFunding(sessionId: string, memberId: string, outcome: 'funded' | 'failed' | 'cancelled'): Promise<PersistentCheckoutSession> { return request(`/api/persistent-groups/sessions/${sessionId}/funding`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ memberId, outcome }) }) }

export function createSandboxTransaction(
  input: CreateSandboxTransactionRequest,
  idempotencyKey: string,
): Promise<SandboxTransactionResponse> {
  return request<SandboxTransactionResponse>('/api/sandbox/transactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(input),
  })
}

export function processSettlement(
  settlementId: string,
  simulation: SettlementSimulation,
  idempotencyKey: string,
): Promise<unknown> {
  return request<unknown>(`/api/settlements/${settlementId}/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ simulation }),
  })
}

export function previewAllocation(transcript: string, group: PersistentGroupDetail, cart: { items: Array<{ id: string; label: string; cents: number }> }): Promise<AllocationPreviewResponse> {
  return request<AllocationPreviewResponse>('/api/allocation/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      transcript, groupId: group.group.id,
      members: group.members.filter((member) => member.status === 'active').map(({ id, name }) => ({ id, name })),
      items: cart.items.map((item) => ({ id: item.id, label: item.label, unitCents: item.cents, quantity: 1 })),
      permissions: group.permissions,
    }),
  })
}

export function transcribeVoice(audio: Blob): Promise<VoiceTranscriptionResponse> {
  return request<VoiceTranscriptionResponse>('/api/voice/transcriptions', {
    method: 'POST',
    headers: { 'Content-Type': audio.type || 'audio/webm' },
    body: audio,
  })
}

export function createPayPalOrder(checkoutSessionId?: string): Promise<PayPalOrderResponse> {
  return request<PayPalOrderResponse>('/api/payments/paypal/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ totalCents: 128_400, currency: 'USD', reference: `WHOOSH-MONTREAL-${Date.now()}`, checkoutSessionId }),
  })
}

export function capturePayPalOrder(orderId: string, checkoutSessionId?: string): Promise<PayPalCaptureResponse> {
  return request<PayPalCaptureResponse>('/api/payments/paypal/orders/capture', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ orderId, reference: `WHOOSH-CAPTURE-${orderId}`, checkoutSessionId }),
  })
}

export type IndependentCommitmentStatus = 'ready_to_pay' | 'order_created' | 'approved' | 'capturing' | 'paid_verified' | 'failed' | 'cancelled' | 'refund_pending' | 'refunded' | 'superseded'
export interface IndependentPaymentCommitment {
  id: string; memberId: string; revision: number; name: string; amountCents: number; capturedCents: number | null; currency: string; status: IndependentCommitmentStatus
  expectedPayerEmail: string | null; payerEmail: string | null; providerOrderId: string | null; providerCaptureId: string | null; approvalUrl: string | null
  providerCustomId: string | null; providerPayeeMerchantId: string | null; allocationCents: number
  providerRefundId: string | null; refundedCents: number | null
  failureCode: string | null; failureMessage: string | null
}
export interface IndependentPaymentCheckout {
  session: { id: string; totalCents: number; currency: string; bookingStatus: string; status: string; merchant: string; cart: unknown; expiresAt: string | null }
  commitments: IndependentPaymentCommitment[]
  merchantBooking: { id: string; merchantOrderId: string; status: string; failureReason: string | null; confirmedAt: string | null; expiresAt: string | null } | null
  fundedCents: number
  remainingCents: number
  fundedParticipants: number
  participantCount: number
  unpaidParticipants: number
  fullyVerified: boolean
  fundingStatus: 'awaiting_payments' | 'partially_funded' | 'fully_funded' | 'needs_review'
}

export function startIndependentPaymentCheckout(sessionId: string): Promise<IndependentPaymentCheckout> {
  return request(`/api/payments/paypal/independent/sessions/${sessionId}/commitments`, { method: 'POST' })
}
export function getIndependentPaymentCheckout(sessionId: string): Promise<IndependentPaymentCheckout> {
  return request(`/api/payments/paypal/independent/sessions/${sessionId}`)
}
export function createIndependentPayPalOrder(sessionId: string, commitmentId: string, expectedPayerEmail: string): Promise<{ commitment: IndependentPaymentCommitment; mode: 'sandbox' | 'mock'; disclaimer: string }> {
  return request(`/api/payments/paypal/independent/sessions/${sessionId}/commitments/${commitmentId}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedPayerEmail }) })
}
export function captureIndependentPayPalOrder(sessionId: string, commitmentId: string, orderId: string): Promise<IndependentPaymentCheckout> {
  return request(`/api/payments/paypal/independent/sessions/${sessionId}/commitments/${commitmentId}/capture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId }) })
}
export function cancelIndependentPayment(sessionId: string, commitmentId: string): Promise<IndependentPaymentCheckout> {
  return request(`/api/payments/paypal/independent/sessions/${sessionId}/commitments/${commitmentId}/cancel`, { method: 'POST' })
}
export function cancelAndRefundIndependentCheckout(sessionId: string): Promise<IndependentPaymentCheckout> {
  return request(`/api/payments/paypal/independent/sessions/${sessionId}/cancel-and-refund`, { method: 'POST' })
}
export function confirmSimulatedNorthlineBooking(sessionId: string): Promise<IndependentPaymentCheckout> {
  return request(`/api/payments/paypal/independent/sessions/${sessionId}/confirm-demo-booking`, { method: 'POST' })
}
export function askCheckoutCoordinator(sessionId: string, message: string): Promise<{ response: string; toolsUsed: string[]; disclaimer: string }> {
  return request(`/api/agent/checkouts/${sessionId}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) })
}
