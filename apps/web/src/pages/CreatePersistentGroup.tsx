import { WhooshLogo } from '../components/WhooshLogo'
import { useState } from 'react'
import { createPersistentGroup } from '../api/whoosh'

export type CreatedInvitee = { name: string; email: string }
type Invitee = CreatedInvitee
const emptyInvitee = (): Invitee => ({ name: '', email: '' })

export function CreatePersistentGroup({ onBack, onCreated }: { onBack: () => void; onCreated: (group: { id: string; name: string }, invitees: CreatedInvitee[]) => void }) {
  const [groupName, setGroupName] = useState('')
  const [invitees, setInvitees] = useState<Invitee[]>([emptyInvitee()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempted, setAttempted] = useState(false)
  const enteredInvitees = invitees.filter((invitee) => invitee.name.trim() || invitee.email.trim())
  const normalizedEmails = enteredInvitees.map((invitee) => invitee.email.trim().toLowerCase())
  const duplicateEmails = new Set(normalizedEmails.filter((email, index) => email && normalizedEmails.indexOf(email) !== index))
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const groupNameError = groupName.trim() ? '' : 'Give your group a name so everyone knows where they’re joining.'
  const inviteErrors = invitees.map((invitee) => {
    const isEntered = Boolean(invitee.name.trim() || invitee.email.trim())
    if (!isEntered) return { name: '', email: '' }
    const name = invitee.name.trim() ? '' : 'Add a name or remove this row.'
    const normalizedEmail = invitee.email.trim().toLowerCase()
    const email = !normalizedEmail ? 'Add an email address to save this contact.' : !emailPattern.test(normalizedEmail) ? 'Enter a valid email address.' : duplicateEmails.has(normalizedEmail) ? 'This email is already saved here. Enter a different email or remove this row.' : ''
    return { name, email }
  })
  const inviteCountError = enteredInvitees.length ? '' : 'Invite at least one person to start a group.'
  const hasValidationErrors = Boolean(groupNameError || inviteCountError || inviteErrors.some((invitee) => invitee.name || invitee.email))
  const issueCount = Number(Boolean(groupNameError)) + Number(Boolean(inviteCountError)) + inviteErrors.reduce((count, invitee) => count + Number(Boolean(invitee.name)) + Number(Boolean(invitee.email)), 0)

  const updateInvitee = (index: number, field: keyof Invitee, value: string) => setInvitees((current) => current.map((invitee, currentIndex) => currentIndex === index ? { ...invitee, [field]: value } : invitee))
  const removeInvitee = (index: number) => setInvitees((current) => current.length === 1 ? current : current.filter((_, currentIndex) => currentIndex !== index))
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setAttempted(true)
    if (hasValidationErrors) return
    setBusy(true); setError('')
    try { const created = await createPersistentGroup(groupName.trim(), ['Jamie Cooper', ...enteredInvitees.map((invitee) => ({ name: invitee.name.trim(), email: invitee.email.trim().toLowerCase() }))]); onCreated({ id: created.group.id, name: created.group.name }, enteredInvitees) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'WHOOSH could not create that group. Please try again.') }
    finally { setBusy(false) }
  }

  return <main className="split-page create-group-page">
    <header className="merchant-header"><button className="whoosh-brand brand-button" onClick={onBack} type="button"><WhooshLogo /></button><p className="brand-tagline">Split now. Not later.</p><div className="group-profile"><strong>Your groups</strong><span>YC</span></div></header>
    <div className="groups-utility"><button className="text-button" type="button" onClick={onBack}>← Back to groups</button><strong>CREATE A GROUP</strong><button className="close-button" onClick={onBack} type="button" aria-label="Close">×</button></div>
    <section className="create-group-shell">
      <div className="create-group-heading"><p className="trip-kicker">CREATE A GROUP / YOUR PEOPLE</p><h1>Better together.</h1><p>One group for all the things you do together. Bring your people, keep the permissions personal.</p></div>
      <div className="create-group-grid">
        <form className="create-group-form" onSubmit={submit}>
          <h2>Make it your group</h2>
          {attempted && hasValidationErrors && <aside className="create-validation-summary"><strong>{issueCount === 1 ? 'One thing to fix before saving.' : `${issueCount} things to fix before saving.`}</strong><span>Add a group name and make sure each contact uses a unique email.</span></aside>}
          <label className={`create-field ${attempted && groupNameError ? 'has-error' : ''}`}><span>GROUP NAME · REQUIRED</span><input value={groupName} onChange={(event) => setGroupName(event.target.value)} onBlur={() => setAttempted(true)} placeholder="Name your group" maxLength={160} autoFocus /></label>
          <small className={attempted && groupNameError ? 'field-error-copy' : ''}>{attempted && groupNameError ? groupNameError : 'A name everyone will recognize.'}</small>
          <hr />
          <p className="create-host-label">YOUR HOST</p>
          <article className="create-host"><span className="person-avatar lime">JC</span><div><strong>Jamie Cooper</strong><small>You · automatically assigned</small></div><section><b>Host</b><small>Not removable</small></section></article>
          <p className="create-explainer">Jamie manages this group and its contacts. Hosting doesn’t let you change another member’s payment limits.</p>
          <hr />
          <header className="create-invite-heading"><h2>Save your people</h2><span>{enteredInvitees.length} / 4 ADDED</span></header>
          <p className="create-invite-copy">Add 1–4 additional members. With you as Host, that’s 2–5 people total.</p>
          <div className="create-invites">{invitees.map((invitee, index) => <article className="create-invite" key={index}>
            <header><span className={`person-avatar ${['lavender', 'sand', 'blue', 'lime'][index]}`}>{invitee.name ? invitee.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() : '+'}</span><strong>{invitee.name || 'New member'}</strong><button type="button" onClick={() => removeInvitee(index)} disabled={invitees.length === 1}>× <span>Remove</span></button></header>
            <div><label className={`create-field ${attempted && inviteErrors[index]?.name ? 'has-error' : ''}`}><span>NAME</span><input value={invitee.name} onChange={(event) => updateInvitee(index, 'name', event.target.value)} onBlur={() => setAttempted(true)} placeholder="Name" maxLength={120} />{attempted && inviteErrors[index]?.name && <small className="field-error-copy">{inviteErrors[index].name}</small>}</label><label className={`create-field ${attempted && inviteErrors[index]?.email ? 'has-error' : ''}`}><span>EMAIL ADDRESS · REQUIRED</span><input value={invitee.email} onChange={(event) => updateInvitee(index, 'email', event.target.value)} onBlur={() => setAttempted(true)} placeholder="name@email.com" type="email" />{attempted && inviteErrors[index]?.email && <small className="field-error-copy">{inviteErrors[index].email}</small>}</label></div>
          </article>)}</div>
          {invitees.length < 4 && <button className="create-add-member" type="button" onClick={() => setInvitees((current) => [...current, emptyInvitee()])}>+ &nbsp; Add member</button>}
          <p className="create-room-copy">Room for {4 - invitees.length} more. Jamie stays Host.</p>
          <aside className="create-consent-note"><span>♢</span><div><strong>Saved, not authorized.</strong><p>Joining a group grants no payment permission. Each member must consent to each purchase and approve their own PayPal payment separately.</p></div></aside>
          {error && <p className="sandbox-notice">{error}</p>}
          <footer><button className="create-submit" type="submit" disabled={busy || (attempted && hasValidationErrors)}>{busy ? 'Creating group…' : 'Save group & contacts'} <b>→</b></button><button className="create-cancel" type="button" onClick={onBack}>Cancel</button></footer>
          {attempted && hasValidationErrors && <p className="create-submit-error">Create Group is unavailable until all errors are fixed.</p>}
        </form>
        <aside className="create-group-side"><article className="create-side-dark"><p>SAME CREW. NEXT PLAN.</p><h2>Good company. Your money, still yours.</h2><div><span className="person-avatar lime">JC</span><span className="person-avatar lavender">AC</span><span className="person-avatar sand">JE</span><span className="person-avatar blue">MP</span></div><small>Keep your people, purchase history and agreed rules together. No need to rebuild the crew for every checkout.</small></article><article className="create-side-note"><h2>A group. Not a shared wallet.</h2><p>Host manages the group and invites, not other people’s money.</p><hr /><p>Members choose their own scoped payment permissions and can revoke anytime.</p><hr /><p>Saved rules help with future splits. They never authorize arbitrary spending.</p></article></aside>
      </div>
    </section>
  </main>
}
