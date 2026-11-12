import { WhooshLogo } from '../components/WhooshLogo'
import { useEffect, useState } from 'react'
import { listPersistentGroups } from '../api/whoosh'
import { GroupsDashboard } from './GroupsDashboard'

type GroupsHomeProps = {
  initialGroupId?: string
  onClose: () => void
  onCreate: () => void
  onOpenGroup: (groupId: string) => void
  onResume: (groupId: string, sessionId?: string) => void
  onPlanPurchase: (groupId: string) => void
}

/** The app home is derived from persisted groups, never a local first-visit flag. */
export function GroupsHome({ initialGroupId, onClose, onCreate, onOpenGroup, onResume, onPlanPurchase }: GroupsHomeProps) {
  const [state, setState] = useState<'loading' | 'welcome' | 'dashboard' | 'error'>('loading')

  useEffect(() => {
    let active = true
    listPersistentGroups()
      .then((groups) => active && setState(groups.length ? 'dashboard' : 'welcome'))
      .catch(() => active && setState('error'))
    return () => { active = false }
  }, [])

  if (state === 'dashboard') return <GroupsDashboard initialGroupId={initialGroupId} onClose={onClose} onCreate={onCreate} onOpenGroup={onOpenGroup} onResume={onResume} onPlanPurchase={onPlanPurchase} />

  return <main className="split-page groups-welcome-page">
    <header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onClose} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p><div className="group-profile"><strong>Your groups</strong><span>YC</span></div></header>
    <section className="groups-welcome-shell">
      {state === 'loading' ? <p className="groups-loading">Loading your groups…</p> : <>
        <p className="trip-kicker">WELCOME TO WHOOSH</p>
        <h1>Better together.</h1>
        <p className="groups-welcome-intro">Create a group once, then bring the same people, personal limits, and shared history to every plan.</p>
        {state === 'error' && <p className="sandbox-notice">WHOOSH couldn’t check your saved groups. You can still create a group, then try again.</p>}
        <div className="groups-welcome-grid">
          <article className="groups-welcome-card"><WhooshLogo iconOnly className="create-success-check" /><p>START WITH YOUR PEOPLE</p><h2>One group.<br />Many good plans.</h2><span>Jamie is the Host. Every person keeps control of their own payment permission.</span><button type="button" onClick={onCreate}>Create a group <b>→</b></button><small>You’ll invite your people first. Payment permissions come later and always require their consent.</small></article>
          <aside className="groups-welcome-side"><article><h2>People before payments.</h2><p>WHOOSH remembers who you travel, eat, and plan with—not a shared wallet or a blank check.</p></article><div><span>1</span><p><strong>Create your group</strong><small>Invite people. Jamie is the Host.</small></p><span>2</span><p><strong>Start a shared checkout</strong><small>Choose a saved group from a merchant.</small></p><span>3</span><p><strong>Each person chooses</strong><small>Limits and one-time approvals stay personal.</small></p></div></aside>
        </div>
      </>}
    </section>
  </main>
}
