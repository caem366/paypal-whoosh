import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { environment } from '../../config.js'
import { createPayPalOrdersGateway, PayPalOrdersError } from './paypal-orders.service.js'
import { assertCheckoutReady, getCheckoutSession, recordPayPalOrder, recordVerifiedCapture } from '../groups/persistent-groups.service.js'
import { resolveParticipantPaymentToken } from '../groups/persistent-groups.service.js'
import { cancelAndRefundIndependentCheckout, cancelIndependentPaymentCommitment, captureIndependentPayPalOrder, confirmSimulatedNorthlineBooking, createIndependentPayPalOrder, ensureIndependentPaymentCommitments, getIndependentPaymentCheckout } from './independent-payments.service.js'

const createOrderSchema = z.object({ totalCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: z.literal('USD'), reference: z.string().trim().min(1).max(128), checkoutSessionId: z.string().uuid().optional() })
const captureOrderSchema = z.object({ orderId: z.string().trim().min(1).max(128), reference: z.string().trim().min(1).max(128), checkoutSessionId: z.string().uuid().optional() })
const memberPaymentSchema = z.object({ expectedPayerEmail: z.string().trim().email().max(320) })
const participantTokenSchema = z.string().regex(/^[\w-]{43}$/)
export const paymentsRouter = Router()
const ensureDemoParticipantCheckout: RequestHandler = (_request, response, next) => {
  if (environment.DEMO_PARTICIPANT_APPROVAL_LINKS !== 'enabled') return response.status(404).json({ error: 'Participant checkout links are available only in the local Sandbox demo.' })
  next()
}

const safeWebOrigin = () => (process.env.PAYPAL_RETURN_ORIGIN?.replace(/\/$/, '') || 'http://localhost:5173')
const paypalFailure = (error: unknown, response: import('express').Response) => {
  if (error instanceof PayPalOrdersError) return response.status(502).json({ error: 'PayPal Sandbox could not complete the request', code: error.code })
  throw error
}
paymentsRouter.post('/paypal/orders', async (request, response, next) => {
  try {
    const input = createOrderSchema.parse(request.body)
    const returnQuery = input.checkoutSessionId ? `?paypal=return&session=${encodeURIComponent(input.checkoutSessionId)}` : undefined
    const cancelQuery = input.checkoutSessionId ? `?paypal=cancel&session=${encodeURIComponent(input.checkoutSessionId)}` : undefined
    const session = input.checkoutSessionId ? await getCheckoutSession(input.checkoutSessionId) : undefined
    if (session && session.currency !== 'USD') throw new TypeError('PayPal Sandbox checkout requires USD')
    if (session?.paymentMode === 'independent_paypal') throw new TypeError('Independent participant checkout cannot be charged again as one full-total order')
    if (session) assertCheckoutReady(session)
    const order = await createPayPalOrdersGateway().createOrder({
      ...input,
      totalCents: session?.totalCents ?? input.totalCents,
      currency: session ? 'USD' : input.currency,
      reference: session ? `whoosh-checkout-${session.id}` : input.reference,
      returnUrl: returnQuery ? `${safeWebOrigin()}/${returnQuery}` : undefined,
      cancelUrl: cancelQuery ? `${safeWebOrigin()}/${cancelQuery}` : undefined,
    })
    // Mock mode represents no real order and deliberately cannot advance state.
    if (input.checkoutSessionId && order.mode === 'sandbox') await recordPayPalOrder({ sessionId: input.checkoutSessionId, orderId: order.orderId })
    response.status(201).json({ ...order, disclaimer: 'Standard PayPal Orders represents one buyer-to-merchant checkout. Group contributions are WHOOSH workflow state, not native PayPal multi-payer settlement.' })
  } catch (error) { try { paypalFailure(error, response) } catch (unknown) { next(unknown) } }
})

