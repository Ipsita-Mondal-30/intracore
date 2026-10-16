## Manufacturing, quality and supplier qualification (Phase 5)

All endpoints are under `/api/v1` with the shared `{ ok, data }` / `{ ok: false, error, code, details? }`
shape. "(idem)" endpoints honour `Idempotency-Key`. Lists take `page, pageSize, sort, dir, q`.
Quantities are decimal strings in the product's **base unit**. Rules and costing: `docs/MANUFACTURING.md`.

**Scope.** BOMs and inspection templates are organization-level. Work orders, inspections and NCRs
belong to a company without a branch, so only members with **company-wide** scope see them; any other
id answers **404**.

### Bills of materials — `src/features/manufacturing/boms.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/boms` | `manufacturing.view` | Filters `productId, status (DRAFT\|ACTIVE\|ARCHIVED)`, `q` (product name/SKU). Sort `createdAt, version` |
| POST (idem) | `/boms` | `manufacturing.create` | `{ productId, outputQuantity? = 1, notes?, lines: [{ componentId, quantity > 0, scrapPercent? (0–99.99), sortOrder? }] }` → DRAFT, next version. Product and components must be stock-tracked goods; self-reference / duplicate component → 422 |
| GET | `/boms/:id` | `manufacturing.view` | Lines with components |
| PATCH | `/boms/:id` | `manufacturing.create` | DRAFT only (`outputQuantity, notes, lines` — lines are replaced); otherwise 422 `INVALID_STATE` |
| POST (idem) | `/boms/:id/activate` | `manufacturing.create` | DRAFT → ACTIVE; the previous ACTIVE version is ARCHIVED. 422 `CYCLE` if a component (through active BOMs) needs this product |
| POST (idem) | `/boms/:id/archive` | `manufacturing.create` | DRAFT/ACTIVE → ARCHIVED |
| POST (idem) | `/boms/:id/copy` | `manufacturing.create` | New DRAFT version with the same lines (the way to change an active BOM) |

### Work orders — `src/features/manufacturing/work-orders.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/work-orders` | `manufacturing.view` | Filters `status, productId, companyId`, `q` (number). Sort `createdAt, number, plannedStart, plannedEnd` |
| POST (idem) | `/work-orders` | `manufacturing.create` | `{ companyId, productId, warehouseId, quantity, bomId? (default: ACTIVE version; DRAFT refused), plannedStart?, plannedEnd?, salesOrderId? }` → DRAFT, number `WO-…`, materials snapshotted (`requiredQty = line qty × quantity ÷ outputQuantity × (1 + scrap%)`, rounded up to 4 dp). No active BOM → 422 `NO_BOM` |
| GET | `/work-orders/:id` | `manufacturing.view` | Adds per material `open, onHand, available (free), reserved (for this order), shortage`; `costs { consumedValue, absorbedValue, wipValue }`; stock entries |
| POST (idem) | `/work-orders/:id/release` | `manufacturing.release` | DRAFT → RELEASED; reserves materials as far as stock allows. Returns `reservations: [{ workOrderMaterialId, reserved, short }]` — shortages do not block release |
| POST (idem) | `/work-orders/:id/reserve` | `manufacturing.release` | RELEASED/IN_PROGRESS: top reservations up to the open quantity (retry-safe) |
| POST (idem) | `/work-orders/:id/start` | `manufacturing.produce` | RELEASED → IN_PROGRESS (also automatic on the first issue/receipt) |
| POST (idem) | `/work-orders/:id/issue` | `manufacturing.produce` | `{ lines?: [{ productId, quantity, lotNumber?, sourceLocationId? }], allowOverIssue? = false, reference? }`. Omit `lines` to issue everything open. Posts a `PRODUCTION_ISSUE` stock entry (returned). Beyond required without the flag → 422 `QUANTITY_EXCEEDED`; beyond stock / into other reservations → 422 `INSUFFICIENT_STOCK` (nothing persisted) |
| POST (idem) | `/work-orders/:id/receive` | `manufacturing.produce` | `{ quantity, lotNumber?, expiryDate?, targetLocationId?, allowOverReceipt? = false, reference? }`. Posts a `PRODUCTION_RECEIPT` at the WIP cost (see costing). Beyond planned without the flag → 422 `QUANTITY_EXCEEDED` |
| POST (idem) | `/work-orders/:id/complete` | `manufacturing.produce` | RELEASED/IN_PROGRESS → COMPLETED; needs `producedQty > 0`; releases remaining reservations |
| POST (idem) | `/work-orders/:id/cancel` | `manufacturing.release` | `{ reason? }`. DRAFT/RELEASED/IN_PROGRESS → CANCELLED while nothing is consumed or produced (cancel those stock entries first); releases reservations |

Other transitions → 422 `INVALID_STATE`; unknown actions → 404. Issued materials are returned by
cancelling the issue's stock entry (`POST /stock-entries/:id/cancel`), which also reduces `consumedQty`.

### Material planning — `src/features/manufacturing/mrp.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/mrp?companyId=&warehouseId?=&productId=&quantity=` | `manufacturing.view` | `mode: "explosion"`: multi-level explosion through ACTIVE BOMs. `lines: [{ product, level, source: MAKE\|BUY, required, onHand, reserved, available, covered, shortage }]`. 422 `NO_BOM`, 422 `CYCLE` |
| GET | `/mrp?companyId=&warehouseId?=` | `manufacturing.view` | `mode: "open"`: open requirements of DRAFT/RELEASED/IN_PROGRESS work orders per warehouse and material: `openRequirement, reservedForWorkOrders, onHand, available, shortage, workOrders` |

