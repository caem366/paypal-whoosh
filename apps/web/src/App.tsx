import { useEffect, useRef, useState } from 'react'
import { capturePayPalOrder, createParticipantApprovalLinks, createPayPalOrder, getPersistentCheckoutSession, getPersistentGroup, type AllocationPreviewResponse, type PayPalCaptureResponse, type PayPalOrderResponse, type PersistentCheckoutSession, type PersistentGroupDetail as PersistentGroupData } from './api/whoosh'
import { previewCheckoutAllocation, previewManualCheckoutAllocation } from './allocation-flow'
import type { ItemAssignment } from '@whoosh/shared'
import { CreateGroupSplit } from './pages/CreateGroupSplit'
import { AllocationPreview } from './pages/AllocationPreview'
import { AwaitingApproval } from './pages/AwaitingApproval'
import { ParticipantApproval } from './pages/ParticipantApproval'
import { FinalReview } from './pages/FinalReview'
import { PaymentProcessing } from './pages/PaymentProcessing'
import { GroupFunding } from './pages/GroupFunding'
import { IndependentPayerCheckout } from './pages/IndependentPayerCheckout'
import { IndependentPaymentReturn } from './pages/IndependentPaymentReturn'
import { PaymentMode } from './pages/PaymentMode'
import { PayPalCancelled, PayPalReturn } from './pages/PayPalReturn'
import { PaymentSuccess } from './pages/PaymentSuccess'
import { MobilePaymentSuccess } from './pages/MobilePaymentSuccess'
import { Clarification } from './pages/Clarification'
import { ReceiptAllocation } from './pages/ReceiptAllocation'
import { FailedContribution } from './pages/FailedContribution'
import { TemporaryCoverConfirmed } from './pages/TemporaryCoverConfirmed'
import { AutoSettleStatus } from './pages/AutoSettleStatus'
import { AutoSettleConfirmed } from './pages/AutoSettleConfirmed'
import { MerchantCheckout } from './pages/MerchantCheckout'
import { MontrealGroupDetail } from './pages/MontrealGroupDetail'
import { PaymentPermissions } from './pages/PaymentPermissions'
import { NorthlineEscape } from './pages/NorthlineEscape'
import { NorthlineConfigure } from './pages/NorthlineConfigure'
import { NorthlineResults } from './pages/NorthlineResults'
import { NorthlineTravelers } from './pages/NorthlineTravelers'
import { MockBookingConfirmation } from './pages/MockBookingConfirmation'
import { findPackage, type SearchTab, type TravelPackage } from './demo/northline-marketplace'
import { GroupsDashboard } from './pages/GroupsDashboard'
import { GroupsHome } from './pages/GroupsHome'
import { PersistentGroupDetail } from './pages/PersistentGroupDetail'
import { GroupPicker } from './pages/GroupPicker'
import { CreatePersistentGroup } from './pages/CreatePersistentGroup'
import { CreateGroupSuccess } from './pages/CreateGroupSuccess'
import { AgentPurchase } from './pages/AgentPurchase'
import type { CreatedInvitee } from './pages/CreatePersistentGroup'
import { northlineCart as defaultNorthlineCart, type NorthlineCart } from './demo/northline'

type Screen = 'groups-home' | 'whoosh-checkout' | 'group-detail' | 'northline-escape' | 'northline-results' | 'northline-configure' | 'travelers' | 'mock-confirmation' | 'checkout' | 'group-picker' | 'create-group' | 'create-group-success' | 'agent' | 'instructions' | 'clarification' | 'receipt' | 'allocation' | 'approval' | 'participant-approval' | 'review' | 'payment-mode' | 'funding' | 'independent-payment' | 'independent-return' | 'independent-cancelled' | 'processing' | 'paypal-return' | 'paypal-cancelled' | 'failure' | 'cover-confirmed' | 'auto-settle' | 'repayment-confirmed' | 'success' | 'mobile-success' | 'whoosh' | 'montreal-group' | 'permissions' | 'groups-dashboard'

