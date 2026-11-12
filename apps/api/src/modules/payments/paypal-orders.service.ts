export interface PayPalOrderGateway {
  createOrder(input: { totalCents: number; currency: 'USD'; reference: string; customId?: string; invoiceId?: string; returnUrl?: string; cancelUrl?: string }): Promise<{ orderId: string; approvalUrl?: string; mode: 'sandbox' | 'mock' }>
  getOrder(orderId: string): Promise<VerifiedOrder>
  captureOrder(orderId: string, reference: string): Promise<VerifiedOrder & { mode: 'sandbox' | 'mock' }>
  refundCapture(captureId: string, requestId: string): Promise<{ refundId: string; status: string; amountCents: number; currency: string }>
  getRefund(refundId: string): Promise<{ refundId: string; status: string; amountCents: number; currency: string }>
}

export interface VerifiedOrder { orderId: string; status: string; orderCents?: number; currency?: string; customId?: string; invoiceId?: string; payeeMerchantId?: string; captureId?: string; captureCents?: number; captureCurrency?: string; captureStatus?: string; payerEmail?: string }

export class PayPalOrdersError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code?: string, readonly debugId?: string) { super(message) }
}

/** Standard Orders is a single buyer → merchant checkout. WHOOSH coordinates
 * group approvals off-rail and must never claim this represents multi-payer capture. */
export class MockPayPalOrdersGateway implements PayPalOrderGateway {
  async createOrder(input: { totalCents: number; currency: 'USD'; reference: string }) {
    // This is deliberately not a PayPal-shaped identifier. Mock mode never
    // represents an order as created or payable.
    return { orderId: 'PAYPAL_SANDBOX_NOT_CONFIGURED', mode: 'mock' as const }
  }
  async captureOrder(orderId: string) {
    return { orderId, status: 'UNAVAILABLE' as const, mode: 'mock' as const }
  }
  async getOrder(orderId: string) { return { orderId, status: 'UNAVAILABLE' } }
  async refundCapture(): Promise<{ refundId: string; status: string; amountCents: number; currency: string }> { throw new TypeError('PayPal Sandbox is not configured. No refund was issued.') }
  async getRefund(): Promise<{ refundId: string; status: string; amountCents: number; currency: string }> { throw new TypeError('PayPal Sandbox is not configured. No refund was verified.') }
}

