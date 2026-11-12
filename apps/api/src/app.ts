import cors from 'cors'
import express from 'express'
import { ZodError } from 'zod'

import { pool } from './db/client.js'
import { environment } from './config.js'
import { groupsRouter } from './modules/groups/groups.routes.js'
import { participantApprovalRouter, persistentGroupsRouter } from './modules/groups/persistent-groups.routes.js'
import { sandboxRouter } from './modules/transactions/transactions.routes.js'
import { settlementsRouter } from './modules/settlements/settlements.routes.js'
import { allocationRouter } from './modules/allocation/allocation.routes.js'
import { paymentsRouter } from './modules/payments/payments.routes.js'
import { PayPalOrdersError } from './modules/payments/paypal-orders.service.js'
import { voiceRouter } from './modules/voice/voice.routes.js'
import { purchaseAgentRouter } from './modules/ai/purchase-agent.routes.js'
import { AgentProviderError } from './modules/ai/purchase-agent.service.js'

export const app = express()

app.use(cors({ origin: environment.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean) }))
app.use(express.json())
app.use('/api/voice', express.raw({ type: 'audio/*', limit: '16mb' }), voiceRouter)
app.use('/api/groups', groupsRouter)
app.use('/api/persistent-groups', persistentGroupsRouter)
app.use('/api/participant-approvals', participantApprovalRouter)
app.use('/api/sandbox', sandboxRouter)
app.use('/api/settlements', settlementsRouter)
app.use('/api/allocation', allocationRouter)
app.use('/api/agent', purchaseAgentRouter)
app.use('/api/payments', paymentsRouter)

app.get('/health', async (_request, response) => {
  await pool.query('SELECT 1')
  response.status(200).json({ status: 'ok' })
})

app.get('/api/health', (_request, response) => {
  response.status(200).json({ service: 'whoosh-api', status: 'ok' })
})

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof ZodError || error instanceof SyntaxError) return response.status(400).json({ error: 'Invalid request' })
    if (error instanceof PayPalOrdersError) return response.status(502).json({ error: 'PayPal Sandbox could not complete the request', code: error.code })
    if (error instanceof AgentProviderError) return response.status(502).json({ error: error.message })
    if (error instanceof TypeError) return response.status(error.message.includes('not found') ? 404 : 409).json({ error: error.message })
    response.status(500).json({ error: 'Unexpected server error' })
  },
)
