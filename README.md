# WHOOSH

WHOOSH coordinates a shared purchase without asking one person to front the whole amount. An organizer proposes a split, each participant explicitly consents and approves a separate PayPal Sandbox checkout, and WHOOSH reconciles the verified captures against one logical purchase.

This repository is a **hackathon prototype**. Northline Travel is a **simulated merchant**. Four independent PayPal Orders are not a native multi-payer PayPal Order, and their captures are not atomic. A verified capture does not establish that the PayPal buyer is the named group member. Do not deploy the payment or invitation routes publicly without real authentication and authorization.

## What is implemented

- A React and TypeScript checkout for the fixed Northline Montreal Weekend Escape receipt: traveler passes **US$1,136**, cabin upgrade **US$100**, and shuttle **US$48**, totaling **US$1,284**.
- Persistent groups, item-level or exact-contribution split previews, integer-cent reconciliation, spending-limit checks, organizer review, and participant-scoped consent links.
- An optional AI purchasing assistant for item assignments. The model proposes intent; the API validates group members, prices, allocations, and permissions. Exact-contribution instructions such as "Jordan pays $350. Avery pays the same. Morgan pays $284. Sam covers the rest" use a deterministic local parser and are shown as shares of the whole receipt, without inventing item usage.
- Four separate PayPal Orders v2 `CAPTURE` checkouts in Sandbox mode. Orders are linked to one WHOOSH checkout ID, use unique invoice IDs, and are verified for order, capture, amount, currency, and merchant/payee before counting as funded.
- Persisted funding state, idempotent capture reconciliation, balanced USD ledger journals, partial-funding recovery, provider-verified refunds, and reversing journals.
- One persistent **simulated** Northline booking. Full verified funding creates a durable funding-ready record; a separate confirmation operation checks all four shares before recording one booking acknowledgment.
- A read-only WHOOSH Agent on Pay & Track that answers from checkout-status tools. It cannot approve, capture, refund, or change an allocation.
- An older, separate CAD simulated-wallet and settlement sandbox. Its balances and obligations are not PayPal money.

No automated backup funding, pooled custody, real Northline reservation, or production merchant onboarding is included. A four-buyer PayPal Sandbox transaction should be treated as **unverified until run and inspected with the intended Sandbox accounts**.

## Project structure

| Path | Purpose |
| --- | --- |
| `apps/web` | React checkout, organizer dashboard, and participant views |
| `apps/api` | Express API, AI interpretation, PayPal orchestration, merchant simulator, and ledger |
| `packages/shared` | Integer-cent allocation, reconciliation, and permission rules |
| `apps/api/src/db/migrations` | Additive PostgreSQL migrations |

## Run locally

Use **Node.js 22 or 23**, npm, and PostgreSQL 17. Docker Compose supplies the development database. Keep `.env` and `.env.local` private; both are ignored by Git.

```powershell
npm install
Copy-Item .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

Set `DATABASE_URL=postgres://whoosh:whoosh@localhost:5432/whoosh` in `.env` for the included Docker database. The commands above do not reset the database or remove its volume. Open [http://localhost:5173](http://localhost:5173); the API runs at `http://localhost:3000`. The seed is idempotent and creates the Montreal Crew demo group without replacing existing groups.

The default `PAYPAL_MODE=mock` is for UI and orchestration demos and **does not capture money**. The AI purchasing assistant needs a configured model provider; the simpler item-allocation preview can use the mock interpreter when AI is not configured.

### Optional AI provider

Keep the API key server-side in `.env.local`. The configured provider must support OpenAI-compatible chat completions with structured JSON output. The Pay & Track coordinator also needs tool calling.

```text
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.meta.ai/v1
AI_MODEL=muse-ember-1.0
AI_REASONING_EFFORT=minimal
AI_API_KEY=<your server-side key>
```

Local Qwen through LM Studio remains an alternative: point `AI_BASE_URL` to `http://127.0.0.1:1234/v1`, set `AI_MODEL` to the loaded model identifier, and set the provider's local API key if required. Direct named-dollar contributions are validated locally and do not need the model. Optional ElevenLabs speech transcription uses `ELEVENLABS_API_KEY` and `VOICE_TRANSCRIPTION_ENABLED=true`; typing always remains available.

### Optional PayPal Sandbox

Use credentials from a **Sandbox Business** account only. Never use production credentials or endpoints for this prototype.

```text
PAYPAL_MODE=sandbox
PAYPAL_CLIENT_ID=<Sandbox REST app client ID>
PAYPAL_CLIENT_SECRET=<Sandbox REST app secret>
PAYPAL_MERCHANT_ID=<Sandbox Business merchant ID>
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
PAYPAL_RETURN_ORIGIN=http://localhost:5173
```

Each participant needs a separate Sandbox Personal account and should approve their own order in an isolated browser session. Invitation links are bearer links, **not proof of identity**. The server records the payer returned by PayPal and checks the expected merchant, amount, currency, and purchase identifiers, but cannot prove that a named group member owns the buyer account.

## Demo flow

1. Open the Northline checkout and select a saved group of four active members.
2. Describe who shares each receipt item, or provide four exact contributions. Preview and verify the **US$1,284.00** reconciliation.
3. Review the split and generate participant links. Every participant approves their allocation; standing permissions alone do not count as purchase consent.
4. In Sandbox mode, each participant separately opens PayPal, approves their order, and returns to WHOOSH. Pay & Track counts **verified captures only**. Never retry an uncertain charge blindly.
5. Once all four shares are verified, use **Confirm simulated booking** to demonstrate the separate Northline acknowledgment. This is not a real reservation.
6. If a checkout is partially funded and must be cancelled, use the recovery controls. A share is shown as refunded only after provider verification.

The AI assistant may prepare a proposal and hand it to the same human-approved checkout; it never charges a buyer. The Pay & Track Agent is read-only and derives payment facts from persisted WHOOSH records.

## Checks

```powershell
npm run typecheck
npm test
npx vitest run apps/web/src
npm run lint --workspace=@whoosh/web
npm run build
```

Database-backed tests require the **separate `whoosh_test` database** and `WHOOSH_DB_INTEGRATION=1`. They verify the target database name before creating test fixtures. Do not point them at the development `whoosh` database.

## Security and status

This prototype lacks authenticated organizer and participant accounts. Browser-supplied member IDs, contact emails, and bearer invitation links are not identity credentials. Do not expose payment, approval, refund, or status routes to untrusted users. The local Northline adapter, booking acknowledgment, saved permissions, and older CAD wallet are simulations; only provider-verified Sandbox captures and refunds represent Sandbox payment results. Production use would require real authentication, merchant integration, operational monitoring, and a separately reviewed payment design.
