import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { environment } from '../../config.js'
import { cancelUnpaidCheckoutDraft, createParticipantApprovalLinks, createCheckoutSession, createPersistentGroup, decideParticipantApproval, getCheckoutSession, getParticipantApproval, getPersistentGroup, listPersistentGroups, recordSimulatedFunding, saveGroupContactEmail, saveSessionAllocation } from './persistent-groups.service.js'

export const persistentGroupsRouter = Router()
export const participantApprovalRouter = Router()
const uuid = z.string().uuid()
const tokenSchema = z.string().regex(/^[\w-]{43}$/)
const ensureDemoApprovalLinks: RequestHandler = (_req, res, next) => {
  if (environment.DEMO_PARTICIPANT_APPROVAL_LINKS !== 'enabled') return res.status(404).json({ error: 'Participant approval links are available only in the local Sandbox demo.' })
  next()
}

persistentGroupsRouter.get('/', async (_req, res, next) => { try { res.json(await listPersistentGroups()) } catch (error) { next(error) } })
persistentGroupsRouter.post('/', async (req, res, next) => { try { const input = z.object({ name: z.string().trim().min(1).max(160), members: z.array(z.union([z.string().trim().min(1).max(120), z.object({ name: z.string().trim().min(1).max(120), email: z.email().max(320).optional() })])).min(1).max(5) }).parse(req.body); res.status(201).json(await createPersistentGroup(input)) } catch (error) { next(error) } })
persistentGroupsRouter.get('/sessions/:sessionId', async (req, res, next) => { try { res.json(await getCheckoutSession(uuid.parse(req.params.sessionId))) } catch (error) { next(error) } })
persistentGroupsRouter.get('/:groupId', async (req, res, next) => { try { res.json(await getPersistentGroup(uuid.parse(req.params.groupId))) } catch (error) { next(error) } })
persistentGroupsRouter.post('/:groupId/sessions/:sessionId/cancel-draft', ensureDemoApprovalLinks, async (req, res, next) => { try { res.json(await cancelUnpaidCheckoutDraft(uuid.parse(req.params.groupId), uuid.parse(req.params.sessionId))) } catch (error) { next(error) } })
persistentGroupsRouter.put('/:groupId/members/:memberId/contact', ensureDemoApprovalLinks, async (req, res, next) => { try { const { email } = z.object({ email: z.email().max(320) }).parse(req.body); res.json(await saveGroupContactEmail(uuid.parse(req.params.groupId), uuid.parse(req.params.memberId), email)) } catch (error) { next(error) } })
persistentGroupsRouter.post('/:groupId/sessions', async (req, res, next) => { try { const input = z.object({ merchant: z.string().min(1), reference: z.string().min(1), totalCents: z.number().int().positive(), currency: z.string().length(3), cart: z.unknown() }).parse(req.body); res.status(201).json(await createCheckoutSession({ ...input, groupId: uuid.parse(req.params.groupId), idempotencyKey: req.header('Idempotency-Key') ?? undefined })) } catch (error) { next(error) } })
persistentGroupsRouter.put('/sessions/:sessionId/allocation', async (req, res, next) => { try { const input = z.object({ instruction: z.string().min(1), allocation: z.unknown(), memberAmounts: z.array(z.object({ memberId: uuid, amountCents: z.number().int().positive() })) }).parse(req.body); res.json(await saveSessionAllocation({ ...input, sessionId: uuid.parse(req.params.sessionId) })) } catch (error) { next(error) } })
persistentGroupsRouter.post('/sessions/:sessionId/participant-approval-links', ensureDemoApprovalLinks, async (req, res, next) => { try { res.json({ localDemoOnly: true, links: await createParticipantApprovalLinks(uuid.parse(req.params.sessionId)) }) } catch (error) { next(error) } })
persistentGroupsRouter.post('/sessions/:sessionId/funding', async (req, res, next) => { try { const input = z.object({ memberId: uuid, outcome: z.enum(['funded', 'failed', 'cancelled']) }).parse(req.body); const sessionId = uuid.parse(req.params.sessionId); await recordSimulatedFunding({ ...input, sessionId, idempotencyKey: req.header('Idempotency-Key') ?? crypto.randomUUID() }); res.json(await getCheckoutSession(sessionId)) } catch (error) { next(error) } })

participantApprovalRouter.post('/inspect', ensureDemoApprovalLinks, async (req, res, next) => {
  try {
    const { token } = z.object({ token: tokenSchema }).parse(req.body)
    res.json({ localDemoOnly: true, approval: await getParticipantApproval(token) })
  } catch (error) { next(error) }
})
participantApprovalRouter.post('/decision', ensureDemoApprovalLinks, async (req, res, next) => {
  try {
    const input = z.object({ token: tokenSchema, decision: z.enum(['approve', 'decline', 'withdraw']) }).parse(req.body)
    res.json({ localDemoOnly: true, ...await decideParticipantApproval(input.token, input.decision) })
  } catch (error) { next(error) }
})
