import { WhooshLogo } from '../components/WhooshLogo'
import { useRef, useState } from 'react'

import { transcribeVoice, type AllocationPreviewResponse, type PersistentGroupDetail } from '../api/whoosh'
import { formatUsd, type NorthlineCart } from '../demo/northline'
import { SplitPreview } from './AllocationPreview'
import { CheckoutPhases } from '../components/CheckoutPhases'

interface CreateGroupSplitProps {
  onBack: () => void
  onChangeGroup: () => void
  onPreview: (transcript: string) => void
  onConfirmSplit?: () => void
  onTranscriptChange?: (transcript: string) => void
  initialTranscript?: string
  onReceipt: () => void
  cart: NorthlineCart
  group?: PersistentGroupDetail
  allocation?: AllocationPreviewResponse
  error?: string
  busy?: boolean
}

const initials = (name: string) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
const sampleInstruction = "Maya isn't taking the shuttle. Alex and I are covering the upgrade. Split everything else."
const defaultInstruction = (group?: PersistentGroupDetail) => {
  const names = group?.members.filter((member) => member.status === 'active').map((member) => member.name.toLowerCase()) ?? []
  return names.length === 4 && ['jamie cooper', 'alex chen', 'jordan ellis', 'maya patel'].every((name) => names.includes(name)) ? sampleInstruction : ''
}

