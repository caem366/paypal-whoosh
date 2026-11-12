import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCheckoutCoordinatorRouter, isLocalCheckoutCoordinatorAllowed } from './purchase-agent.routes.js'

const sessionId = 'c4f7dc9e-6f7a-4b54-a65f-3147888fdf10'

async function withRouter(router: express.Router, run: (url: string) => Promise<void>) {
  const app = express()
  app.use(express.json())
  app.use('/api/agent', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof TypeError && error.message.includes('not found') ? 404 : 400).json({ error: 'Request failed' })
  })
  const server = app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not start')
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

afterEach(() => vi.restoreAllMocks())

describe('checkout coordinator route boundary', () => {
  it('only enables the coordinator for local non-production demo requests', () => {
    expect(isLocalCheckoutCoordinatorAllowed({ nodeEnv: 'development', remoteAddress: '127.0.0.1' })).toBe(true)
    expect(isLocalCheckoutCoordinatorAllowed({ nodeEnv: 'production', remoteAddress: '127.0.0.1' })).toBe(false)
    expect(isLocalCheckoutCoordinatorAllowed({ nodeEnv: 'development', demoLinks: 'disabled', remoteAddress: '127.0.0.1' })).toBe(false)
    expect(isLocalCheckoutCoordinatorAllowed({ nodeEnv: 'development', remoteAddress: '10.0.0.5' })).toBe(false)
  })

  it('rejects malformed chat requests and cannot invoke the agent', async () => {
    const run = vi.fn()
    await withRouter(createCheckoutCoordinatorRouter({ enabled: (_request, _response, next) => next(), run: run as never }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agent/checkouts/${sessionId}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x', sessionId: 'other' }),
      })
      expect(response.status).toBe(400)
      expect(run).not.toHaveBeenCalled()
    })
  })

  it('does not disclose or answer for a checkout that the backend cannot resolve', async () => {
    const run = vi.fn().mockRejectedValue(new TypeError('Checkout session not found'))
    await withRouter(createCheckoutCoordinatorRouter({ enabled: (_request, _response, next) => next(), run: run as never }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agent/checkouts/${sessionId}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'What is the status?' }),
      })
      expect(response.status).toBe(404)
      expect(run).toHaveBeenCalledWith(sessionId, 'What is the status?')
    })
  })

  it('returns only read-only tool metadata with the conversational response', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'Jordan paid $350; $934 remains.', toolsUsed: ['getGroupCheckoutStatus'] })
    await withRouter(createCheckoutCoordinatorRouter({ enabled: (_request, _response, next) => next(), run: run as never }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agent/checkouts/${sessionId}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'How much is left?' }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        response: 'Jordan paid $350; $934 remains.',
        toolsUsed: ['getGroupCheckoutStatus'],
        disclaimer: expect.stringContaining('not payment confirmations'),
      })
    })
  })
})
