import { config } from 'dotenv'
import { resolve } from 'node:path'

import { z } from 'zod'

// npm workspaces use apps/api as cwd; the deployment bundle uses the repo root.
for (const path of ['.env.local', '.env', '../../.env.local', '../../.env']) config({ path: resolve(process.cwd(), path) })

const optionalText = z.preprocess((value) => value === '' ? undefined : value, z.string().optional())
const optionalPort = z.preprocess((value) => value === '' ? undefined : value, z.coerce.number().int().positive().optional())

const environmentSchema = z.object({
  CORS_ORIGIN: z.preprocess((value) => value === '' ? undefined : value, z.url().default('http://localhost:5173')),
  DEMO_PARTICIPANT_APPROVAL_LINKS: z.enum(['enabled', 'disabled']).default(process.env.NODE_ENV === 'production' ? 'disabled' : 'enabled'),
  // Unit tests exercise pure planning services and never connect. Production
  // still requires a real DATABASE_URL because this fallback is test-only.
  DATABASE_URL: z.string().min(1).default(
    process.env.NODE_ENV === 'test'
      ? 'postgres://whoosh_test:whoosh_test@localhost:5432/whoosh_test'
      : '',
  ),
  PORT: optionalPort.default(3000),
  // Server-only optional speech-to-text integration. The browser never sees
  // this secret and can fall back to typed instructions when it is absent.
  ELEVENLABS_API_KEY: optionalText.transform((value) => value?.trim()),
  ELEVENLABS_STT_MODEL: z.string().trim().default('scribe_v2'),
})

export const environment = environmentSchema.parse(process.env)
