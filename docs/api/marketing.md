## Marketing: segments, campaigns, feedback, loyalty (Phase 6)

All endpoints are under `/api/v1` with the shared `{ ok, data }` / `{ ok: false, error, code, details? }`
shape. "(idem)" endpoints honour `Idempotency-Key`. Lists take `page, pageSize, sort, dir, q`.
Timestamps are ISO-8601; money values are decimal strings. Rules and lifecycle: `docs/MARKETING.md`.

Services: `src/features/marketing/{segments,campaigns,dispatch,feedback,loyalty}.ts`.

### Segments

| Method | Path | Access | Notes |
|---|---|---|---|
| GET / POST (idem) | `/segments` | `campaign.view` / `campaign.manage` | Filter `entity`. POST `{ name, entity: CUSTOMER\|CONTACT\|LEAD, filters: [{ field, op, value }] }`; name unique per org (409). Unknown field/op/value → 422 `VALIDATION_ERROR` with `details[].path = "filters.N"` |
| GET / PATCH / DELETE | `/segments/:id` | view / manage / manage | PATCH any create field; 422 `SEGMENT_IN_USE` while a campaign using it is PENDING_APPROVAL/APPROVED/SENDING. DELETE → 422 `SEGMENT_IN_USE` when any campaign uses it |
| POST | `/segments/preview` | `campaign.view` + `customer.view` / `contact.view` / `lead.view` for the entity | `{ segmentId }` or `{ entity, filters }`, plus `{ channel: EMAIL\|SMS\|WHATSAPP, purpose?: MARKETING (default)\|TRANSACTIONAL }` → `{ total, withAddress, unique, eligible, blocked: { NO_CONSENT, OPTED_OUT, INVALID_ADDRESS }, sample[20]: { name, address, status } }`. Lead previews include only leads the caller can see |

Filter allowlist (`op` per field type):

| Entity | Fields |
|---|---|
| CUSTOMER | `type` (BUSINESS/INDIVIDUAL), `status`, `stateCode`, `name`, `ownerUserId`, `createdAt` |
| CONTACT (customer contacts only) | `status`, `isPrimary`, `jobTitle`, `createdAt`, and `customer.<any customer field>` |
| LEAD (non-archived) | `status`, `priority`, `sourceId`, `stageId`, `assignedUserId`, `city`, `state`, `industry`, `createdAt` |

| Type | Ops | Value |
|---|---|---|
| enum | `eq, neq, in, not_in` | one of the enum values (list for `in`/`not_in`) |
| id | `eq, neq, in, not_in, is_set, not_set` | string / list / none |
| string | `eq, neq, contains, in, is_set, not_set` | case-insensitive for `eq`, `neq`, `contains` |
| date | `gte, lte` | ISO date or timestamp |
| boolean | `eq` | `true` / `false` |

At most 20 filters, all combined with AND; lists hold 1–100 values.

### Campaigns

| Method | Path | Access | Notes |
|---|---|---|---|
| GET / POST (idem) | `/campaigns` | `campaign.view` / `campaign.manage` | Filters `status, channel`. POST `{ name, channel, templateId, segmentId, purpose?, scheduledAt? }`. Template must be active, in the org and for the same channel (422 `TEMPLATE_CHANNEL`); it may only use `{{name}}` (422 `TEMPLATE_VARIABLES`); a MARKETING template can't be sent as TRANSACTIONAL (422). `purpose` defaults to the template's category |
| GET / PATCH | `/campaigns/:id` | view / manage | GET adds `metrics`. PATCH any create field, DRAFT only (else 422 `INVALID_STATE`) |
| POST (idem) | `/campaigns/:id/submit` | manage | DRAFT → PENDING_APPROVAL. 422 `AUDIENCE_EMPTY` with the preview breakdown in `details` when nobody is eligible |
| POST (idem) | `/campaigns/:id/approve` | `campaign.approve` | PENDING_APPROVAL → APPROVED. 403 when the caller created or submitted the campaign |
| POST (idem) | `/campaigns/:id/reject` | `campaign.approve` | `{ reason }` (required) → back to DRAFT |
| POST (idem) | `/campaigns/:id/schedule` | manage | APPROVED only. `{ scheduledAt: <future> \| null }` |
| POST (idem) | `/campaigns/:id/send` | manage | APPROVED → SENDING now; queues `campaign.dispatch` |
| POST (idem) | `/campaigns/:id/cancel` | manage | DRAFT/PENDING_APPROVAL/APPROVED/SENDING → CANCELLED; recipients not yet queued become SKIPPED (`CANCELLED`) |
| GET | `/campaigns/:id/metrics` | view | See below |
| GET | `/campaigns/:id/recipients` | view | Filter `status`; each item carries `log { status, simulated, error, sentAt, deliveredAt }` |

