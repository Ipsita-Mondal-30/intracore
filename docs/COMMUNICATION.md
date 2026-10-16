# Communication centre and integrations

Provider-neutral messaging (email, SMS, WhatsApp Business) with templates, consent, delivery
tracking and an integration framework. API reference: [docs/api/communication-integrations.md](api/communication-integrations.md).

## Flow

1. `queueMessage(db, {...})` (`src/features/communication/send.ts`) renders an active template,
   normalizes the address, checks consent and writes a `CommunicationLog`:
   `QUEUED` (and a `communication.deliver` background job) or `BLOCKED` with the reason.
   The same `idempotencyKey` returns the existing log. Used by `POST /communications` and campaigns.
2. The queue (`src/lib/queue.ts`) runs `deliverMessage` (`deliver.ts`), which picks the org's
   **enabled integration for the channel** and calls its provider.
3. Provider status webhooks (WhatsApp) move the log forward: `SENT → DELIVERED → READ`, or `FAILED`.

Log statuses: `QUEUED, SENT, DELIVERED, READ, FAILED, BLOCKED` (outbound), `RECEIVED` (inbound).

## Delivery and errors

| Situation | Result |
|---|---|
| No enabled integration for the channel | Log `FAILED` with `NOT_CONFIGURED: …`; the job **succeeds** (no retry loop) |
| Permanent provider error (HTTP 4xx except 408/429, missing template name/variable) | Log `FAILED` with the sanitized error; job succeeds, no retry |
| Transient error (timeout 10 s, network, 5xx, 429) | Error recorded on the log, the handler throws → the queue retries with backoff (1, 2, 4 … min). On the last attempt the log becomes `FAILED` ("Retries exhausted") and the job `DEAD` |
| Replay of a DEAD delivery job (`job.replay`) | Job → `PENDING`, the log → `QUEUED`, delivered on the next queue run |
| Log not `QUEUED` when the job runs | No-op (idempotent) |

All stored errors go through `sanitizeError` (tokens, API keys, `Authorization` values are redacted).
Access tokens are only ever placed in the outgoing `Authorization` header — never in URLs, logs,
API responses or the browser.

Resend receives the log id as `Idempotency-Key`, so a crash between sending and recording never
sends an email twice. The WhatsApp Cloud API has no idempotency key: a crash in that window can
re-send once on retry.

## Providers

| Key | Channel | State |
|---|---|---|
| `mock_email`, `mock_sms`, `mock_whatsapp` | each | **Mock.** Contacts nothing. Logs are `simulated: true` and stop at `SENT` (never `DELIVERED`). Shown as "Simulated" in every list and detail view |
| `whatsapp_cloud` | WhatsApp | **Real, not yet exercised against the live API** (covered by tests with a mocked `fetch`). Template messages only |
| `email_resend` | Email | **Real, not yet exercised against the live API** (mocked `fetch` in tests). Uses the integration's API key and from address; when those are empty, the platform `RESEND_API_KEY` / `RESEND_FROM_EMAIL` |
| SMS | SMS | **Scaffolded:** interface plus `mock_sms` only. Add a provider in `src/features/communication/providers/` and `src/features/integrations/registry.ts` |

One provider is enabled per channel. Enabling one disables the others for that channel.
`ERROR` means the integration is enabled but its last health check failed; deliveries are still attempted.

Adding a provider: define its fields in `registry.ts` (allowlist), implement `MessageProvider`
(`send`, `healthCheck`) using `providerFetch` (timeout + error classification), and register it in
`providers/index.ts`.

## Consent rules

Consent is stored per (channel, normalized address, purpose). Email addresses are lower-cased.
Phone numbers are stored as digits with the country code.

- An explicit `OPTED_OUT` for the purpose always blocks.
- `MARKETING` needs an explicit `OPTED_IN` on that channel. A template's category decides the
  purpose, and a marketing template is always marketing.
- WhatsApp needs an explicit `OPTED_IN` for every business-initiated message, transactional
  included (platform policy).
- Transactional email and SMS are allowed unless the contact opted out.
- An inbound WhatsApp text of `STOP` or `UNSUBSCRIBE` (any case, trimmed) opts the sender out of
  both `MARKETING` and `TRANSACTIONAL` on WhatsApp (`source: whatsapp_stop`). Re-subscribing is a
  manual consent change.

Blocked messages are still logged (`BLOCKED`, `error: NO_CONSENT | OPTED_OUT | INVALID_ADDRESS`) so
audiences can be reported on. One-off sends (`POST /communications`) are transactional only;
marketing goes through campaigns.

## Templates

`{{variable}}` placeholders must all be declared in `variables`. Email templates need a subject.
WhatsApp templates need `providerTemplateName`, the name of a template **approved in Meta Business
Manager**, and its language code, for example `en_US`. Meta sends its approved text, not ours.
Our `variables` are sent as the template's body parameters **in declared order**: the first declared
variable fills `{{1}}`. Keep the `body` here as a readable copy for the log. Templates are deactivated,
never deleted.

## Integration security

- Secrets are AES-256-GCM encrypted (`ENCRYPTION_KEY`) as one JSON blob in `Integration.secrets`.
  The API returns only `secretsConfigured: { field: true|false }`. Settings forms use write-only
  password fields, and leaving one blank keeps the saved value.
- Configuration changes are audited with the changed secret **field names** only.
- Health checks use a 10 s timeout. They record `lastCheckedAt` and a sanitized `lastError`.
- The legacy lead webhook (`/api/integrations/:provider/webhook`, secret in `credentialsRef`) is unchanged.

## WhatsApp Business setup

1. In Meta for Developers, create an app with the WhatsApp product and add a phone number.
   Create a **system user** with a permanent access token that has `whatsapp_business_messaging`
   (and `whatsapp_business_management`).
2. In **Settings → Integrations → WhatsApp Business (Cloud API)**, enter:
   - the phone number ID and, optionally, the WhatsApp Business account ID and Graph API version
     (default `v21.0`);
   - the access token;
   - the **app secret** (App settings → Basic);
   - a **verify token**, which can be any long random string.

   Save the settings.
3. The card now shows the **webhook callback URL**:
   `<NEXT_PUBLIC_SITE_URL>/api/webhooks/whatsapp/<integrationId>`. In the Meta app, open
   WhatsApp → Configuration → Webhook, paste that URL and the same verify token, verify it, and
   subscribe to the `messages` field.
4. Click **Test connection**, then **Enable**. Enabling WhatsApp disables `mock_whatsapp`.
5. Create the message templates in Meta. Mirror each one under Communication → Templates with the
   same name, language and variable order.
6. Record WhatsApp opt-ins (Communication → Consent) before sending.

Webhook handling: `GET` verification compares the verify token in constant time. `POST` requires
`X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret), or the request gets a 401.
Events for a different phone number ID are ignored. Each status is stored once as
`WebhookEvent(externalId = "<wamid>:<status>")` and each inbound message as its message id, so
redeliveries are no-ops. Processing runs on the queue. Statuses only move forward, so a late
`delivered` after `read` is `IGNORED`. A status for a message not recorded yet is retried, then
`IGNORED` after 3 attempts. Failed events can be replayed from **Settings → Jobs & webhooks**.

## Operations

- The queue runs as the `background-queue` job (`/api/v1/jobs/run`, cron).
- **Settings → Jobs & webhooks** lists DEAD jobs and FAILED webhook events for the organization, with
  **Replay** (`job.replay`), plus scheduler run history (name, status and timing only; scheduler runs
  are platform-wide).