paymentsRouter.post('/paypal/orders/capture', async (request, response, next) => {
  try {
    const input = captureOrderSchema.parse(request.body)
    const gateway = createPayPalOrdersGateway()
    const verified = await gateway.getOrder(input.orderId)
    const session = input.checkoutSessionId ? await getCheckoutSession(input.checkoutSessionId) : undefined
    const assertCaptureMatches = (capture: typeof verified) => {
      if (session && (capture.captureCents !== session.totalCents || capture.captureCurrency !== session.currency || capture.captureStatus !== 'COMPLETED')) throw new TypeError('PayPal capture does not match the checkout amount or currency')
    }
    if (verified.status === 'UNAVAILABLE') {
      return response.status(409).json({ error: 'PayPal Sandbox is not configured. No order was captured.', mode: 'mock' })
    }
    if (session && (verified.orderCents !== session.totalCents || verified.currency !== session.currency)) throw new TypeError('PayPal order does not match the checkout amount or currency')
    if (verified.status === 'COMPLETED' && verified.captureId) {
      assertCaptureMatches(verified)
      const purchase = input.checkoutSessionId ? await recordVerifiedCapture({ sessionId: input.checkoutSessionId, orderId: verified.orderId, captureId: verified.captureId }) : undefined
      return response.status(200).json({ orderId: verified.orderId, captureId: verified.captureId, status: 'COMPLETED', mode: 'sandbox', purchase, disclaimer: 'This is a single buyer-to-merchant PayPal capture. WHOOSH participant consent and allocation remain off-rail workflow records.' })
    }
    if (verified.status !== 'APPROVED') return response.status(409).json({ error: 'PayPal approval is still required. Return to PayPal and approve this checkout before WHOOSH can verify payment.', code: 'ORDER_NOT_APPROVED' })
    const result = await gateway.captureOrder(input.orderId, input.reference)
    if (result.status === 'UNAVAILABLE') {
      return response.status(409).json({ error: 'PayPal Sandbox is not configured. No order was captured.', mode: result.mode })
    }
    assertCaptureMatches(result)
    const purchase = input.checkoutSessionId && result.captureId ? await recordVerifiedCapture({ sessionId: input.checkoutSessionId, orderId: result.orderId, captureId: result.captureId }) : undefined
    response.status(200).json({ ...result, purchase, disclaimer: 'This is a single buyer-to-merchant PayPal capture. WHOOSH participant consent and allocation remain off-rail workflow records.' })
  } catch (error) { try { paypalFailure(error, response) } catch (unknown) { next(unknown) } }
})

/**
 * Independent payer checkout is deliberately four separate buyer-to-merchant
 * Orders. It is WHOOSH coordination, not a multi-buyer PayPal Order.
 */
paymentsRouter.post('/paypal/independent/sessions/:sessionId/commitments', async (request, response, next) => {
  try { response.status(201).json(await ensureIndependentPaymentCommitments(z.string().uuid().parse(request.params.sessionId))) }
  catch (error) { next(error) }
})

paymentsRouter.get('/paypal/independent/sessions/:sessionId', async (request, response, next) => {
  try { response.json(await getIndependentPaymentCheckout(z.string().uuid().parse(request.params.sessionId))) }
  catch (error) { next(error) }
})

paymentsRouter.get('/paypal/independent/sessions/:sessionId/merchant-booking', async (request, response, next) => {
  try { response.json((await getIndependentPaymentCheckout(z.string().uuid().parse(request.params.sessionId))).merchantBooking) }
  catch (error) { next(error) }
})

paymentsRouter.post('/paypal/participant/order', ensureDemoParticipantCheckout, async (request, response, next) => {
  try {
    const { token } = z.object({ token: participantTokenSchema }).parse(request.body)
    const participant = await resolveParticipantPaymentToken(token)
    const checkout = await ensureIndependentPaymentCommitments(participant.sessionId)
    const commitment = checkout.commitments.find((row) => row.memberId === participant.memberId)
    if (!commitment || commitment.amountCents !== participant.amountCents || commitment.currency !== participant.currency) throw new TypeError('This payment link does not match the assigned share')
    const returnUrl = `${safeWebOrigin()}/?paypal=participant-return&session=${encodeURIComponent(participant.sessionId)}&commitment=${encodeURIComponent(commitment.id)}`
    const cancelUrl = `${safeWebOrigin()}/?paypal=participant-cancel&session=${encodeURIComponent(participant.sessionId)}&commitment=${encodeURIComponent(commitment.id)}`
    const opened = await createIndependentPayPalOrder({ sessionId: participant.sessionId, commitmentId: commitment.id, returnUrl, cancelUrl, gateway: createPayPalOrdersGateway() })
    response.status(201).json({ commitment: opened, mode: opened.providerOrderId === 'PAYPAL_SANDBOX_NOT_CONFIGURED' ? 'mock' : 'sandbox' })
  } catch (error) { try { paypalFailure(error, response) } catch (unknown) { next(unknown) } }
})

