import { WhooshLogo } from '../components/WhooshLogo'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PayPalCaptureResponse } from '../api/whoosh'

export function PayPalReturn({ orderId, onCapture, onComplete, onBack }: { orderId: string; onCapture: (orderId: string) => Promise<PayPalCaptureResponse>; onComplete: (capture: PayPalCaptureResponse) => void; onBack: () => void }) {
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const started = useRef(false)

  const verify = useCallback(async () => {
    setRetrying(true); setError('')
    try { onComplete(await onCapture(orderId)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'We could not confirm the PayPal payment.') }
    finally { setRetrying(false) }
  }, [onCapture, onComplete, orderId])

  useEffect(() => { if (started.current) return; started.current = true; void Promise.resolve().then(verify) }, [verify])

  return <main className="split-page"><header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onBack} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p><div className="group-profile"><strong>Your groups</strong><span>YC</span></div></header><section className="sandbox-page paypal-return-page"><p className="trip-kicker">STEP 3 OF 3 · PAYPAL CONFIRMATION</p><span className="confirmation-check pending">…</span><h1>{error ? 'We need to confirm your payment.' : 'Confirming your payment.'}</h1><p className="trip-subtitle">{error ? 'PayPal has not confirmed a merchant payment yet. No completed purchase has been recorded.' : 'WHOOSH is verifying the approved PayPal order with Northline Travel.'}</p>{error ? <><p className="sandbox-notice">{error}</p><button className="preview-button" type="button" onClick={() => void verify()} disabled={retrying}>{retrying ? 'Checking PayPal…' : 'Try confirmation again'}</button><button className="manual-button" type="button" onClick={onBack}>Back to checkout</button></> : <p className="processing-next">Please keep this page open. This usually takes a moment.</p>}</section></main>
}

export function PayPalCancelled({ onRetry, onBack }: { onRetry: () => void; onBack: () => void }) {
  return <main className="split-page"><header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onBack} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p><div className="group-profile"><strong>Your groups</strong><span>YC</span></div></header><section className="sandbox-page paypal-return-page"><p className="trip-kicker">PAYPAL CHECKOUT CANCELLED</p><h1>Nothing was charged.</h1><p className="trip-subtitle">Your group’s approvals and saved split are still here. You can return to PayPal when Jamie is ready.</p><button className="preview-button" type="button" onClick={onRetry}>Try PayPal again →</button><button className="manual-button" type="button" onClick={onBack}>Back to review</button></section></main>
}