export default function App() {
  // Deep links distinguish normal WHOOSH home from an incoming merchant cart.
  const [screen, setScreen] = useState<Screen>(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('whoosh') === 'participant') return 'participant-approval'
    if (['member-return', 'participant-return'].includes(params.get('paypal') ?? '') && params.get('session') && params.get('commitment') && (params.get('token') || params.get('order'))) return 'independent-return'
    if (['member-cancel', 'participant-cancel'].includes(params.get('paypal') ?? '') && params.get('session') && params.get('commitment')) return 'independent-cancelled'
    if (params.get('paypal') === 'return' && params.get('session') && (params.get('token') || params.get('order'))) return 'paypal-return'
    if (params.get('paypal') === 'cancel' && params.get('session')) return 'paypal-cancelled'
    if (params.get('northline') === 'checkout') return 'checkout'
    if (params.get('whoosh') === 'agent') return 'agent'
    if (params.get('whoosh') === 'checkout' && params.get('step') === 'group' && !params.get('session')) return 'group-picker'
    return params.get('session') ? 'instructions' : params.get('whoosh') === 'checkout' ? 'whoosh-checkout' : 'groups-home'
  })
  const [routeRevision, setRouteRevision] = useState(0)
  const [allocation, setAllocation] = useState<AllocationPreviewResponse | undefined>()
  const [apiError, setApiError] = useState<string | undefined>()
  const [previewBusy, setPreviewBusy] = useState(false)
  const previewInFlight = useRef(false)
  const [paypalOrder, setPayPalOrder] = useState<PayPalOrderResponse | undefined>()
  const [capture, setCapture] = useState<PayPalCaptureResponse | undefined>()
  const [independentBookingConfirmed, setIndependentBookingConfirmed] = useState(false)
  const [failureBack, setFailureBack] = useState<Screen>('processing')
  const [paymentBusy, setPaymentBusy] = useState(false)
  const [merchantCart, setMerchantCart] = useState<NorthlineCart>(defaultNorthlineCart)
  const [selectedTrip, setSelectedTrip] = useState<TravelPackage>(() => findPackage('montreal-weekend'))
  const [search, setSearch] = useState<{ query: string; tab: SearchTab }>({ query: '', tab: 'Flight + Hotel' })
  const [northlineCart, setNorthlineCart] = useState<NorthlineCart | null>(defaultNorthlineCart)
  // The durable source of this context is the persisted session ID in the URL.
  const [checkoutContext, setCheckoutContext] = useState<{ groupId: string; sessionId: string } | undefined>()
  const [checkoutGroup, setCheckoutGroup] = useState<PersistentGroupData | undefined>()
  const [checkoutSession, setCheckoutSession] = useState<PersistentCheckoutSession | undefined>()
  const [checkoutInstruction, setCheckoutInstruction] = useState<string | undefined>()
  const [createdGroup, setCreatedGroup] = useState<{ id: string; name: string; invitees: CreatedInvitee[] } | undefined>()
  const [dashboardGroupId] = useState<string | undefined>()
  const [selectedPersistentGroupId, setSelectedPersistentGroupId] = useState<string | undefined>()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const sessionId = params.get('session')
    if (!sessionId) return
    getPersistentCheckoutSession(sessionId).then(async (session) => {
      const group = await getPersistentGroup(session.groupId)
      setCheckoutContext({ groupId: session.groupId, sessionId: session.id })
      setCheckoutSession(session)
      setCheckoutGroup(group)
      setCheckoutInstruction(session.instruction ?? undefined)
      setAllocation(session.allocation ?? undefined)
      setMerchantCart(session.cart as NorthlineCart)
      setNorthlineCart(session.cart as NorthlineCart)
      if (!params.has('paypal') && session.paymentMode === 'independent_paypal') setScreen('independent-payment')
      else if (params.get('step') === 'allocation' && session.allocation) {
        setAllocation(session.allocation)
        setScreen('instructions')
      } else if (params.get('step') === 'approval') {
        setScreen('approval')
      } else if (params.get('step') === 'pay') {
        setScreen(session.funding.length > 0 && session.funding.every((row) => row.consentStatus === 'consented') ? 'independent-payment' : 'approval')
      } else if (params.get('step') === 'review') {
        const allApproved = session.funding.length > 0 && session.funding.every((row) => row.consentStatus === 'consented')
        setScreen(allApproved ? 'review' : 'approval')
      } else if (params.get('step') === 'allocation') {
        setApiError('The saved allocation preview is unavailable. Review the instructions and preview the split again.')
        setScreen('instructions')
      }
    }).catch((error) => setApiError(error instanceof Error ? error.message : 'This saved WHOOSH checkout could not be restored. Return to Northline to start again.'))
  }, [])

  useEffect(() => {
    const restoreCheckoutRoute = () => {
      setRouteRevision((revision) => revision + 1)
      const params = new URLSearchParams(window.location.search)
      if (params.get('session')) {
        const step = params.get('step')
        setScreen(step === 'approval' ? 'approval' : step === 'pay' ? 'independent-payment' : step === 'review' ? 'review' : 'instructions')
      }
      else if (params.get('northline') === 'checkout') setScreen('checkout')
      else if (params.get('whoosh') === 'participant') setScreen('participant-approval')
      else if (params.get('whoosh') === 'agent') setScreen('agent')
      else if (params.get('whoosh') === 'checkout' && params.get('step') === 'group') setScreen('group-picker')
      else setScreen('groups-home')
    }
    window.addEventListener('popstate', restoreCheckoutRoute)
    return () => window.removeEventListener('popstate', restoreCheckoutRoute)
  }, [])

  const approvalSessionId = checkoutContext?.sessionId
  useEffect(() => {
    if ((screen !== 'approval' && screen !== 'review') || !approvalSessionId) return
    let active = true
    const refresh = () => {
      void getPersistentCheckoutSession(approvalSessionId).then((session) => {
        if (active) {
          setCheckoutSession(session)
          setApiError(undefined)
          if (screen === 'review' && !(session.funding.length > 0 && session.funding.every((row) => row.consentStatus === 'consented'))) setScreen('approval')
        }
      }).catch((error: unknown) => {
        if (active) setApiError(error instanceof Error ? error.message : 'Participant consent status could not be refreshed.')
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [screen, approvalSessionId])

  const setRoute = (query: string) => window.history.replaceState(null, '', `${window.location.pathname}${query}`)
  const pushRoute = (query: string) => window.history.pushState(null, '', `${window.location.pathname}${query}`)
  const backToNorthline = () => {
    const sessionId = checkoutContext?.sessionId ?? new URLSearchParams(window.location.search).get('session')
    setRoute(sessionId ? `?northline=checkout&session=${encodeURIComponent(sessionId)}` : '?northline=checkout')
    setScreen('checkout')
  }
  const returnToGroups = () => {
    const groupId = checkoutContext?.groupId ?? new URLSearchParams(window.location.search).get('group')
    pushRoute(groupId ? `?whoosh=home&group=${encodeURIComponent(groupId)}` : '?whoosh=home')
    setScreen('groups-home')
  }
  const beginWhooshHandoff = () => { pushRoute('?whoosh=checkout&merchant=NLT-M1023&step=group'); setScreen('group-picker') }
  const continueWithGroup = (groupId: string, sessionId?: string) => {
    if (!sessionId) { setSelectedPersistentGroupId(groupId); setScreen('group-detail'); return }
    setApiError(undefined)
    setCheckoutContext({ groupId, sessionId })
    setCheckoutSession(undefined)
    setCheckoutGroup(undefined)
    setCheckoutInstruction(undefined)
    setAllocation(undefined)
    void Promise.all([getPersistentGroup(groupId), getPersistentCheckoutSession(sessionId)]).then(([group, session]) => {
      if (session.groupId !== groupId) throw new Error('This checkout belongs to a different group.')
      setCheckoutGroup(group)
      setCheckoutSession(session)
      setCheckoutInstruction(session.instruction ?? undefined)
      setAllocation(session.allocation ?? undefined)
      setMerchantCart(session.cart as NorthlineCart)
      const phase = session.paymentMode === 'independent_paypal' ? 'pay' : session.allocation ? 'approval' : 'split'
      setRoute(`?whoosh=checkout&session=${encodeURIComponent(sessionId)}&group=${encodeURIComponent(groupId)}&step=${phase}`)
      setScreen(phase === 'pay' ? 'independent-payment' : phase === 'approval' ? 'approval' : 'instructions')
    }).catch((reason) => setApiError(reason instanceof Error ? reason.message : 'The selected checkout could not be restored.'))
    pushRoute(`?whoosh=checkout&session=${encodeURIComponent(sessionId)}&group=${encodeURIComponent(groupId)}&step=split`)
    setScreen('instructions')
  }

  const runAllocation = async (transcript: string) => {
    if (previewInFlight.current) return
    previewInFlight.current = true
    setCheckoutInstruction(transcript)
    setApiError(undefined)
    setPreviewBusy(true)
    try {
      await previewCheckoutAllocation(transcript, checkoutContext, merchantCart, (result, group, session) => {
        setCheckoutGroup(group)
        setCheckoutSession(session)
        setAllocation(result)
        const url = new URL(window.location.href)
        url.searchParams.set('whoosh', 'checkout')
        url.searchParams.set('session', session.id)
        url.searchParams.set('group', group.group.id)
        url.searchParams.set('step', 'allocation')
        window.history.pushState(null, '', `${url.pathname}${url.search}`)
        setScreen('instructions')
      })
    } catch (error) { setApiError(error instanceof Error ? error.message : 'WHOOSH could not interpret that instruction.') }
    finally { previewInFlight.current = false; setPreviewBusy(false) }
  }

  const runManualAllocation = async (assignments: ItemAssignment[]) => {
    if (previewInFlight.current) return
    previewInFlight.current = true
    setApiError(undefined)
    setPreviewBusy(true)
    try {
      await previewManualCheckoutAllocation(assignments, checkoutContext, merchantCart, (result, group, session) => {
        setCheckoutGroup(group)
        setCheckoutSession(session)
        setCheckoutInstruction(session.instruction ?? undefined)
        setAllocation(result)
        setRoute(`?whoosh=checkout&session=${encodeURIComponent(session.id)}&group=${encodeURIComponent(group.group.id)}&step=allocation`)
        setScreen('instructions')
      })
    } catch (error) { setApiError(error instanceof Error ? error.message : 'WHOOSH could not calculate that manual split.') }
    finally { previewInFlight.current = false; setPreviewBusy(false) }
  }

  const beginPayPalCheckout = async () => {
    setPaymentBusy(true); setApiError(undefined)
    try {
      const order = await createPayPalOrder(checkoutContext?.sessionId)
      setPayPalOrder(order)
      if (order.mode === 'sandbox' && order.approvalUrl) { window.location.assign(order.approvalUrl); return }
      if (order.mode === 'mock') setApiError('PayPal Sandbox is not configured. No PayPal order was created or captured.')
      if (order.mode === 'sandbox' && !order.approvalUrl) setApiError('PayPal did not return an approval link. Please try again.')
    } catch (error) { setApiError(error instanceof Error ? error.message : 'Could not create the PayPal order.') } finally { setPaymentBusy(false) }
  }

  const captureCheckout = async (returnedOrderId?: string) => {
    const orderId = returnedOrderId ?? paypalOrder?.orderId
    if (!orderId) throw new Error('The PayPal order reference is missing.')
    const sessionId = checkoutContext?.sessionId ?? new URLSearchParams(window.location.search).get('session') ?? undefined
    setPaymentBusy(true); setApiError(undefined)
    try { const result = await capturePayPalOrder(orderId, sessionId); setCapture(result); return result }
    catch (error) { const message = error instanceof Error ? error.message : 'PayPal capture was not completed.'; setApiError(message); throw new Error(message, { cause: error }) }
    finally { setPaymentBusy(false) }
  }

  const openTrip = (id: string) => { setSelectedTrip(findPackage(id)); setNorthlineCart(id === 'montreal-weekend' ? merchantCart : null); setScreen('northline-configure') }
  if (screen === 'northline-escape') return <NorthlineEscape onSearch={(query, tab) => { setSearch({ query, tab }); setScreen('northline-results') }} onPackage={openTrip} />
  if (screen === 'northline-results') return <NorthlineResults query={search.query} tab={search.tab} onBack={() => setScreen('northline-escape')} onPackage={openTrip} />
  if (screen === 'northline-configure') return <NorthlineConfigure trip={selectedTrip} onBack={() => setScreen('northline-results')} onCheckout={(cart) => { setNorthlineCart(cart); if (cart) setMerchantCart(cart); setScreen('travelers') }} />
  if (screen === 'travelers') return <NorthlineTravelers trip={selectedTrip} cart={northlineCart} onBack={() => setScreen('northline-configure')} onCheckout={() => setScreen('checkout')} />
  if (screen === 'mock-confirmation') return <MockBookingConfirmation trip={selectedTrip} funded={independentBookingConfirmed} onHome={() => setScreen('northline-escape')} />
  if (screen === 'group-picker') return <GroupPicker cart={merchantCart} onBack={backToNorthline} onContinue={continueWithGroup} />
  const openPersistentGroup = (groupId: string) => { setSelectedPersistentGroupId(groupId); setScreen('group-detail') }
  const openAgent = (groupId: string) => { pushRoute(`?whoosh=agent&group=${encodeURIComponent(groupId)}`); setScreen('agent') }
  if (screen === 'agent') { const params = new URLSearchParams(window.location.search); return <AgentPurchase key={`${params.get('proposal') ?? params.get('group') ?? 'new'}:${routeRevision}`} initialGroupId={params.get('group') ?? dashboardGroupId} proposalId={params.get('proposal') ?? undefined} onBack={() => { setRoute('?whoosh=home'); setScreen('groups-home') }} onProposal={(id) => pushRoute(`?whoosh=agent&proposal=${encodeURIComponent(id)}`)} onRevise={(groupId) => setRoute(`?whoosh=agent&group=${encodeURIComponent(groupId)}`)} onContinue={continueWithGroup} /> }
  if (screen === 'whoosh-checkout') return <GroupsDashboard initialGroupId={dashboardGroupId} incomingCheckout={{ title: merchantCart.product, total: '$1,284.00', reference: merchantCart.reference }} onClose={backToNorthline} onCreate={() => setScreen('create-group')} onContinueWithGroup={() => setScreen('group-picker')} onOpenGroup={openPersistentGroup} onResume={continueWithGroup} onPlanPurchase={openAgent} />
  if (screen === 'groups-home') return <GroupsHome initialGroupId={new URLSearchParams(window.location.search).get('group') ?? dashboardGroupId} onClose={() => setScreen('northline-escape')} onCreate={() => setScreen('create-group')} onOpenGroup={openPersistentGroup} onResume={continueWithGroup} onPlanPurchase={openAgent} />
  if (screen === 'whoosh') return <GroupsHome initialGroupId={dashboardGroupId} onClose={() => setScreen('northline-escape')} onCreate={() => setScreen('create-group')} onOpenGroup={openPersistentGroup} onResume={continueWithGroup} onPlanPurchase={openAgent} />
  if (screen === 'groups-dashboard') return <GroupsDashboard initialGroupId={dashboardGroupId} onClose={() => setScreen('northline-escape')} onCreate={() => setScreen('create-group')} onOpenGroup={openPersistentGroup} onResume={continueWithGroup} onPlanPurchase={openAgent} />
  if (screen === 'group-detail' && selectedPersistentGroupId) return <PersistentGroupDetail groupId={selectedPersistentGroupId} onBack={() => setScreen('groups-dashboard')} onResume={continueWithGroup} />
  if (screen === 'create-group') return <CreatePersistentGroup onBack={() => setScreen('groups-dashboard')} onCreated={(group, invitees) => { setCreatedGroup({ ...group, invitees }); setScreen('create-group-success') }} />
  if (screen === 'create-group-success' && createdGroup) return <CreateGroupSuccess group={createdGroup} invitees={createdGroup.invitees} onBack={() => setScreen('groups-dashboard')} onView={() => { setSelectedPersistentGroupId(createdGroup.id); setScreen('group-detail') }} />
  if (screen === 'montreal-group') return <MontrealGroupDetail onBack={() => setScreen('whoosh')} onStartSplit={() => setScreen('instructions')} onPermissions={() => setScreen('permissions')} />
  if (screen === 'permissions') return <PaymentPermissions onBack={() => setScreen('montreal-group')} />
  if (screen === 'instructions') return <CreateGroupSplit key={checkoutGroup?.group.id ?? 'loading'} cart={merchantCart} group={checkoutGroup} allocation={allocation} initialTranscript={checkoutInstruction} onTranscriptChange={(value) => { setCheckoutInstruction(value); setAllocation(undefined) }} onConfirmSplit={() => { pushRoute(`?whoosh=checkout&session=${encodeURIComponent(checkoutContext?.sessionId ?? '')}&group=${encodeURIComponent(checkoutContext?.groupId ?? '')}&step=approval`); setScreen('approval') }} error={apiError} busy={previewBusy} onBack={backToNorthline} onChangeGroup={() => { pushRoute('?whoosh=checkout&merchant=NLT-M1023&step=group'); setScreen('group-picker') }} onPreview={runAllocation} onReceipt={() => setScreen('receipt')} />
  if (screen === 'clarification') return <Clarification onBack={() => setScreen('instructions')} onContinue={() => setScreen('instructions')} />
  if (screen === 'receipt') return <ReceiptAllocation onBack={() => setScreen('instructions')} group={checkoutGroup} cart={merchantCart} error={apiError} busy={previewBusy} onReview={runManualAllocation} />
  if (screen === 'allocation') return <AllocationPreview onBack={() => { setRoute(`?whoosh=checkout&session=${encodeURIComponent(checkoutContext?.sessionId ?? '')}&group=${encodeURIComponent(checkoutContext?.groupId ?? '')}`); setScreen('instructions') }} onContinue={() => { setRoute(`?whoosh=checkout&session=${encodeURIComponent(checkoutContext?.sessionId ?? '')}&group=${encodeURIComponent(checkoutContext?.groupId ?? '')}&step=approval`); setScreen('approval') }} allocation={allocation} group={checkoutGroup} cart={merchantCart} />
  if (screen === 'approval' && checkoutSession && checkoutGroup) return <AwaitingApproval
    onBack={() => { setRoute(`?whoosh=checkout&session=${encodeURIComponent(checkoutContext?.sessionId ?? '')}&group=${encodeURIComponent(checkoutContext?.groupId ?? '')}`); setScreen('instructions') }}
    onLeave={returnToGroups}
    onContinue={() => { pushRoute(`?whoosh=checkout&session=${encodeURIComponent(checkoutContext?.sessionId ?? '')}&group=${encodeURIComponent(checkoutContext?.groupId ?? '')}&step=pay`); setScreen('independent-payment') }}
    onIssueLinks={async () => {
      if (!checkoutContext) throw new Error('Restore a saved checkout before generating participant links.')
      return (await createParticipantApprovalLinks(checkoutContext.sessionId)).links
    }}
    groupName={checkoutGroup.group.name}
    group={checkoutGroup}
    onContactSaved={(memberId, email) => setCheckoutGroup((current) => current ? { ...current, members: current.members.map((member) => member.id === memberId ? { ...member, contactEmail: email } : member) } : current)}
    session={checkoutSession}
    cart={merchantCart}
    error={apiError}
  />
  if (screen === 'approval') return <main className="split-page"><p className="sandbox-notice" role="status">Loading saved participant approvals…</p></main>
  if (screen === 'participant-approval') return <ParticipantApproval key={routeRevision} />
  if (screen === 'review' && checkoutSession && checkoutGroup) return <FinalReview
    onBack={() => { setRoute(`?whoosh=checkout&session=${encodeURIComponent(checkoutContext?.sessionId ?? '')}&group=${encodeURIComponent(checkoutContext?.groupId ?? '')}&step=approval`); setScreen('approval') }}
    onConfirm={() => setScreen('payment-mode')}
    groupName={checkoutGroup.group.name}
    session={checkoutSession}
    cart={merchantCart}
  />
  if (screen === 'review') return <main className="split-page"><p className="sandbox-notice" role="alert">{apiError ?? 'Restore the saved checkout before reviewing shares.'}</p><button className="preview-button" onClick={() => setScreen('approval')} type="button">Return to approvals</button></main>
  if (screen === 'payment-mode') return <PaymentMode onBack={() => setScreen('approval')} onIndependent={() => setScreen('independent-payment')} onSimulated={() => setScreen('funding')} onSinglePayer={() => setScreen('processing')} />
  if (screen === 'funding') return checkoutContext ? <GroupFunding sessionId={checkoutContext.sessionId} onBack={() => setScreen('approval')} onReady={() => setScreen('processing')} /> : <main className="split-page"><p className="sandbox-notice">Restore a saved WHOOSH checkout before simulating group funding.</p><button className="preview-button" onClick={() => setScreen('groups-home')} type="button">Back to groups</button></main>
  if (screen === 'independent-payment') return checkoutContext ? <IndependentPayerCheckout sessionId={checkoutContext.sessionId} onBack={() => { setRoute(`?whoosh=checkout&session=${encodeURIComponent(checkoutContext.sessionId)}&group=${encodeURIComponent(checkoutContext.groupId)}&step=approval`); setScreen('approval') }} onLeave={returnToGroups} onFailure={() => { setFailureBack('independent-payment'); setScreen('failure') }} onReturnToMerchant={() => { setIndependentBookingConfirmed(true); setScreen('mock-confirmation') }} onDemoModes={() => setScreen('payment-mode')} /> : <main className="split-page"><p className="sandbox-notice">Restore a saved WHOOSH checkout before opening independent payments.</p><button className="preview-button" onClick={returnToGroups} type="button">Back to groups</button></main>
  if (screen === 'independent-return' || screen === 'independent-cancelled') {
    const params = new URLSearchParams(window.location.search)
    const sessionId = params.get('session') ?? checkoutContext?.sessionId ?? ''
    const commitmentId = params.get('commitment') ?? ''
    const orderId = params.get('token') ?? params.get('order') ?? undefined
    const participantFlow = params.get('paypal')?.startsWith('participant-') ?? false
    const participantToken = participantFlow ? window.sessionStorage.getItem(`whoosh-participant-${commitmentId}`) ?? undefined : undefined
    const returnFromPayment = () => { if (participantFlow && participantToken) { setRoute(`?whoosh=participant#${participantToken}`); setScreen('participant-approval') } else { setRoute(`?whoosh=checkout&session=${encodeURIComponent(sessionId)}`); setScreen('independent-payment') } }
    return <IndependentPaymentReturn sessionId={sessionId} commitmentId={commitmentId} orderId={orderId} cancelled={screen === 'independent-cancelled'} participantFlow={participantFlow} participantToken={participantToken} onBack={returnFromPayment} onComplete={returnFromPayment} />
  }
  if (screen === 'processing') return <PaymentProcessing onBack={() => setScreen('review')} onSimulateFailure={() => { setFailureBack('processing'); setScreen('failure') }} onCreateOrder={beginPayPalCheckout} busy={paymentBusy} error={apiError} />
  if (screen === 'paypal-return') {
    const params = new URLSearchParams(window.location.search)
    const orderId = params.get('token') ?? params.get('order') ?? ''
    return <PayPalReturn orderId={orderId} onCapture={captureCheckout} onComplete={(result) => { setCapture(result); setScreen('success') }} onBack={() => setScreen('processing')} />
  }
  if (screen === 'paypal-cancelled') return <PayPalCancelled onRetry={() => { setRoute(`?whoosh=checkout&session=${encodeURIComponent(checkoutContext?.sessionId ?? new URLSearchParams(window.location.search).get('session') ?? '')}`); setScreen('processing') }} onBack={() => setScreen('review')} />
  if (screen === 'failure') return <FailedContribution onBack={() => setScreen(failureBack)} onCovered={() => setScreen('cover-confirmed')} />
  if (screen === 'cover-confirmed') return <TemporaryCoverConfirmed onBack={() => setScreen('failure')} onViewRepayment={() => setScreen('auto-settle')} />
  if (screen === 'auto-settle') return <AutoSettleStatus onBack={() => setScreen('cover-confirmed')} onConfirmDemo={() => setScreen('repayment-confirmed')} />
  if (screen === 'repayment-confirmed') return <AutoSettleConfirmed onBack={() => setScreen('whoosh')} />
  if (screen === 'success') return <PaymentSuccess onBack={backToNorthline} returnLabel="Return to Northline" onViewMobileReceipt={() => setScreen('mobile-success')} capture={capture} />
  if (screen === 'mobile-success') return <MobilePaymentSuccess onBack={() => setScreen('success')} />
  return <MerchantCheckout cart={northlineCart} trip={selectedTrip} onBack={() => setScreen('travelers')} onSplitWithWhoosh={beginWhooshHandoff} onMockConfirm={() => setScreen('mock-confirmation')} />
}
