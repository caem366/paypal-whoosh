import { WhooshLogo } from '../components/WhooshLogo'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cancelIndependentPayment, cancelParticipantPayPalOrder, captureIndependentPayPalOrder, captureParticipantPayPalOrder, type IndependentPaymentCheckout } from '../api/whoosh'

export function IndependentPaymentReturn({ sessionId, commitmentId, orderId, cancelled, participantToken, participantFlow = false, onComplete, onBack }: { sessionId: string; commitmentId: string; orderId?: string; cancelled?: boolean; participantToken?: string; participantFlow?: boolean; onComplete: (checkout: IndependentPaymentCheckout) => void; onBack: () => void }) {
  const [error, setError] = useState<string>()
  const [working, setWorking] = useState(!cancelled)
  const started = useRef(false)
  const verify = useCallback(async () => {
    if (!orderId) { setError('The PayPal order reference is missing.'); return }
    if (participantFlow && !participantToken) { setError('This browser lost the participant link. Reopen your private invitation to check payment status.'); return }
    setWorking(true); setError(undefined)
    try { onComplete(participantFlow ? await captureParticipantPayPalOrder(participantToken!, orderId) : await captureIndependentPayPalOrder(sessionId, commitmentId, orderId)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'WHOOSH could not verify this payment.') }
    finally { setWorking(false) }
  }, [commitmentId, onComplete, orderId, participantFlow, participantToken, sessionId])
  useEffect(() => { if (started.current) return; started.current = true; if (!cancelled) void Promise.resolve().then(verify); else if (participantFlow && !participantToken) queueMicrotask(() => setError('Reopen your private invitation to check payment status.')); else { void (participantFlow ? cancelParticipantPayPalOrder(participantToken!) : cancelIndependentPayment(sessionId, commitmentId)).then(onComplete).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Cancellation could not be verified. Check the payment status before retrying.')) } }, [cancelled, commitmentId, onComplete, participantFlow, participantToken, sessionId, verify])
  return <main className="split-page"><header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onBack} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p></header><section className="sandbox-page paypal-return-page"><p className="trip-kicker">INDEPENDENT PAYPAL CHECKOUT</p><span className={`confirmation-check ${error || cancelled ? 'pending' : ''}`}>{cancelled ? '×' : error ? '!' : '…'}</span><h1>{cancelled ? 'PayPal checkout did not complete.' : error ? 'We need to confirm this share.' : 'Confirming payment.'}</h1><p className="trip-subtitle">{cancelled ? 'WHOOSH is checking the PayPal order. Review the saved status before retrying; a PayPal decline may require a different Sandbox buyer account.' : error ? 'No payment is counted until WHOOSH verifies the exact PayPal capture and recorded Sandbox payer.' : 'WHOOSH is verifying this participant’s PayPal payment with Northline.'}</p>{error && <><p className="sandbox-notice">{error}</p><button className="preview-button" type="button" onClick={() => void verify()} disabled={working}>{working ? 'Checking PayPal…' : 'Try confirmation again'}</button></>} {cancelled && <button className="preview-button" type="button" onClick={onBack}>Return to group payment</button>}</section></main>
}