export class PayPalSandboxOrdersGateway implements PayPalOrderGateway {
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly baseUrl: string) {}
  async createOrder(input: { totalCents: number; currency: 'USD'; reference: string; customId?: string; invoiceId?: string; returnUrl?: string; cancelUrl?: string }) {
    const token = await this.getAccessToken()
    const orderResponse = await fetch(`${this.baseUrl}/v2/checkout/orders`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': input.reference }, body: JSON.stringify({ intent: 'CAPTURE', application_context: input.returnUrl && input.cancelUrl ? { return_url: input.returnUrl, cancel_url: input.cancelUrl, user_action: 'PAY_NOW' } : undefined, purchase_units: [{ reference_id: input.reference, custom_id: input.customId, invoice_id: input.invoiceId, amount: { currency_code: input.currency, value: (input.totalCents / 100).toFixed(2) } }] }) })
    if (!orderResponse.ok) throw await this.toError('PayPal could not create the checkout.', orderResponse)
    const order = await orderResponse.json() as { id: string; links?: Array<{ rel: string; href: string }> }
    return { orderId: order.id, approvalUrl: order.links?.find((link) => link.rel === 'approve')?.href ?? order.links?.find((link) => link.rel === 'payer-action')?.href, mode: 'sandbox' as const }
  }

  async getOrder(orderId: string) {
    const token = await this.getAccessToken()
    const orderResponse = await fetch(`${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!orderResponse.ok) throw await this.toError('PayPal could not verify this checkout.', orderResponse)
    const order = await orderResponse.json() as PayPalOrderPayload
    return normalizeOrder(order)
  }

  async captureOrder(orderId: string, reference: string) {
    const token = await this.getAccessToken()
    const captureResponse = await fetch(`${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': reference },
    })
    if (!captureResponse.ok) throw await this.toError('PayPal could not capture this checkout.', captureResponse)
    const order = await captureResponse.json() as PayPalOrderPayload
    const normalized = normalizeOrder(order)
    const captureId = normalized.captureId
    if (order.status !== 'COMPLETED' || !captureId) throw new Error('PayPal did not return a completed capture')
    return { ...normalized, captureId, status: 'COMPLETED' as const, mode: 'sandbox' as const }
  }

  async refundCapture(captureId: string, requestId: string) {
    const token = await this.getAccessToken()
    const response = await fetch(`${this.baseUrl}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': requestId }, body: '{}' })
    if (!response.ok) throw await this.toError('PayPal could not refund this capture.', response)
    return normalizeRefund(await response.json() as PayPalRefundPayload)
  }

  async getRefund(refundId: string) {
    const token = await this.getAccessToken()
    const response = await fetch(`${this.baseUrl}/v2/payments/refunds/${encodeURIComponent(refundId)}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw await this.toError('PayPal could not verify this refund.', response)
    return normalizeRefund(await response.json() as PayPalRefundPayload)
  }

  private async getAccessToken(): Promise<string> {
    const tokenResponse = await fetch(`${this.baseUrl}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
    if (!tokenResponse.ok) throw await this.toError('PayPal authentication failed.', tokenResponse)
    return (await tokenResponse.json() as { access_token: string }).access_token
  }

  private async toError(message: string, response: Response): Promise<PayPalOrdersError> {
    const payload = await response.json().catch(() => ({})) as { name?: string; message?: string; debug_id?: string; details?: Array<{ issue?: string; description?: string }> }
    const issue = payload.details?.[0]?.issue ?? payload.name
    const detail = payload.details?.[0]?.description ?? payload.message
    return new PayPalOrdersError(detail ? `${message} ${detail}` : message, response.status, issue, payload.debug_id)
  }
}

type PayPalOrderPayload = {
  id: string
  status: string
  payer?: { email_address?: string }
  payment_source?: { paypal?: { email_address?: string } }
  purchase_units?: Array<{ amount?: { value?: string; currency_code?: string }; custom_id?: string; invoice_id?: string; payee?: { merchant_id?: string }; payments?: { captures?: Array<{ id: string; status?: string; amount?: { value?: string; currency_code?: string }; payee?: { merchant_id?: string } }> } }>
}

type PayPalRefundPayload = { id: string; status: string; amount?: { value?: string; currency_code?: string } }

function cents(value: string | undefined) {
  return value && /^\d+(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : undefined
}

function normalizeRefund(refund: PayPalRefundPayload) {
  const amountCents = cents(refund.amount?.value)
  if (!refund.id || amountCents === undefined || !refund.amount?.currency_code) throw new TypeError('PayPal returned an incomplete refund')
  return { refundId: refund.id, status: refund.status, amountCents, currency: refund.amount.currency_code }
}

function normalizeOrder(order: PayPalOrderPayload) {
  const capture = order.purchase_units?.flatMap((unit) => unit.payments?.captures ?? []).at(0)
  return {
    orderId: order.id,
    status: order.status,
    orderCents: cents(order.purchase_units?.[0]?.amount?.value),
    currency: order.purchase_units?.[0]?.amount?.currency_code,
    customId: order.purchase_units?.[0]?.custom_id,
    invoiceId: order.purchase_units?.[0]?.invoice_id,
    payeeMerchantId: capture?.payee?.merchant_id ?? order.purchase_units?.[0]?.payee?.merchant_id,
    captureId: capture?.id,
    captureCents: cents(capture?.amount?.value),
    captureCurrency: capture?.amount?.currency_code,
    captureStatus: capture?.status,
    payerEmail: order.payment_source?.paypal?.email_address ?? order.payer?.email_address,
  }
}

export function createPayPalOrdersGateway(env = process.env): PayPalOrderGateway {
  if (env.PAYPAL_MODE === 'sandbox' && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) return new PayPalSandboxOrdersGateway(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET, env.PAYPAL_BASE_URL ?? 'https://api-m.sandbox.paypal.com')
  return new MockPayPalOrdersGateway()
}
