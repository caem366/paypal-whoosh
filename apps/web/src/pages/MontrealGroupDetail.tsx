import { WhooshLogo } from '../components/WhooshLogo'
interface MontrealGroupDetailProps { onBack: () => void; onStartSplit: () => void; onPermissions: () => void }

const members = [
  ['YC', 'lime', 'Jamie Cooper', 'Host · You · ticket + upgrade + shuttle', '$350.00'],
  ['AC', 'lavender', 'Alex Chen', 'Member · ticket + upgrade + shuttle', '$350.00'],
  ['JE', 'sand', 'Jordan Ellis', 'Member · ticket + shuttle', '$300.00'],
  ['MP', 'blue', 'Maya Patel', 'Member · $284 approved once; limit stays $250', '$284.00'],
]
const history = [['Dinner at Le Passage', 'Sep 28 · Montreal Crew · USD', '$192.00'], ['Train tickets', 'Sep 20 · Montreal Crew · USD', '$248.00'], ['Museum passes', 'Sep 14 · Montreal Crew · USD', '$96.00']]

export function MontrealGroupDetail({ onBack, onStartSplit, onPermissions }: MontrealGroupDetailProps) {
  return <main className="split-page montreal-desktop-page">
    <header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onBack} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p><div className="group-profile"><strong>Your groups</strong><span>YC</span></div></header>
    <div className="groups-utility"><button className="text-button" type="button" onClick={onBack}>← Back to groups</button><strong>MONTREAL CREW</strong><button className="close-button" onClick={onBack} type="button" aria-label="Close">×</button></div>
    <section className="montreal-desktop-shell">
      <header className="montreal-detail-heading"><p className="trip-kicker">4 MEMBERS · 3 PREVIOUS PURCHASES</p><h1>Montreal Crew.</h1><span>Jamie, Alex, Jordan &amp; Maya. Your shared plans, without shared passwords.</span></header>
      <div className="montreal-detail-grid">
        <section className="montreal-detail-left">
          <article className="montreal-members-card"><h2>Your people. Their own shares.</h2><span className="montreal-ready-badge">• 4 accepted members · 4/4 authorized</span><p>These amounts are authorized for the pending Northline checkout, not completed payments.</p>
            <div className="montreal-member-list">{members.map(([initials, tone, name, detail, amount]) => <div key={initials}><span className={`person-avatar ${tone}`}>{initials}</span><section><strong>{name}</strong><small>{detail}</small></section><aside><b>{amount}</b><small>Authorized</small></aside></div>)}</div>
            <footer><p>Jamie manages the group and invitations. Each member consents separately; Jamie cannot edit another member’s permission limit.</p><button type="button" onClick={onPermissions}>Manage members &amp; invites</button></footer>
          </article>
          <article className="montreal-history-card"><h2>Purchase history</h2><p>3 PREVIOUS PURCHASES · USD</p>{history.map(([name, detail, amount]) => <div key={name}><i>✓</i><section><strong>{name}</strong><small>{detail}</small></section><aside><b>{amount}</b><small>Paid</small></aside></div>)}<footer>Northline is still pending and isn’t counted here. Paid means the payment was confirmed.</footer></article>
          <article className="montreal-trail-card"><h2>The paper trail</h2><div><i>♢</i><section><strong>Maya granted a $284 one-time approval</strong><small>Today, 9:41 AM · Northline · approval only, not a payment. Her standing limit stays $250.00.</small></section></div><div><i>♧</i><section><strong>Jamie created the Northline split</strong><small>Today, 9:40 AM · 4 shares · $1,284.00 USD. Checkout is pending; no money collected.</small></section></div>{history.map(([name, detail, amount]) => <div key={`trail-${name}`}><i>✓</i><section><strong>{name}</strong><small>{detail} · Payment confirmed</small></section><aside><b>{amount}</b><small>Paid</small></aside></div>)}</article>
          <article className="montreal-rules-card"><h2>Group rules</h2><div><strong>Own share. Own consent.</strong><p>Each person uses their own funding source. Joining the group grants no payment permission.</p></div><div><strong>Ask before going above a limit.</strong><p>A higher share needs a separate one-time approval. Standing limits stay unchanged.</p></div><div><strong>Pause if a contribution fails.</strong><p>No extra contribution or temporary cover without the affected member’s consent.</p></div><div><strong>Host manages the group, not limits.</strong><p>Jamie handles invites. Members control their own permissions and can revoke anytime.</p></div><footer>Saved rules are preferences, not authorization for arbitrary member spending.</footer></article>
          <aside className="montreal-bottom-note"><span>♢</span><div><strong>Permission. Not a blank check.</strong><p>Approvals are not completed payments. Each member controls their own money, every time.</p></div></aside>
        </section>
        <aside className="montreal-detail-right">
          <article className="montreal-checkout-card"><p>NORTHLINE TRAVEL · USD</p><h2>A long weekend. Four good friends.</h2><span>Montreal Crew · Oct 23–26</span><strong>$1,284.00</strong><em>• Authorized, not paid</em><small>4/4 shares authorized. No money collected.</small><hr /><div><span>4 tickets · $284 each</span><b>$1,136.00</b><span>Cabin upgrade</span><b>$100.00</b><span>Station shuttle</span><b>$48.00</b></div><p>CHECKOUT STATUS · USD</p><div><span>Checkout total</span><b>$1,284.00</b><span>Authorized shares</span><b>$1,284.00</b></div><footer><strong>Collected so far</strong><b>$0.00</b></footer><button type="button" onClick={onStartSplit}>Resume Checkout <b>→</b></button><small>Continue to Review &amp; pay. Money moves only when checkout payment is confirmed. No confirmed transaction or merchant receipt yet.</small></article>
          <section className="montreal-permissions"><h2>Saved permissions</h2><article><header><span className="person-avatar blue">MP</span><div><strong>Maya Patel</strong><small>Montreal Crew · active, revocable</small></div><b>♢</b></header><div><span>Standing limit</span><strong>$250.00</strong></div><p>Maya’s own share, per purchase, in this group only. Only Maya can change her limit or expiry. Revoke anytime.</p></article><article><header><span className="person-avatar blue">MP</span><div><strong>Maya Patel</strong><small>Northline checkout only · granted</small></div><b>♢</b></header><div><span>One-time approval</span><strong>$284.00</strong></div><p>Granted for this pending checkout, not used for payment. Separate from her standing limit, which stays $250.00.</p></article><article className="montreal-permission-details"><span>• Active · revocable</span><dl><dt>GROUP</dt><dd>Montreal Crew only</dd><dt>INITIATED BY</dt><dd>Jamie Cooper · Host</dd><dt>PAYMENT SCOPE</dt><dd>Maya’s own share · Northline Travel</dd><dt>FUNDING SOURCE</dt><dd>PayPal · Visa •• 4242</dd><dt>EXPIRES</dt><dd>Oct 27, 2026 · 11:59 PM</dd></dl><footer>Only Maya can edit or revoke this permission. Revocation stops future requests; it doesn’t reverse confirmed payments.</footer></article></section>
        </aside>
      </div>
    </section>
  </main>
}