Other actions → 404. Invalid transitions → 422 `INVALID_STATE`. Other tenants' ids → 404.

**Metrics** `{ targeted, pending, skipped, skippedByReason, queued, sent, delivered, read, failed,
failedByReason, deliveryRate, simulated: { total, queued, sent, delivered, read, failed } }`.
Real counts use only logs with `simulated = false`; `sent` counts SENT/DELIVERED/READ, `delivered`
DELIVERED/READ. `deliveryRate = delivered / sent` (null when nothing was really sent). Mock-provider
messages appear only under `simulated`. `failedByReason` is keyed by the error's leading code
(`NOT_CONFIGURED` = no provider configured; `ERROR` when the error has no code).

### Customer feedback

| Method | Path | Access | Notes |
|---|---|---|---|
| GET / POST (idem) | `/customer-feedback` | `feedback.view` / `feedback.create` | Filters `customerId, campaignId, ticketId, source, rating, isPublic, from, to, q` (comment). POST `{ rating: 1–5 integer, comment?, customerId?, campaignId?, ticketId?, source?: MANUAL\|CAMPAIGN\|TICKET\|PORTAL, isPublic?, publicConsent? }`. `isPublic: true` needs `publicConsent: true` (422). References outside the org (tickets: outside the caller's companies) → 422 `INVALID_REFERENCE` |
| GET | `/customer-feedback/summary` | view | Same filters → `{ count, averageRating, distribution: { 1..5 } }` |

### Loyalty

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/loyalty/customers/:customerId` | `loyalty.view` | `{ balance, value, programme }` |
| GET | `/loyalty/customers/:customerId/statement` | `loyalty.view` | Paginated ledger entries, newest first |
| POST (idem) | `/loyalty/customers/:customerId/redeem` | `loyalty.manage` | `{ points, reference? }` → entry + `value`. 422 `BELOW_MINIMUM`, `INSUFFICIENT_POINTS`; a reused `reference` returns the same entry (409 if the points/customer differ) |
| POST (idem) | `/loyalty/customers/:customerId/adjust` | `loyalty.manage` | `{ points (≠ 0), reason }`; can't go below zero (422 `INSUFFICIENT_POINTS`) |
| POST (idem) | `/loyalty/invoices/:invoiceId/earn` | `loyalty.manage` | POSTED invoices only (422 `INVALID_STATE`); retry-safe; `null` when the invoice earns 0 points |
| POST (idem) | `/loyalty/invoices/:invoiceId/reverse` | `loyalty.manage` | CANCELLED invoices only; retry-safe; `null` when nothing was earned |

Earn, redeem and adjust answer 422 `LOYALTY_DISABLED` while `settings.loyalty.enabled` is false.
Unknown customers/invoices (or invoices outside the caller's companies) → 404.

### Jobs

| Job | Function |
|---|---|
| `campaign-scheduler` | `startDueCampaigns(now)` — APPROVED campaigns with `scheduledAt ≤ now` → SENDING + `campaign.dispatch` |
| `loyalty-expiry` | `expireLoyaltyPoints(now)` |
| queue `campaign.dispatch` | `dispatchCampaign({ campaignId })` |
