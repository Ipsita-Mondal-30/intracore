# Communication and integrations API (Phase 6)

Endpoints under `/api/v1` unless noted. Conventions (envelope, errors, list parameters `page`,
`pageSize`, `sort`, `dir`, `q`, `Idempotency-Key`) are in [docs/API.md](../API.md). Rules, providers
and WhatsApp setup are in [docs/COMMUNICATION.md](../COMMUNICATION.md).
All rows are organization-scoped; another tenant's id answers **404**. "(idem)" = honours `Idempotency-Key`.

## Templates — `src/features/communication/templates.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/message-templates` | `communication.view` | Filters `channel`, `category` (TRANSACTIONAL\|MARKETING), `active=true\|false`, `q` (name, provider name). Sort `name, createdAt, channel, updatedAt` |
| POST (idem) | `/message-templates` | `communication.administer` | `{ channel, name, language="en", category="TRANSACTIONAL", subject?, body, variables: string[] \| "a, b", providerTemplateName?, isActive=true }` → 201. 422 `TEMPLATE_INVALID` when a `{{placeholder}}` is undeclared, an EMAIL template has no subject, or a WHATSAPP template has no `providerTemplateName`. Unique per (channel, name, language) → 409 |
| GET | `/message-templates/:id` | `communication.view` | |
| PATCH | `/message-templates/:id` | `communication.administer` | Any create field except `channel`; the merged result is re-validated. No DELETE: set `isActive=false` (inactive templates can't be sent → 422) |

## Consent — `src/features/communication/consent.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/consents` | `consent.view` | Filters `channel, purpose, status (OPTED_IN\|OPTED_OUT)`, `q` (address). Sort `updatedAt, recordedAt, address` |
| POST (idem) | `/consents` | `consent.manage` | `{ channel, address, purpose: TRANSACTIONAL\|MARKETING, status: OPTED_IN\|OPTED_OUT, source? }` — upsert on (channel, normalized address, purpose). Invalid address → 422 |
| GET | `/consents/:id` | `consent.view` | |
| PATCH | `/consents/:id` | `consent.manage` | `{ status, source? }` |
| POST (idem) | `/consents/opt-out` | `consent.manage` | `{ channel, address, purposes? = [TRANSACTIONAL, MARKETING], source? }` → the OPTED_OUT rows |

Every change is audited (`consent.recorded`) with who recorded it.

## Messages — `src/features/communication/messages.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/communications` | `communication.view` | Filters `channel, direction (INBOUND\|OUTBOUND), status (QUEUED\|SENT\|DELIVERED\|READ\|FAILED\|BLOCKED\|RECEIVED), simulated=true\|false, campaignId, entityType, entityId`, `q` (to/from/subject). Sort `createdAt, sentAt, status, channel`. `simulated: true` = handled by a mock provider, never sent |
| GET | `/communications/:id` | `communication.view` | Includes the template name |
| POST | `/communications` | `communication.send` | **`Idempotency-Key` header required** (400 `IDEMPOTENCY_KEY_REQUIRED`). `{ channel, to, templateId, variables?: { name: value }, entityType?, entityId? }` → 202 with the log. Transactional only: MARKETING templates → 422 `TEMPLATE_CATEGORY` (use campaigns). Missing variable → 422. Without consent the log is returned with `status: BLOCKED` and `error: NO_CONSENT\|OPTED_OUT\|INVALID_ADDRESS` (nothing is sent). The same key replays the same log |

## Integrations — `src/features/integrations/service.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/integrations` | `integration.view` | Every allowlisted provider with `{ id, provider, label, channel, mock, status, enabled, config, secretsConfigured: { field: bool }, lastCheckedAt, lastError, webhookPath, fields }`. **Secret values are never returned** |
| GET | `/integrations/:provider` | `integration.view` | Unknown provider → 404 |
| PUT | `/integrations/:provider` | `integration.manage` | `{ config: {...}, secrets: {...} }`. Config is replaced; secrets are merged (omitted/blank keep the stored value) and stored AES-GCM encrypted. Required fields missing → 422. Audited without secret values |
| POST | `/integrations/:provider/connect` | `integration.connect` | Enable. 422 `NOT_CONFIGURED` when required settings are missing. Disables the other provider of the same channel |
| POST | `/integrations/:provider/disconnect` | `integration.disconnect` | Disable |
| POST | `/integrations/:provider/check` | `integration.manage` | Health check (10 s timeout) → `{ ok, error, integration }`; records `lastCheckedAt`, sanitized `lastError`; an enabled integration becomes `ERROR`/`CONNECTED` |

Providers: `whatsapp_cloud`, `email_resend`, `mock_email`, `mock_sms`, `mock_whatsapp`.

## Jobs and webhooks — `src/features/integrations/jobs.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/background-jobs` | `job.view` | Caller's org only. Filters `status (PENDING\|RUNNING\|SUCCEEDED\|DEAD\|CANCELLED)`, `type`. Sort `updatedAt, createdAt, runAt`. Payloads are not listed |
| GET | `/background-jobs/:id` | `job.view` | Adds `result` |
| POST (idem) | `/background-jobs/:id/replay` | `job.replay` | DEAD → PENDING, `attempts=0`, `runAt=now`; other states → 422 `INVALID_STATE`. For `communication.deliver` the FAILED message goes back to QUEUED. Audited |
| GET | `/webhook-events` | `job.view` | Caller's org only. Filters `status (RECEIVED\|PROCESSED\|IGNORED\|FAILED)`, `provider`. Sort `receivedAt, processedAt`. Payloads are not listed |
| POST (idem) | `/webhook-events/:id/replay` | `job.replay` | FAILED → RECEIVED and a new `webhook.process` job. Audited |
| GET | `/job-runs` | `job.view` | Scheduler history (platform-wide): `name, status, startedAt, finishedAt` only — no result or error text. Filters `name, status` |

## Public webhook (no session)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/webhooks/whatsapp/:integrationId` | `hub.verify_token` | `hub.mode=subscribe` and the token equal to the integration's verify token → `hub.challenge` as `text/plain`; otherwise 403 |
| POST | `/api/webhooks/whatsapp/:integrationId` | `X-Hub-Signature-256` | `sha256=` HMAC-SHA256 of the raw body with the app secret, else 401 (also for unknown ids). Each status (`<wamid>:<status>`) and inbound message (`<message id>`) is stored once as a `WebhookEvent`; duplicates are no-ops. Processing is queued (`webhook.process`), the response is an immediate 200 |
