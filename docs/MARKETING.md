# Marketing: campaigns, segments, feedback and loyalty

Code: `src/features/marketing/`. Endpoints: `docs/api/marketing.md`. Messages are recorded and
consent-checked only through `queueMessage` in `src/features/communication/send.ts`; delivery belongs
to the communication module.

## Segments

- A segment is a saved audience over **customers**, **customer contacts** (vendor contacts are never
  included) or **leads** (archived leads excluded), with filters `[{ field, op, value }]`.
- Filters are checked against a per-entity allowlist and translated to Prisma `where` objects. Values
  are bound parameters — something like `x' OR 1=1 --` is just a name that matches nothing. Unknown
  fields, operators or values answer 422.
- Membership is evaluated when previewed, at submit (audience validation) and at dispatch, never
  stored on the segment. A segment can't be edited while a campaign using it awaits approval or is
  sending, and can't be deleted while any campaign uses it.
- **Addresses per channel:** EMAIL uses `email`; SMS uses `phone`; WhatsApp uses a lead's
  `whatsappNumber` (falling back to `phone`) or a customer/contact `phone`. Addresses are normalized
  with `normalizeAddress` (lower-case email; phone digits with country code).
- **Preview** counts matched records (`total`), records with a valid address (`withAddress`), distinct
  addresses (`unique`), distinct addresses that pass consent (`eligible`), and what is blocked:
  `NO_CONSENT` / `OPTED_OUT` (per distinct address, from `checkConsent`) and `INVALID_ADDRESS`
  (records with a missing or malformed address).
- **Lead visibility:** lead segments include only leads the viewer can see (`lead.view_all`, or
  assigned to them). Preview and submit use the caller; dispatch uses the campaign's submitter.

## Campaign lifecycle

```
DRAFT --submit--> PENDING_APPROVAL --approve--> APPROVED --send / scheduler--> SENDING --> COMPLETED
                         \--reject--> DRAFT
DRAFT | PENDING_APPROVAL | APPROVED | SENDING --cancel--> CANCELLED
```

- Only DRAFT campaigns are edited. The template must match the channel, be active, and use no
  placeholder other than `{{name}}` (filled with the recipient's name). A MARKETING template always
  sends with purpose MARKETING (opt-in required).
- **Submit** validates the audience now: at least one eligible recipient, or 422 `AUDIENCE_EMPTY`
  with the breakdown. The counts are kept in the audit trail.
- **Approve** needs `campaign.approve` and a different person from the creator and the submitter
  (403 otherwise — this applies to owners and admins too).
- **Send** starts at once; **schedule** sets a future `scheduledAt` that the `campaign-scheduler` job
  picks up. A schedule set on the draft is kept; if it has already passed when the campaign is
  approved, the next scheduler run starts it.
- **Cancel** while SENDING stops queuing: the dispatcher re-checks the status before each
  recipient (at most the one in flight still goes out) and every recipient still PENDING becomes
  SKIPPED with reason `CANCELLED`.

## Dispatch (`campaign.dispatch` queue job)

1. **Materialize** recipients from the segment: one row per normalized address (deduplicated across
   customers/contacts/leads), inserted with `createMany … skipDuplicates` on `(campaignId, address)`.
   Records without any address are not targeted. Re-running adds only newly matching addresses.
2. **Queue** each PENDING recipient in its own transaction under a row lock: `queueMessage` with
   idempotency key `campaign:<campaignId>:<address>`, then link `communicationLogId`. QUEUED logs
   make the recipient QUEUED; BLOCKED logs make it SKIPPED with the log's reason (`NO_CONSENT`,
   `OPTED_OUT`, `INVALID_ADDRESS`).
3. **Complete** the campaign when nothing is PENDING (conditional update from SENDING).

A crash at any point leaves each recipient either untouched (PENDING) or fully queued; the queue
retries the job and the run carries on. Overlapping runs block on the recipient lock and skip what
is already done, and the idempotency key makes a second message for the same address impossible.
Runs stop after ~20 s and enqueue a continuation job (`campaign.dispatch:<id>:after:<n>`) to stay
inside the queue's handler timeout.

