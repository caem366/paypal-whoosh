import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentPurchase } from './AgentPurchase'
import { agentProgress } from './agent-progress'
import type { AgentProposal, PersistentCheckoutSession } from '../api/whoosh'
import { createAgentProposal } from '../api/whoosh'

afterEach(() => vi.unstubAllGlobals())

const proposal = { participants: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] } as AgentProposal
const session = { funding: [1, 2, 3, 4].map((id) => ({ memberId: String(id), fundingStatus: 'not_requested' })), bookingStatus: 'pending' } as PersistentCheckoutSession

describe('AI purchase workspace', () => {
  it('turns a timed-out proposal request into a retryable visible error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError')))
    await expect(createAgentProposal('group', 'Plan the Northline trip')).rejects.toThrow('split preview timed out. Please try again.')
  })
  it('renders the empty two-panel workspace with real approval boundaries', () => {
    const html = renderToStaticMarkup(<AgentPurchase onBack={() => {}} onProposal={() => {}} onRevise={() => {}} onContinue={() => {}} />)
    expect(html).toContain('WHOOSH Agent')
    expect(html).toContain('Purchase workspace')
    expect(html).toContain('Create proposal')
    expect(html).toContain('Each payer approves in PayPal')
  })

  it('keeps payment and booking pending until persisted evidence exists', () => {
    expect(agentProgress(proposal, null)[3]?.state).toBe('pending')
    expect(agentProgress(proposal, session)[3]?.state).toBe('current')
    expect(agentProgress(proposal, session)[4]?.state).toBe('pending')
    const funded = { ...session, funding: session.funding.map((row) => ({ ...row, fundingStatus: 'verified' as const })) }
    expect(agentProgress(proposal, funded)[3]?.state).toBe('complete')
    expect(agentProgress(proposal, funded)[4]?.state).toBe('pending')
    expect(agentProgress(proposal, { ...funded, bookingStatus: 'confirmed_simulated' })[4]?.state).toBe('complete')
  })
})
