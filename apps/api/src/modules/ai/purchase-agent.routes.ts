import { Router } from 'express'
import { z } from 'zod'
import { confirmAgentProposal, createAgentProposal, editAgentAllocation, getAgentProposal } from './purchase-agent.service.js'
import { runCheckoutCoordinator } from './checkout-coordinator.service.js'
import type { RequestHandler } from 'express'

export const purchaseAgentRouter = Router()
const uuid = z.string().uuid()

export function isLocalCheckoutCoordinatorAllowed(input: { nodeEnv?: string; demoLinks?: string; remoteAddress?: string }) {
  const address = input.remoteAddress?.toLowerCase().replace(/^::ffff:/, '')
  return input.nodeEnv !== 'production'
    && input.demoLinks !== 'disabled'
    && (address === '::1' || address?.startsWith('127.'))
}

export function createCheckoutCoordinatorRouter(options: {
  run?: typeof runCheckoutCoordinator
  enabled?: RequestHandler
} = {}) {
  const router = Router()
  const localDemoOnly: RequestHandler = options.enabled ?? ((request, response, next) => {
    if (!isLocalCheckoutCoordinatorAllowed({
      nodeEnv: process.env.NODE_ENV,
      demoLinks: process.env.DEMO_PARTICIPANT_APPROVAL_LINKS,
      remoteAddress: request.socket.remoteAddress,
    })) {
      return response.status(404).json({ error: 'The checkout coordinator is available only in the local Sandbox demo.' })
    }
    next()
  })
  router.post('/checkouts/:sessionId/chat', localDemoOnly, async (request, response, next) => {
    try {
      const sessionId = uuid.parse(request.params.sessionId)
      const { message } = z.object({ message: z.string().trim().min(2).max(1000) }).strict().parse(request.body)
      const result = await (options.run ?? runCheckoutCoordinator)(sessionId, message)
      response.json({ ...result, disclaimer: 'AI recommendations are not payment confirmations. Verified funding remains determined by WHOOSH’s PayPal-validated records.' })
    } catch (error) { next(error) }
  })
  return router
}

purchaseAgentRouter.use(createCheckoutCoordinatorRouter())

purchaseAgentRouter.post('/proposals', async (request, response, next) => {
  try {
    const input = z.object({ groupId: uuid, request: z.string().trim().min(10).max(4000) }).strict().parse(request.body)
    response.json(await createAgentProposal(input.groupId, input.request))
  } catch (error) { next(error) }
})

purchaseAgentRouter.get('/proposals/:proposalId', async (request, response, next) => {
  try { response.json(await getAgentProposal(uuid.parse(request.params.proposalId))) }
  catch (error) { next(error) }
})

purchaseAgentRouter.put('/proposals/:proposalId/allocation', async (request, response, next) => {
  try {
    const input = z.object({ assignments: z.array(z.object({ itemId: z.string().min(1), memberIds: z.array(uuid).min(1) }).strict()) }).strict().parse(request.body)
    response.json(await editAgentAllocation(uuid.parse(request.params.proposalId), input.assignments))
  } catch (error) { next(error) }
})

purchaseAgentRouter.post('/proposals/:proposalId/confirm', async (request, response, next) => {
  try { response.json(await confirmAgentProposal(uuid.parse(request.params.proposalId))) }
  catch (error) { next(error) }
})
