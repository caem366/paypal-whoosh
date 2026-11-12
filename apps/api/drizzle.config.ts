import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { defineConfig } from 'drizzle-kit'

const apiDirectory = dirname(fileURLToPath(import.meta.url))
// npm workspaces run this config from apps/api, while the documented .env
// belongs at the monorepo root. Load that location explicitly.
config({ path: resolve(apiDirectory, '../../.env.local') })
config({ path: resolve(apiDirectory, '../../.env') })

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set to generate or apply migrations')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url: databaseUrl },
})
