# Notifications, reminders, documents and e-signatures API

All endpoints are under `/api/v1`. Responses use the shared shape described in `docs/API.md`:
`{ ok: true, data }` or `{ ok: false, error, code, details? }`. Lists accept `page`, `pageSize`, `sort`,
`dir` and `q`. Timestamps are ISO-8601 instants.

## Reminders — any member

| Method | Path | Notes |
|---|---|---|
| GET | `/reminders` | Your reminders (for you or created by you). With `task.view_all` you see the whole organization's. Filters: `active=true\|false`, `userId`. Sort by `nextRunAt` (default), `createdAt` or `title`. |
| POST (idem) | `/reminders` | `{ title, body?, nextRunAt, recurrence?: NONE\|DAILY\|WEEKLY\|MONTHLY, interval?: 1–365, endsAt?, userId?, entityType?, entityId? }` |
| GET / PATCH / DELETE | `/reminders/:id` | PATCH takes `title, body, nextRunAt, recurrence, interval, endsAt, isActive`. |

Rules:
- `userId` defaults to you. A reminder for someone else needs `task.view_all` (otherwise `403`), and that person must be an active member (otherwise `422 INVALID_REFERENCE`).
- `entityType`/`entityId` go together. The record must be visible to you, using the same rules as tasks and documents.
- `endsAt` cannot be earlier than `nextRunAt` (`422`).
- A reminder you cannot see returns `404`, the same as a reminder in another tenant.

**Job `reminders`** (`processReminders`) handles every due reminder:
1. It sends an in-app notification of type `reminder` with the `reminders` preference key and dedupe key `reminder:<id>:<occurrence ISO>`.
2. It claims the reminder with a conditional update on the unchanged `nextRunAt`.
3. It moves `nextRunAt` to the first occurrence after now. A one-off reminder, or one whose next occurrence falls after `endsAt`, is deactivated instead.

Guarantees:
- Overlapping runs notify once.
- A crash between sending and claiming repeats only the deduplicated send.
- Occurrences missed while the scheduler was down fire **once**, not once each.
- Recurrence steps in UTC.
- Monthly reminders clamp to the end of the month: Jan 31 + 1 month is Feb 28 (or Feb 29 in a leap year). From then on the reminder stays on the clamped day.
- If the recipient has turned off the `reminders` preference, no notification is sent, but the schedule still advances.

## Notification history and preferences — your own

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | Filters: `unread=true\|false`, `type`, `from`, `to` (inclusive; a bare `YYYY-MM-DD` covers the whole UTC day), `q` (title/body). Sorted by `createdAt`. The response adds `unread`, your total unread count. |
| POST | `/notifications/:id/read` | Marks one notification read. Another user's notification returns `404`. |
| POST | `/notifications/read-all` | `{ type? }`. Returns `{ count }`. |
| GET | `/notification-preferences` | `chatMessages, leadAssignments, followUpReminders, taskNotifications, systemNotifications, approvalRequests, reminders, browserNotifications` |
| PATCH | `/notification-preferences` | Any subset of the keys above, as booleans. Unknown keys return `422`. |

Senders pass a `preferenceKey` to `createSystemNotification`. A disabled key means no notification is created. A `dedupeKey` is unique per org and user, so a retried or overlapping sender never notifies twice.

## Documents — `document.view` / `document.create` / `document.delete`

| Method | Path | Notes |
|---|---|---|
| GET | `/documents?entityType=&entityId=` | Latest version of each document. Add `allVersions=true` to include superseded versions. |
| POST | `/documents` | multipart: `entityType`, `entityId`, `file` |
| GET | `/documents/:id` | `{ document, signedUrl, expiresAt }`. The signed URL is valid for 5 minutes. |
| GET | `/documents/:id/versions` | `{ items, can }`. Every version, newest first, each with its signature requests (simulated ones carry `notice`). `can` holds `createVersion`, `requestSignature` and `delete`. |
| POST | `/documents/:id/versions` | multipart: `file`. Adds the next version of the same document, on the same record. |
| DELETE | `/documents/:id` | Deletes the whole document, every version included. |

Rules:
- Access to a document follows access to its record. A document on a record you cannot see returns `404`.
- Each file must be 1 byte to 20MB.
- The declared type must be one of pdf, png, jpeg, webp, gif, doc/xls, docx/xlsx, csv or txt.
- The content must match the declared type: magic bytes for binary types, and NUL-free UTF-8 for csv/txt. A mismatch returns `422 INVALID_FILE`.
- Every upload stores the SHA-256 of its bytes in `checksum`.
- Each document has a version group (`versionGroupId`, the first version's id).
- Version numbers are gapless. They are assigned under a row lock on the group, and `(versionGroupId, version)` is unique. Adding a version sets `supersededAt` on the previous latest version.
- Delete returns `422 SIGNED_DOCUMENT` once any version has a SIGNED signature request.
- Delete returns `422 SIGNATURE_PENDING` while a request is SENT or VIEWED.

## Signature requests — `signature.view` / `signature.request`

| Method | Path | Notes |
|---|---|---|
| GET | `/signature-requests?documentId=` | Requests for one document. |
| POST (idem) | `/signature-requests` | `{ documentId, signers: [{ name, email }] }` (1–10 signers, distinct emails). Creates a DRAFT. |
| GET | `/signature-requests/:id` | |
| POST | `/signature-requests/:id/send` | DRAFT → SENT through the provider. A provider failure sets the request to FAILED and returns `502 PROVIDER_ERROR`. |
| POST | `/signature-requests/:id/void` | Voids a DRAFT, SENT or VIEWED request, at the provider too. |
| POST | `/signature-requests/:id/refresh` | Polls the provider for the current status. |

Requirements and errors:
- The document must be a PDF and its latest version (`422`).
- A document can have only one open request at a time (`409`).
- With no enabled provider, the endpoints return `409 NOT_CONFIGURED`.

**No endpoint marks a request SIGNED.** Status changes come only from the provider, either through a verified webhook or `refresh`. On SIGNED:
- The provider's evidence is stored on the request.
- `Document.signatureStatus` becomes `SIGNED`.
- If the provider returns a signed file, that file becomes the next document version, and the request's `signedDocumentId` points to it.

Requests handled by the mock provider have `simulated: true` and `notice: "Simulated – not a legal signature"`. See [ESIGNATURE.md](../ESIGNATURE.md).

## Webhook — `POST /api/webhooks/esign/:provider` (no session)

The provider signs `"${timestamp}.${rawBody}"` with HMAC-SHA256, using the `webhookSecret` in the org's encrypted `Integration.secrets`. It sends the result in two headers:
- `x-esign-timestamp`: the time in unix ms. A delivery more than 5 minutes off is rejected.
- `x-esign-signature`: `sha256=<hex>`

The mock provider's body is `{ eventId, requestId, status, evidence? }`.

| Response | When |
|---|---|
| `401 { ok:false, error:"Unauthorized" }` | Unknown provider, unknown envelope, disabled integration, bad signature or stale timestamp. The response is identical in every case. |
| `200 { ok:true, data:{ duplicate:false, status } }` | Processed. `status` is PROCESSED, or IGNORED for out-of-order or replayed transitions. |
| `200 { ok:true, data:{ duplicate:true } }` | The event id was already received. It is not reprocessed. |
| `500` | Processing failed. The event is stored as FAILED and the next delivery retries it. |

## Jobs

Register in `src/lib/jobs.ts`: `"reminders": () => processReminders()`.