### Inspections — `src/features/quality/inspections.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/inspection-templates` | `quality.view` | Filters `appliesTo, active=true\|false`, `q` |
| POST (idem) | `/inspection-templates` | `quality.manage` | `{ name, appliesTo: GOODS_RECEIPT\|PRODUCTION\|GENERAL, items: [{ label, type: BOOLEAN\|NUMERIC\|TEXT, minValue?, maxValue?, required? = true }] }`. NUMERIC needs a min or max; items without a label are dropped. Name unique (409) |
| GET / PATCH | `/inspection-templates/:id` | `quality.view` / `quality.manage` | PATCH `{ name?, isActive?, items? }`; items are replaceable only until the template is used (else 422) |
| GET | `/inspections` | `quality.view` | Filters `sourceType, sourceId, productId, result, companyId` |
| POST (idem) | `/inspections` | `quality.inspect` (+ `inventory.create` & `inventory.post` for `returnRejected`) | `{ templateId, sourceType: GOODS_RECEIPT\|WORK_ORDER, sourceId, productId? (required for receipts), inspectedQty, rejectedQty?, results: [{ itemId, value }], raiseNcr? = true, severity? = MINOR, ncrDescription?, returnRejected? = false }`. Returns the inspection plus `nonConformance` and `purchaseReturn` (or null) |
| GET | `/inspections/:id` | `quality.view` | |

Evaluation: BOOLEAN passes on `true`/`"pass"`; NUMERIC passes within `[minValue, maxValue]`; TEXT is
recorded only. A missing required result → 422. `rejectedQty` defaults to all inspected when any check
fails, else 0; a failed check with `rejectedQty: 0` → 422. `result` = PASSED (0 rejected), FAILED (all),
PARTIAL. Receipts: Σ inspected per product ≤ received (422 `QUANTITY_EXCEEDED`); the template must apply
to the source (GENERAL or matching).

### Non-conformances — `src/features/quality/ncr.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/nonconformances` | `quality.view` | Filters `status, severity, vendorId, productId, companyId`, `q` |
| POST (idem) | `/nonconformances` | `quality.inspect` | Manual NCR `{ companyId, description, severity?, productId?, vendorId?, quantity? }`, number `NCR-…` |
| GET / PATCH | `/nonconformances/:id` | `quality.view` / `quality.manage` | GET adds `product, vendor, inspection, correctiveActions` (tasks). PATCH `{ description?, severity?, rootCause? }` unless CLOSED |
| POST (idem) | `/nonconformances/:id/actions` | `quality.manage` + `task.create` | Corrective action → a task (`entityType: "nonconformance"`) via the tasks service; OPEN → IN_PROGRESS. Complete it with `PATCH /tasks/:id {status: COMPLETED}` |
| POST (idem) | `/nonconformances/:id/{start\|close\|reopen}` | `quality.manage` | start: OPEN → IN_PROGRESS. close `{ rootCause? }`: needs a root cause (422) and no PENDING/RESCHEDULED corrective task (422 `OPEN_ACTIONS`). reopen `{ reason? }`: CLOSED → IN_PROGRESS |

### Suppliers — `src/features/quality/suppliers.ts`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/supplier-evaluations` | `supplier.evaluate` or `vendor.view` | Filter `vendorId`; sort `evaluatedOn, createdAt` |
| POST (idem) | `/supplier-evaluations` | `supplier.evaluate` | `{ vendorId, qualityScore, deliveryScore, priceScore (0–100 ints), evaluatedOn?, notes?, qualificationStatus?: APPROVED\|CONDITIONAL\|PENDING\|BLOCKED }`; a status change is audited on the vendor |
| GET | `/procurement-reports?companyId=&from=&to=` | `purchase_order.view` | Per vendor (approved+ POs by order date, caller's company/branch scope): `purchaseOrders, orderValue, receipts, onTimeReceiptPct, avgLeadTimeDays, inspectedQty, rejectedQty, rejectionRatePct, nonConformances { total, open }, latestEvaluation` |

**Purchase approvals.** Creating, editing, submitting or approving a purchase order for a vendor whose
`qualificationStatus` is `BLOCKED` → `422 VENDOR_NOT_QUALIFIED`. Orders already approved are unaffected.

### Examples

```bash
curl -X POST $HOST/api/v1/boms -H 'content-type: application/json' \
  -d '{"productId":"prd_fg","outputQuantity":"2","lines":[{"componentId":"prd_a","quantity":"4"},{"componentId":"prd_b","quantity":"1","scrapPercent":"5"}]}'
curl -X POST $HOST/api/v1/boms/bom_.../activate
curl -X POST $HOST/api/v1/work-orders -H 'idempotency-key: wo-123' -H 'content-type: application/json' \
  -d '{"companyId":"cmp_...","productId":"prd_fg","warehouseId":"wh_main","quantity":"4"}'
curl -X POST $HOST/api/v1/work-orders/wo_.../release
curl -X POST $HOST/api/v1/work-orders/wo_.../issue -H 'idempotency-key: issue-wo123-1' -d '{}'
curl -X POST $HOST/api/v1/work-orders/wo_.../receive -H 'idempotency-key: rcv-wo123-1' -d '{"quantity":"4"}'
curl "$HOST/api/v1/mrp?companyId=cmp_...&productId=prd_fg&quantity=50"
curl -X POST $HOST/api/v1/inspections -H 'content-type: application/json' \
  -d '{"templateId":"tpl_...","sourceType":"GOODS_RECEIPT","sourceId":"grn_...","productId":"prd_a","inspectedQty":"20",
       "results":[{"itemId":"itm_len","value":"10.7"},{"itemId":"itm_thread","value":true}],"severity":"MAJOR","returnRejected":true}'
```