paymentsRouter.post('/paypal/participant/capture', ensureDemoParticipantCheckout, async (request, response, next) => {
  try {
    const { token, orderId } = z.object({ token: participantTokenSchema, orderId: z.string().trim().min(1).max(128) }).parse(request.body)
    const participant = await resolveParticipantPaymentToken(token)
    const checkout = await getIndependentPaymentCheckout(participant.sessionId)
    const commitment = checkout.commitments.find((row) => row.memberId === participant.memberId)
    if (!commitment || commitment.amountCents !== participant.amountCents || commitment.currency !== participant.currency || commitment.providerOrderId !== orderId) throw new TypeError('This PayPal order does not match the participant link')
    response.json(await captureIndependentPayPalOrder({ sessionId: participant.sessionId, commitmentId: commitment.id, orderId, gateway: createPayPalOrdersGateway() }))
  } catch (error) { try { paypalFailure(error, response) } catch (unknown) { next(unknown) } }
})

paymentsRouter.post('/paypal/participant/cancel', ensureDemoParticipantCheckout, async (request, response, next) => {
  try {
    const { token } = z.object({ token: participantTokenSchema }).parse(request.body)
    const participant = await resolveParticipantPaymentToken(token)
    const checkout = await getIndependentPaymentCheckout(participant.sessionId)
    const commitment = checkout.commitments.find((row) => row.memberId === participant.memberId)
    if (!commitment) throw new TypeError('This participant payment is unavailable')
    response.json(await cancelIndependentPaymentCommitment(participant.sessionId, commitment.id, createPayPalOrdersGateway()))
  } catch (error) { try { paypalFailure(error, response) } catch (unknown) { next(unknown) } }
})

paymentsRouter.post('/paypal/independent/sessions/:sessionId/commitments/:commitmentId/orders', async (request, response, next) => {
  try {
    const sessionId = z.string().uuid().parse(request.params.sessionId)
    const commitmentId = z.string().uuid().parse(request.params.commitmentId)
    const input = memberPaymentSchema.parse(request.body)
    const returnUrl = `${safeWebOrigin()}/?paypal=member-return&session=${encodeURIComponent(sessionId)}&commitment=${encodeURIComponent(commitmentId)}`
    const cancelUrl = `${safeWebOrigin()}/?paypal=member-cancel&session=${encodeURIComponent(sessionId)}&commitment=${encodeURIComponent(commitmentId)}`
    const commitment = await createIndependentPayPalOrder({ sessionId, commitmentId, ...input, returnUrl, cancelUrl, gateway: createPayPalOrdersGateway() })
    response.status(201).json({ commitment, mode: commitment.providerOrderId === 'PAYPAL_SANDBOX_NOT_CONFIGURED' ? 'mock' : 'sandbox', disclaimer: 'Each card represents a separate PayPal buyer-to-Northline order. WHOOSH reconciles them; it does not create a native multi-payer PayPal order.' })
  } catch (error) { try { paypalFailure(error, response) } catch (unknown) { next(unknown) } }
})

paymentsRouter.post('/paypal/independent/sessions/:sessionId/commitments/:commitmentId/capture', async (request, response, next) => {
  try {
    const sessionId = z.string().uuid().parse(request.params.sessionId)
    const commitmentId = z.string().uuid().parse(request.params.commitmentId)
    const input = z.object({ orderId: z.string().trim().min(1).max(128) }).parse(request.body)
    response.json(await captureIndependentPayPalOrder({ sessionId, commitmentId, orderId: input.orderId, gateway: createPayPalOrdersGateway() }))
  } catch (error) { try { paypalFailure(error, response) } catch (unknown) { next(unknown) } }
})

paymentsRouter.post('/paypal/independent/sessions/:sessionId/commitments/:commitmentId/cancel', async (request, response, next) => {
  try { response.json(await cancelIndependentPaymentCommitment(z.string().uuid().parse(request.params.sessionId), z.string().uuid().parse(request.params.commitmentId), createPayPalOrdersGateway())) }
  catch (error) { next(error) }
})

paymentsRouter.post('/paypal/independent/sessions/:sessionId/cancel-and-refund', async (request, response, next) => {
  try { response.json(await cancelAndRefundIndependentCheckout(z.string().uuid().parse(request.params.sessionId), createPayPalOrdersGateway())) }
  catch (error) { try { paypalFailure(error, response) } catch (unknown) { next(unknown) } }
})

paymentsRouter.post('/paypal/independent/sessions/:sessionId/confirm-demo-booking', async (request, response, next) => {
  try { response.json(await confirmSimulatedNorthlineBooking(z.string().uuid().parse(request.params.sessionId))) }
  catch (error) { next(error) }
})
