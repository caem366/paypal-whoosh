import type { IndependentPaymentCommitment } from '../api/whoosh'

export function sandboxBuyerEmail(commitment: Pick<IndependentPaymentCommitment, 'expectedPayerEmail'>, savedContact: string | null | undefined, override?: string) {
  return override ?? commitment.expectedPayerEmail ?? savedContact ?? ''
}