Recipient status stops at QUEUED/SKIPPED; delivery progress (SENT, DELIVERED, READ, FAILED) lives on
the communication log, which the delivery worker updates. Metrics and the recipients list read it
from there.

Known limits: the whole audience is loaded in memory per run (fine to ~100k records); a template
deactivated mid-send, or a lead campaign whose submitter has left the organization, makes the job
fail and retry until it is dead — fix the cause and replay the job.

## Metrics and simulated delivery

- `targeted` = materialized recipients; `skipped` by reason; `queued` / `sent` / `delivered` /
  `read` / `failed` (with `failedByReason`) from the campaign's communication logs.
- **Only real deliveries count.** Logs handled by the mock provider (`simulated = true`) are reported
  separately under `simulated` and are excluded from sent, delivered, read and the delivery rate.
  The UI labels them "Simulated — not delivered".
- `deliveryRate = delivered / sent` over real logs, null when nothing was really sent.
- **No provider configured:** campaigns are still created, approved and dispatched; the delivery
  worker fails those messages with `NOT_CONFIGURED`, the campaign completes, and the report shows them
  under `failedByReason.NOT_CONFIGURED`.

## Customer feedback

- Rating is an integer 1–5. Customer, campaign and ticket references must belong to the
  organization (tickets also to the caller's companies), else 422 `INVALID_REFERENCE`.
- `isPublic` (usable as a published review) requires `publicConsent: true` in the same request —
  the customer's explicit agreement. The consent flag is stored in the audit trail.
- The summary returns count, average rating and the 1–5 distribution for any list filter.

## Loyalty

Settings (`organization.settings.loyalty`): `enabled`, `pointsPerCurrencyUnit`, `pointValue`,
`minRedeemPoints`, `expiryDays`. Earn, redeem and adjust answer 422 `LOYALTY_DISABLED` while the
programme is off; balances and statements stay readable, and reversal and expiry keep running.

The ledger is **append-only**; `balanceAfter` is the running sum after each entry. Every write takes
a per-customer advisory lock (`pg_advisory_xact_lock`) and recomputes the balance from the ledger, so
concurrent redemptions can't overspend and the balance never goes below zero.

| Kind | Points | Rule |
|---|---|---|
| EARN | + | `floor(grandTotal × pointsPerCurrencyUnit)` for a POSTED sales invoice; once per invoice (unique org + `SALES_INVOICE` + invoice id + kind); `expiresAt = now + expiryDays` |
| REVERSAL | − | when the invoice is CANCELLED: the earned points, **clamped to the current balance**. Points the customer already redeemed are not clawed back (no negative balances); the shortfall is written in `reason` |
| REDEEM | − | `minRedeemPoints ≤ points ≤ balance`; value = points × pointValue. An optional `reference` makes it retry-safe |
| ADJUST | ± | manual, `loyalty.manage`, reason required; can't go below zero |
| EXPIRE | − | see below |

**Expiry (FIFO).** Debits consume the oldest credits first. When an EARN lot passes `expiresAt`, the
`loyalty-expiry` job writes one EXPIRE entry for it (unique per lot, so re-runs do nothing) with the
lot's unused remainder: `clamp(credits up to and including the lot − all debits so far, 0, lot)`.
A fully used lot gets a 0-point EXPIRE marker. If `expiryDays` changes, newer lots can expire before
older ones and the FIFO attribution becomes approximate.

**Wiring.** Earning and reversal are explicit calls (`POST /loyalty/invoices/:id/earn|reverse`, or
`earnForInvoice` / `reverseForInvoice`); invoice posting and cancellation do not call them yet.

## Jobs

| Name | Function | Notes |
|---|---|---|
| `campaign-scheduler` | `startDueCampaigns(now)` | claims due APPROVED campaigns with a conditional update, so overlapping runs start each once |
| `loyalty-expiry` | `expireLoyaltyPoints(now)` | idempotent; one EXPIRE per lot |
