import { afterEach, describe, expect, it, vi } from 'vitest'
import { PayPalSandboxOrdersGateway } from './paypal-orders.service.js'

afterEach(() => vi.unstubAllGlobals())

const gateway = () => new PayPalSandboxOrdersGateway('client', 'secret', 'https://api-m.sandbox.paypal.com')
const token = () => new Response(JSON.stringify({ access_token: 'token' }), { status: 200 })

describe('PayPal Sandbox gateway', () => {
  it('creates one CAPTURE order with a stable request ID', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ORDER-1', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }] })))
    vi.stubGlobal('fetch', fetch)
    const order = await gateway().createOrder({ totalCents: 35_000, currency: 'USD', reference: 'whoosh-commitment-1', customId: 'PURCHASE-1', invoiceId: 'SHARE-1' })
    expect(order.orderId).toBe('ORDER-1')
    expect(fetch.mock.calls[1]?.[1]?.headers['PayPal-Request-Id']).toBe('whoosh-commitment-1')
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body).intent).toBe('CAPTURE')
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body).purchase_units[0]).toMatchObject({ custom_id: 'PURCHASE-1', invoice_id: 'SHARE-1' })
  })

  it('reads provider order, payer, and exact capture amount and currency', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ORDER-1', status: 'COMPLETED', payer: { email_address: 'buyer@example.com' }, purchase_units: [{ amount: { value: '350.00', currency_code: 'USD' }, custom_id: 'PURCHASE-1', invoice_id: 'SHARE-1', payee: { merchant_id: 'PAYEE-1' }, payments: { captures: [{ id: 'CAPTURE-1', status: 'COMPLETED', amount: { value: '350.00', currency_code: 'USD' } }] } }] })))
    vi.stubGlobal('fetch', fetch)
    expect(await gateway().getOrder('ORDER-1')).toMatchObject({ orderCents: 35_000, currency: 'USD', customId: 'PURCHASE-1', invoiceId: 'SHARE-1', payeeMerchantId: 'PAYEE-1', captureId: 'CAPTURE-1', captureCents: 35_000, captureCurrency: 'USD', captureStatus: 'COMPLETED', payerEmail: 'buyer@example.com' })
  })

  it('captures with the commitment request ID and returns provider capture details', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ORDER-1', status: 'COMPLETED', payer: { email_address: 'buyer@example.com' }, purchase_units: [{ amount: { value: '350.00', currency_code: 'USD' }, payments: { captures: [{ id: 'CAPTURE-1', status: 'COMPLETED', amount: { value: '350.00', currency_code: 'USD' } }] } }] })))
    vi.stubGlobal('fetch', fetch)
    expect(await gateway().captureOrder('ORDER-1', 'whoosh-capture-1')).toMatchObject({ captureId: 'CAPTURE-1', captureCents: 35_000, captureCurrency: 'USD' })
    expect(fetch.mock.calls[1]?.[1]?.headers['PayPal-Request-Id']).toBe('whoosh-capture-1')
  })

  it('requests a full refund once and reads back provider status', async () => {
    const refund = { id: 'REFUND-1', status: 'COMPLETED', amount: { value: '350.00', currency_code: 'USD' } }
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify(refund))).mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify(refund)))
    vi.stubGlobal('fetch', fetch)
    expect(await gateway().refundCapture('CAPTURE-1', 'whoosh-refund-1')).toEqual({ refundId: 'REFUND-1', status: 'COMPLETED', amountCents: 35_000, currency: 'USD' })
    expect(fetch.mock.calls[1]?.[1]?.headers['PayPal-Request-Id']).toBe('whoosh-refund-1')
    expect(fetch.mock.calls[1]?.[1]?.body).toBe('{}')
    expect(await gateway().getRefund('REFUND-1')).toMatchObject({ status: 'COMPLETED' })
  })

  it('keeps a pending refund pending and exposes a provider failure', async () => {
    const pending = { id: 'REFUND-2', status: 'PENDING', amount: { value: '350.00', currency_code: 'USD' } }
    const fetch = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify(pending))).mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({ name: 'REFUND_FAILED', message: 'Cannot refund' }), { status: 422 }))
    vi.stubGlobal('fetch', fetch)
    expect(await gateway().getRefund('REFUND-2')).toMatchObject({ status: 'PENDING' })
    await expect(gateway().refundCapture('CAPTURE-1', 'whoosh-refund-1')).rejects.toMatchObject({ statusCode: 422, code: 'REFUND_FAILED' })
  })
})