export function CreateGroupSplit({ onBack, onChangeGroup, onPreview, onConfirmSplit, onReceipt, onTranscriptChange, initialTranscript, cart, group, allocation, error, busy = false }: CreateGroupSplitProps) {
  const [transcript, setTranscript] = useState(() => initialTranscript ?? defaultInstruction(group))
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const updateTranscript = (value: string) => {
    setTranscript(value)
    onTranscriptChange?.(value)
    if (value.trim()) setTranscriptError(null)
  }

  const stopMicrophone = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  const toggleRecording = async () => {
    setVoiceError(null)
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
      return
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceError('Voice input is not supported in this browser. Type your instruction instead.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const preferredMimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((mimeType) => MediaRecorder.isTypeSupported(mimeType))
      const recorder = preferredMimeType ? new MediaRecorder(stream, { mimeType: preferredMimeType }) : new MediaRecorder(stream)
      const chunks: BlobPart[] = []
      streamRef.current = stream
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.onstop = async () => {
        setIsRecording(false)
        stopMicrophone()
        const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        if (audio.size === 0) {
          setVoiceError('No audio was captured. Please try again or type your instruction.')
          return
        }
        try {
          setIsTranscribing(true)
          const result = await transcribeVoice(audio)
          updateTranscript(result.transcript)
        } catch (error) {
          setVoiceError(error instanceof Error ? error.message : 'Voice transcription failed. Type your instruction instead.')
        } finally {
          setIsTranscribing(false)
          recorderRef.current = null
        }
      }
      recorder.start()
      setIsRecording(true)
    } catch {
      stopMicrophone()
      setVoiceError('Microphone access was not granted. Type your instruction instead.')
    }
  }

  return <main className="split-page instructions-page">
    <header className="merchant-header">
      <button className="whoosh-brand brand-button" type="button" onClick={onBack}><WhooshLogo /></button>
      <p className="brand-tagline">Split now. Not later.</p><div className="group-profile"><strong>Your groups</strong><span>YC</span></div>
    </header>
    <div className="checkout-utility"><button className="text-button" type="button" onClick={onBack}>← <span>Back to checkout</span></button><p>SPLIT</p><button className="close-button" type="button" aria-label="Close group split" onClick={onBack}>×</button></div>
    <CheckoutPhases current="split" />
    <div className="split-layout"><section className="split-main" aria-labelledby="split-heading">
      <p className="trip-kicker">{group ? `${group.group.name.toUpperCase()} · ${group.members.filter((member) => member.status === 'active').length} PEOPLE` : 'LOADING SAVED GROUP'}</p><h1 id="split-heading">Your trip. Your split.</h1><p className="trip-subtitle">Assign receipt items or name each person's total contribution.</p>
      <div className="whoosh-handoff"><WhooshLogo iconOnly size={26} /><p><strong>Northline cart synced</strong><small>{cart.product} · {cart.travelers} travelers · {formatUsd(cart.totalCents)} USD</small></p></div>
      <article className="crew-card"><header><h2>{group?.group.name ?? 'Loading group…'}</h2><button type="button" onClick={onChangeGroup}>Change group</button></header><div className="crew-members">{group?.members.filter((person) => person.status === 'active').map((person, index) => <div className="crew-member" key={person.id}><span className={`person-avatar ${['lime', 'lavender', 'sand', 'blue'][index % 4]}`}>{initials(person.name)}</span><strong>{person.role === 'host' ? `${person.name} · organizer` : person.name}</strong><small>{group.permissions.some((permission) => permission.memberId === person.id && permission.status === 'active' && (!permission.expiresAt || new Date(permission.expiresAt) > new Date())) ? 'Standing permission connected' : 'Standing permission needed'}</small></div>)}</div></article>
      <article className="voice-card"><header><strong>VOICE TRANSCRIPT</strong><button className={`voice-record-button${isRecording ? ' recording' : ''}`} type="button" onClick={() => void toggleRecording()} aria-label={isRecording ? 'Stop recording' : 'Record instruction'}>{isRecording ? '■ Stop recording' : '◉ Speak'}</button></header><textarea aria-label="Allocation instruction" aria-describedby={!transcript.trim() ? 'transcript-validation' : undefined} placeholder="Describe item shares, or say: Jordan pays $350. Avery pays the same. Morgan pays $284. Sam covers the rest." value={transcript} onChange={(event) => updateTranscript(event.target.value)} />{!transcript.trim() && <p className="voice-error" id="transcript-validation" role="alert">{transcriptError ?? 'Enter an instruction before previewing the split.'}</p>}<footer><span className="voice-wave" aria-hidden="true">{isRecording ? '● ● ● listening' : isTranscribing ? 'Transcribing with ElevenLabs…' : '▂▆▃█▅▇▃▆▂'}</span></footer>{voiceError && <p className="voice-error" role="alert">{voiceError}</p>}</article>
      <p className="instructions-hint">Use this group’s names. Standing permissions are not required to preview; each participant must still consent before payment.</p>
      {error && <p className="sandbox-notice" role="alert">{error}</p>}
      <div className="split-actions"><button className="preview-button" type="button" disabled={!group || !transcript.trim() || isTranscribing || busy} onClick={() => { if (!transcript.trim()) { setTranscriptError('Enter an instruction before previewing the split.'); return } onPreview(transcript) }}>{busy ? 'Previewing the split…' : 'Preview the split'} <span>→</span></button><button className="manual-button" type="button" onClick={onReceipt}>Split manually</button></div>
      {allocation && <SplitPreview allocation={allocation} group={group} cart={cart} onContinue={() => onConfirmSplit?.()} />}
    </section><aside className="split-summary"><p>NORTHLINE TRAVEL · USD</p><h2>A long weekend. Four good friends.</h2><span>{cart.product} · {cart.dates}</span><div className="summary-items">{cart.items.map((item) => <div key={item.id}><span>{item.label}</span><strong>{formatUsd(item.cents)}</strong></div>)}</div><div className="summary-total"><p>TOTAL TO MERCHANT</p><strong>{formatUsd(cart.totalCents)}</strong><span>Taxes included · no WHOOSH fee</span></div><div className="summary-difference"><span>Receipt item difference</span><strong>$0.00</strong></div><p className="summary-footnote">Each person funds their own share. No one fronts the group total.</p></aside></div>
    <p className="paypal-assurance">♙ &nbsp; Secure payments with PayPal</p><footer className="merchant-footer"><span>MONTRÉAL / WSH–1023 · ALL AMOUNTS USD</span><span>Need a hand? Get help</span></footer>
  </main>
}
