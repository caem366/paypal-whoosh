import { Router } from 'express'

import { createVoiceTranscriber, VoiceTranscriptionError } from './elevenlabs.js'

const MAX_AUDIO_BYTES = 16 * 1024 * 1024

export const voiceRouter = Router()

voiceRouter.post('/transcriptions', async (request, response, next) => {
  try {
    if (process.env.VOICE_TRANSCRIPTION_ENABLED !== 'true') {
      return response.status(503).json({ error: 'Voice transcription is disabled. Type your instruction instead.' })
    }
    const transcriber = createVoiceTranscriber()
    if (!transcriber.isConfigured) {
      return response.status(503).json({
        error: 'Voice transcription is not configured. Add ELEVENLABS_API_KEY on the API server, or type your instruction instead.',
      })
    }

    const mimeType = request.header('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (!mimeType?.startsWith('audio/')) {
      return response.status(415).json({ error: 'Send an audio recording with an audio/* Content-Type.' })
    }
    if (!Buffer.isBuffer(request.body)) {
      return response.status(400).json({ error: 'No audio recording was received.' })
    }
    if (request.body.byteLength > MAX_AUDIO_BYTES) {
      return response.status(413).json({ error: 'Audio recording is too large. Keep it under 16 MB.' })
    }

    const result = await transcriber.transcribe({ audio: request.body, mimeType })
    return response.status(200).json(result)
  } catch (error) {
    if (error instanceof VoiceTranscriptionError) {
      return response.status(error.statusCode).json({ error: error.message })
    }
    return next(error)
  }
})
