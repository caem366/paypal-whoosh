export function CheckoutPhases({ current }: { current: 'split' | 'invite' | 'pay' }) {
  const phases = ['split', 'invite', 'pay'] as const
  return <ol className="checkout-phases" aria-label="Checkout progress">{phases.map((phase, index) => <li key={phase} aria-current={phase === current ? 'step' : undefined} className={phase === current ? 'current' : ''}><span>{index + 1}</span>{phase === 'invite' ? 'Invite & approve' : phase === 'pay' ? 'Pay & track' : 'Split'}</li>)}</ol>
}
