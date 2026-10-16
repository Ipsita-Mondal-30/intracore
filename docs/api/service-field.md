# Service & field API: assets, warranties, AMC, claims, visits, installations, dispatch

All endpoints are under `/api/v1`. Responses use the shared shape described in `docs/API.md`:
`{ ok: true, data }` or `{ ok: false, error, code, details? }`. Every POST accepts an `Idempotency-Key`
header. Lists accept `page`, `pageSize`, `sort`, `dir` and `q`.

Assets, contracts, visits and installation jobs are company-scoped. A record in a company you have no
scope for returns **404**, the same as a record in another tenant. Dates are `YYYY-MM-DD`; timestamps
are ISO-8601. Money values are decimal strings.

## Assets — `asset.view` / `asset.create` / `asset.update`

| Method | Path | Notes |
|---|---|---|
| GET | `/assets` | Filters: `status`, `customerId`, `ownership`, `assignedToId`; `q` searches tag, name, serial and location. Sort by `createdAt`, `tag` or `name`. |
| POST | `/assets` | `{ companyId, tag, name, ownership?: COMPANY\|CUSTOMER, customerId?, productId?, serialNumber?, location?, latitude?, longitude?, assignedToId?, status?: IN_USE\|IN_STOCK, purchaseDate?, installDate?, value? }` |
| GET | `/assets/:id` | Includes warranties and the contracts that cover the asset. |
| PATCH | `/assets/:id` | Same fields as POST except `companyId`, `tag` and `status`. Changes to assignment and location are written to the audit trail, which is the asset's history. |
| POST | `/assets/:id/{in-use\|in-stock\|repair\|retire\|dispose}` | Moves the asset through its lifecycle. Body: `{ note? }`. |

The lifecycle runs IN_STOCK ⇄ IN_USE ⇄ UNDER_REPAIR, then → RETIRED → DISPOSED. An asset can be retired from any of the first three states, and only a RETIRED asset can be disposed. Any other transition returns `422 INVALID_STATE`.

Rules:
- A CUSTOMER-owned asset needs a `customerId`.
- A serial number must be unique per product. A duplicate returns `409 CONFLICT`.
- The assignee must be an active member of the organization.

## Warranties — `asset.view` / `asset.update`

| Method | Path | Notes |
|---|---|---|
| GET | `/warranties` | Filters: `assetId`, `expiringBefore`. Sort by `endDate` (default), `startDate` or `createdAt`. |
| POST | `/warranties` | `{ assetId, type?: STANDARD\|EXTENDED, startDate, endDate, coversParts?, coversLabor?, terms? }`. `endDate` must be on or after `startDate`. |
| GET / PATCH | `/warranties/:id` | Changing `endDate` re-arms the expiry reminder. |

## Service contracts (AMC) — `contract.view` / `contract.create` / `contract.update`

| Method | Path | Notes |
|---|---|---|
| GET | `/service-contracts` | Filters: `status`, `customerId`, `assetId`, `endingBefore`; `q` searches the number. |
| POST | `/service-contracts` | `{ companyId, customerId, startDate, endDate, value, terms?, assetIds?: [], entitlements?: [{ serviceType, quantity? }], renewalOfId? }`. The number comes from the `AMC-` sequence. |
| GET | `/service-contracts/:id` | Includes assets, entitlements (`quantity`, `usedCount`) and renewal links. |
| PATCH | `/service-contracts/:id` | DRAFT only. `assetIds` and `entitlements` replace the current lists. |
| POST | `/service-contracts/:id/activate` | DRAFT → ACTIVE. Needs at least one asset and one entitlement, and an end date that has not passed. Activating a contract that has `renewalOfId` marks the earlier contract RENEWED. |
| POST | `/service-contracts/:id/cancel` | DRAFT or ACTIVE → CANCELLED. Body: `{ reason }` (required). |
| POST | `/service-contracts/:id/expire` | ACTIVE → EXPIRED. The `expireServiceContracts` job also does this automatically. |
| POST | `/service-contracts/:id/renewal-quotation` | Needs `quotation.create` as well. Body: `{ branchId, lines?, validUntil?, notes? }`. Creates a **DRAFT** quotation for the customer, priced like `POST /quotations`. Without `lines`, it has one line at the contract value. The quotation is linked through `renewalQuotationId`, and a retry returns the same quotation. Only ACTIVE or EXPIRED contracts can be renewed. |

