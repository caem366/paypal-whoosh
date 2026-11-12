import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'

export interface VoiceTranscriptionInput {
  audio: Buffer
  mimeType: string
}

export interface VoiceTranscriptionResult {
  transcript: string
  model: string
}

export interface VoiceTranscriber {
  readonly isConfigured: boolean
  transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult>
}

export class VoiceTranscriptionError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = 'VoiceTranscriptionError'
  }
}

type VoiceEnvironment = {
  ELEVENLABS_API_KEY?: string
  ELEVENLABS_STT_MODEL?: string
}

/**
 * Speech is only an input convenience. The returned text is subsequently
 * interpreted as non-authoritative allocation intent; this integration never
 * calculates money, permissions, or payment state.
 */
export function createVoiceTranscriber(environment: VoiceEnvironment = process.env): VoiceTranscriber {
  const apiKey = environment.ELEVENLABS_API_KEY?.trim()
  const model = environment.ELEVENLABS_STT_MODEL?.trim() || 'scribe_v2'

  if (!apiKey) {
    return {
      isConfigured: false,
      async transcribe() {
        throw new VoiceTranscriptionError(
          'Voice transcription is not configured. Add ELEVENLABS_API_KEY on the API server, or type your instruction instead.',
          503,
        )
      },
    }
  }

  const client = new ElevenLabsClient({ apiKey })

  return {
    isConfigured: true,
    async transcribe({ audio, mimeType }) {
      if (audio.byteLength === 0) {
        throw new VoiceTranscriptionError('No audio was received.', 400)
      }

      try {
        // Copy Node's Buffer into a DOM-compatible typed array before giving it
        // to the SDK's multipart uploader.
        const audioBytes = new Uint8Array(audio.byteLength)
        audioBytes.set(audio)
        const response = await client.speechToText.convert({
          file: new Blob([audioBytes], { type: mimeType }),
          modelId: model,
          languageCode: 'eng',
          tagAudioEvents: false,
          diarize: false,
        })

        if (!('text' in response) || !response.text.trim()) {
          throw new VoiceTranscriptionError('ElevenLabs did not return a transcript.', 502)
        }

        return { transcript: response.text.trim(), model }
      } catch (error) {
        if (error instanceof VoiceTranscriptionError) throw error
        throw new VoiceTranscriptionError('Voice transcription could not be completed. You can type your instruction instead.', 502)
      }
    },
  }
}
