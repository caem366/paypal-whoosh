import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { app } from '../../app.js'

describe('participant approval routes', () => {
  it('validates bearer tokens and rejects legacy member-ID approval', async () => {
    const server = app.listen(0)
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const malformed = await fetch(`${base}/api/participant-approvals/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-token' }),
      })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ error: 'Invalid request' })

      const invalidPayment = await fetch(`${base}/api/payments/paypal/participant/order`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'not-a-token', memberId: '00000000-0000-4000-8000-000000000001', amountCents: 1 }),
      })
      expect(invalidPayment.status).toBe(400)

      const legacy = await fetch(`${base}/api/persistent-groups/sessions/not-a-session/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: '00000000-0000-4000-8000-000000000001', approvedCents: 100 }),
      })
      expect(legacy.status).toBe(404)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