Entitlements:
- Each covered asset must belong to the contract's customer.
- `serviceType` is stored in upper case and must be unique within a contract.
- `quantity: null` means unlimited.

## Service claims — `contract.view`; submit/cancel `contract.update`; approve/reject `service.administer`

| Method | Path | Notes |
|---|---|---|
| GET | `/service-claims` | Filters: `status`, `assetId`, `contractId`. Each item has `covered`. |
| POST | `/service-claims` | `{ assetId, serviceType, customerId?, claimType?: WARRANTY\|AMC, contractId?, ticketId? }` |
| GET | `/service-claims/:id` | |
| POST | `/service-claims/:id/approve` | PENDING → APPROVED. Coverage is checked again on the claim date, and one unit of the entitlement is consumed atomically. A retry on an APPROVED claim returns the claim without consuming again. |
| POST | `/service-claims/:id/reject` | PENDING → REJECTED. Body: `{ reason }`. |
| POST | `/service-claims/:id/cancel` | PENDING → CANCELLED. |

### How a claim is checked

When `customerId` is given and the asset belongs to someone else, the request fails with `422 ASSET_CUSTOMER_MISMATCH` and nothing is recorded.

Otherwise the claim is checked against the warranty first (unless `claimType` says otherwise), then against an AMC:

- **Warranty:** a warranty for the asset must be in force on the claim date. The service type decides which cover is needed:
  - `PARTS` needs `coversParts`.
  - `LABOR` needs `coversLabor`.
  - `REPAIR` needs both.
- **AMC:** an ACTIVE contract for the asset's customer must be in its period on the claim date and must include the asset. It also needs an entitlement for the service type with `usedCount < quantity`, or with no quantity limit.

A covered claim is recorded **PENDING**, with `claimType` and `contractId` filled in.

A claim that is not covered is recorded **REJECTED** with `covered: false`. This means the work is chargeable. `decisionReason` holds the reason codes, comma-separated in the order they were checked:

| Code | Meaning |
|---|---|
| `NO_WARRANTY` | The asset has no warranty |
| `WARRANTY_NOT_STARTED` | The warranty has not started yet |
| `WARRANTY_EXPIRED` | The warranty has expired |
| `WARRANTY_TYPE_NOT_COVERED` | The warranty does not cover this service type |
| `NO_ACTIVE_CONTRACT` | No ACTIVE contract covers the asset on this date |
| `SERVICE_TYPE_NOT_COVERED` | The contract has no entitlement for this service type |
| `ENTITLEMENT_EXHAUSTED` | The entitlement for this service type is used up |

At approval, a claim that is no longer covered fails with `422` and the reason code as `code`, for example `ENTITLEMENT_EXHAUSTED`. The entitlement is updated with a conditional `UPDATE … WHERE usedCount < quantity`, so concurrent approvals can never consume more than the included quantity.

## Service visits — `field.view`; schedule/reschedule/cancel/no-show `field.schedule`; start/complete `field.update`

Members without `field.schedule`, such as technicians, see and work only the visits assigned to them. Visits assigned to anyone else return 404.

| Method | Path | Notes |
|---|---|---|
| GET | `/service-visits` | Filters: `status`, `technicianId`, `assetId`, `from`, `to`. Sort by `scheduledStart` (default) or `createdAt`. |
| POST | `/service-visits` | `{ companyId, technicianId, scheduledStart, scheduledEnd, serviceType?, ticketId?, contractId?, assetId?, notes? }` |
| GET | `/service-visits/:id` | |
| PATCH | `/service-visits/:id` | Reschedule or reassign a SCHEDULED visit: `{ technicianId?, scheduledStart?, scheduledEnd?, serviceType?, notes? }` |
| POST | `/service-visits/:id/start` | SCHEDULED → IN_PROGRESS and sets `checkInAt`. Only the assigned technician or a scheduler can do this. |
| POST | `/service-visits/:id/complete` | IN_PROGRESS → COMPLETED. Body: `{ notes (required), workDone?, customerSignedBy? }` |
| POST | `/service-visits/:id/cancel` | SCHEDULED → CANCELLED. Body: `{ reason }` |
| POST | `/service-visits/:id/no-show` | SCHEDULED → NO_SHOW |

