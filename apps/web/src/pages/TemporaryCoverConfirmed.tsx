import { WhooshLogo } from '../components/WhooshLogo'
interface TemporaryCoverConfirmedProps {
  onBack: () => void
  onViewRepayment: () => void
}

const rows = [
  ['YC', 'You', 'Your $350 + $300 temporary cover', '$650.00', 'Paid', 'lime'],
  ['AC', 'Alex Chen', 'Own contribution · unchanged', '$350.00', 'Paid', 'lavender'],
  ['JE', 'Jordan Ellis', 'Failed contribution · covered by You', '$0.00', 'Owes $300', 'sand'],
  ['MP', 'Maya Patel', 'Own contribution · unchanged', '$284.00', 'Paid', 'blue'],
]

export function TemporaryCoverConfirmed({ onBack, onViewRepayment }: TemporaryCoverConfirmedProps) {
  return <main className="split-page">
    <header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onBack} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p></header>
    <div className="checkout-utility"><button className="text-button" onClick={onBack} type="button">← <span>Back to group</span></button><p>BRANCH C / COVER CONFIRMED</p><button className="close-button" onClick={onBack} type="button">×</button></div>
    <div className="split-layout cover-result-layout"><section className="split-main"><p className="trip-kicker">DEMO BOOKING RESULT · TEMPORARY COVER</p><h1>Simulated cover.<br />One balance still open.</h1><p className="trip-subtitle">You chose to cover Jordan’s $300.00. This demo records the obligation; no PayPal payment or repayment was captured.</p><article className="shares-card cover-result-card"><header><span className="ready-badge">•&nbsp; Demo merchant result</span></header>{rows.map(([initials, name, detail, amount, status, tone]) => <div className="share-row" key={initials}><span className={`person-avatar ${tone}`}>{initials}</span><p><strong>{name}</strong><small>{detail}</small></p><div><strong>{amount}</strong><small className={status === 'Owes $300' ? 'approval-text' : 'ready-text'}>{status}</small></div></div>)}<footer className="cover-totals"><strong>Simulated merchant total</strong><b>$1,284.00</b><span>You temporarily fronted</span><b>$300.00</b><span>Reconciliation difference</span><b>$0.00</b></footer></article><aside className="failure-note"><span>♢</span><div><strong>Booking result does not mean everyone is settled</strong><p>Jordan’s $300.00 debt is still outstanding. A scheduled repayment is not a completed repayment.</p></div></aside><div className="final-actions"><button className="confirm-pay" type="button">View group balance</button><button className="manual-button" type="button">Download demo receipt</button></div></section><aside className="cover-debt-summary"><p>JORDAN OWES YOU · USD</p><strong>$300.00</strong><span>•&nbsp; Debt outstanding</span><hr /><h2>Auto-Settle concept preview</h2><p>Jordan previously authorized repayment of this debt up to $300.00 to you. This is an internal policy demonstration, not a PayPal repayment instruction.</p><p>He can revoke before collection. Recovery is not guaranteed. Debt clears only when repayment confirms.</p><button type="button" onClick={onViewRepayment}>View repayment status</button></aside></div>
    <footer className="merchant-footer"><span>MONTRÉAL&nbsp; / &nbsp;WSH–1023&nbsp; · &nbsp;ALL AMOUNTS USD</span><span>Need a hand? Get help</span></footer>
  </main>
}
