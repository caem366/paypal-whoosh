import { describe, expect, it } from 'vitest'

import { createVoiceTranscriber } from './elevenlabs.js'

describe('ElevenLabs voice transcriber', () => {
  it('keeps typed allocation available when the server key is absent', async () => {
    const transcriber = createVoiceTranscriber({})

    expect(transcriber.isConfigured).toBe(false)
    await expect(transcriber.transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/webm' }))
      .rejects.toMatchObject({ statusCode: 503 })
  })
})