Scheduling rules:
- The technician must be an active member with access to the company.
- Linked tickets, contracts and assets must belong to the same company.
- A slot that overlaps another open visit or installation job for the same technician returns `422 DOUBLE_BOOKED`. Slots are half-open, so back-to-back slots are allowed. Checks for the same technician run one at a time, so two concurrent bookings cannot both succeed.

Evidence such as photos and signed job sheets is uploaded with `POST /documents` (`entityType=service_visit`).

## Installation jobs — `field.view`; create/schedule/cancel `field.schedule`; start/checklist/complete `field.update`

Technicians see only the jobs assigned to them.

| Method | Path | Notes |
|---|---|---|
| GET | `/installation-jobs` | Filters: `status`, `customerId`; `q` searches the number and address. |
| POST | `/installation-jobs` | `{ companyId, customerId, salesOrderId?, assetId?, address?, technicianId?, scheduledStart?, scheduledEnd?, notes?, checklist: [{ label, required?=true }] }`. The number comes from the `INS-` sequence. The job starts SCHEDULED when it has a technician and a slot, otherwise PLANNED. |
| GET | `/installation-jobs/:id` | Includes the checklist. |
| PATCH | `/installation-jobs/:id` | Schedules or reschedules a PLANNED or SCHEDULED job: `{ technicianId, scheduledStart, scheduledEnd, address?, notes? }`. Uses the same double-booking check as visits. |
| PATCH | `/installation-jobs/:id/checklist/:itemId` | `{ done, note? }`. Not allowed once the job is COMPLETED or CANCELLED. |
| POST | `/installation-jobs/:id/start` | SCHEDULED → IN_PROGRESS |
| POST | `/installation-jobs/:id/complete` | IN_PROGRESS → COMPLETED. Fails with `422 CHECKLIST_INCOMPLETE` while any required item is unchecked; `details.items` lists the open items. |
| POST | `/installation-jobs/:id/cancel` | PLANNED, SCHEDULED or IN_PROGRESS → CANCELLED. Body: `{ reason }` |

Files are attached with `POST /documents` (`entityType=installation_job`).

## Dispatch and proof of delivery — `field.view`; create `field.schedule`; transitions `field.update`

| Method | Path | Notes |
|---|---|---|
| GET | `/dispatches` | Filters: `status`; `q` searches carrier, tracking number and receiver. |
| POST | `/dispatches` | `{ stockEntryId, carrier?, trackingNumber?, vehicleNumber?, driverName? }`. The stock entry must be a **POSTED DELIVERY** in your scope. Each delivery has one dispatch, so repeating the request returns the existing one. |
| GET | `/dispatches/:id` | |
| POST | `/dispatches/:id/in-transit` | DISPATCHED → IN_TRANSIT. Body: `{ trackingNumber?, vehicleNumber?, driverName? }` |
| POST | `/dispatches/:id/deliver` | DISPATCHED or IN_TRANSIT → DELIVERED. The proof of delivery is required: `{ receivedByName, deliveredAt? }`. `deliveredAt` defaults to now and cannot be in the future or before dispatch. |
| POST | `/dispatches/:id/fail` | DISPATCHED or IN_TRANSIT → FAILED. Body: `{ reason }` |

Upload the signed POD copy or photo with `POST /documents` (`entityType=delivery_dispatch`).

## Jobs (service functions)

| Function | Effect |
|---|---|
| `sendContractAndWarrantyReminders(now, days = 30)` | Sends one notification per ACTIVE contract or warranty that ends within `days`. Each row is claimed first with a conditional update on `remindedAt`, so overlapping runs never notify twice. Contract reminders go to the contract's creator. Warranty reminders go to the asset's assignee, then the customer's owner, then the organization owner. |
| `expireServiceContracts(now)` | Marks ACTIVE contracts whose end date has passed as EXPIRED. |

## Location and route providers

`src/features/service/providers.ts` defines two interfaces, `LocationProvider` (`geocode`, `currentLocation`) and `RouteProvider` (`planRoute`). Their defaults reject with `AppError NOT_CONFIGURED` (501). No external calls are made yet.
