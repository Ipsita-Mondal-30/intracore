# Inventory: stock lifecycle and valuation

Code: `src/features/inventory/` (engine in `stock.ts`, documents in `entries.ts`).

## Source of truth

| Table | Role |
|---|---|
| `stock_moves` | **Append-only ledger.** One row per signed quantity change (base units) at one storage location, with the unit cost and value. Never updated or deleted. |
| `stock_balances` | Cached on-hand per location / product / lot. Written only by posting a stock entry, in the same transaction as the moves. |
| `stock_valuations` | Cached quantity, value and average cost per company / product. Same rule. |
| `stock_reservations` | One row per sales-order line: the quantity currently set aside for it. |

No CRUD endpoint writes balances or valuations. The only writers are posting a stock entry,
cancelling (reversing) one, and the reconciliation repair, which rebuilds the caches from the ledger.

Every stock change runs in one database transaction holding a Postgres advisory lock per
`(company, product)`. Locks are taken in sorted order, so concurrent postings for the same products queue
instead of racing and cannot deadlock.

```
on hand   = Σ stock_moves.quantity            (per location, warehouse or company)
reserved  = Σ stock_reservations.quantity      (per warehouse)
available = on hand − reserved
```

## Documents (`stock_entries`)

| Type | Created by | Effect when posted |
|---|---|---|
| `OPENING` | `POST /stock-entries` | + target warehouse at the given unit cost (required) |
| `RECEIPT` | `POST /stock-entries` | + target warehouse (unit cost given, else current average, else product purchase price) |
| `ISSUE` | `POST /stock-entries` | − source warehouse at average cost |
| `ADJUSTMENT` | `POST /stock-entries` | ± the warehouse (`targetWarehouseId`); signed quantities (count corrections) |
| `TRANSFER` | `POST /stock-entries` | − source, + target, both at average cost (value unchanged inside a company) |
| `GOODS_RECEIPT` | `POST /purchase-orders/:id/receive` | + PO warehouse at the PO line's net price (taxable value ÷ qty, excl. GST); PO line `receivedQty` += |
| `DELIVERY` | `POST /sales-orders/:id/deliver` | − SO warehouse at average cost; consumes the line's reservation first; SO line `deliveredQty` += |
| `SALES_RETURN` | `POST /stock-entries/:deliveryId/return` | + back into the original location at the original delivery cost; SO line `returnedQty` += |
| `PURCHASE_RETURN` | `POST /stock-entries/:grnId/return` | − from the original location at the original receipt cost; PO line `returnedQty` += |

Statuses: `DRAFT` (no effect) → `POSTED` → `CANCELLED`. Cancelling a posted entry writes
**reversing moves** at the original costs (`isReversal = true`) and undoes the document quantities.
Cancelling is blocked while later documents depend on the entry:
- a delivery or receipt with posted returns against it;
- a receipt whose PO line would end up billed for more than it received.

Posting is **retry-safe**. The entry row is locked, and an entry that is already `POSTED` is
returned unchanged, so a retried request can never deduct stock twice. The API's `Idempotency-Key`
also replays the original response.

## Rules enforced on every posting

- **No negative stock** (default). An outbound move may not take a location / lot below zero, and may
  not take a warehouse below what is reserved for *other* orders. Violations fail with
  `422 INSUFFICIENT_STOCK` and roll back the whole document, including its document number.
  - A company can opt in with `settings.inventory.allowNegativeStock = true`
    (`PATCH /companies/:id`). Negative quantities are then carried at average cost.
- **Quantities**:
  - receipts ≤ ordered − received;
  - deliveries ≤ ordered − delivered;
  - returns ≤ the original line minus earlier returns;
  - bills ≤ received − returned − already billed (three-way match).
  
  Violations give `422 QUANTITY_EXCEEDED`.
- **Batch / serial / expiry**:
  - tracked products need a lot number;
  - inbound movements create the lot, and need an expiry date when `hasExpiry` is set;
  - outbound movements must use an existing lot, and deliveries refuse expired lots;
  - serial numbers move one unit per line, and an inbound serial that is already in stock is rejected (`409`).
- **Units of measure**:
  - document lines may use an alternate unit with a per-product conversion (`PUT /products/:id/uom-conversions`, e.g. 1 BOX = 12 NOS);
  - stock moves are always in the product's base unit.
- **Products**:
  - a product with stock or open reservations cannot be archived;
  - its base unit, tracking mode and stock tracking cannot change while stock exists.

## Sales order lifecycle and reservations

| Event | Stock effect |
|---|---|
| Order created / edited as DRAFT | none |
| `confirm` | Reserves `min(ordered − delivered, available)` per stocked line from the order's warehouse. Short lines are reserved partially; the response lists `reserved` / `short` per line. |
| `reserve` | Tops reservations up to the open quantity (e.g. after a receipt). Idempotent: one reservation row per line, never above the open quantity. |
| Amendment (CONFIRMED, nothing delivered) | Lines are replaced, then re-reserved |
| Delivery posted | Stock is issued and the line's reservation is consumed (`min(reserved, delivered)`) |
| `cancel` (nothing delivered) | Reservations released |
| Delivery cancelled (reversed) | Stock comes back as available; the reservation is **not** re-created (use `reserve`) |

Concurrent confirmations for the same product serialize on the advisory lock, so two orders
can never reserve the same unit. This is covered by `tests/inventory-purchasing.db.test.ts`
("never over-reserves under concurrent confirmations").

A purchase order **never** changes stock by being created or approved. Stock arrives only
with a posted goods receipt.

## Valuation: moving weighted average (per company, per product)

- Inbound move: `value += qty × unit cost`; `average = value ÷ qty`.
- Outbound move at average cost: `value −= qty × average`; the average is unchanged.
- When quantity returns to zero, any rounding residue is written off (value = 0).
- Transfers inside a company leave and arrive at the average, so value is unchanged.
- Returns use the cost of the original move, so a return mirrors what it reverses.

Why moving average: it needs no cost layers, it is deterministic under concurrent postings
(each posting holds the product lock), and it is accepted under Ind AS 2 for interchangeable goods.
FIFO would need layer tables and is not implemented.

## Reconciliation

`POST /stock/reconcile {companyId}` compares the cached balances and valuation with the ledger.
It returns `balanceDiffs` and `valuationDiffs`. With `fix: true` (requires `inventory.administer`)
it rebuilds the caches from the ledger and audits the repair. The ledger itself is never modified.

## Reorder suggestions and alerts

`GET /stock/reorder-suggestions?companyId=` lists products where available plus incoming is at or
below `reorderLevel`. Available is company-wide on hand minus reserved. Incoming is the open
quantity on APPROVED / PARTIALLY_RECEIVED purchase orders. The suggested quantity is `reorderQty`,
or else enough to reach the level.

The `low-stock-alerts` job sends in-app notifications. Recipients are owners plus members of that
company holding `purchase_order.create` or `inventory.administer`. Each user gets one alert per
product until they read it.

## Sample requests

All requests use the app's session cookie. Send an `Idempotency-Key` on POSTs you may retry.

```bash
# Opening stock (posted immediately)
curl -X POST $HOST/api/v1/stock-entries -H 'content-type: application/json' -H 'idempotency-key: open-2026-10' \
  -d '{"companyId":"cmp_...","type":"OPENING","targetWarehouseId":"wh_...","post":true,
       "lines":[{"productId":"prd_...","quantity":"120","unitCost":"85.50"},
                {"productId":"prd_batch","quantity":"40","unitCost":"12","lotNumber":"B-2611","expiryDate":"2027-06-30"}]}'

# Transfer between warehouses
curl -X POST $HOST/api/v1/stock-entries -H 'content-type: application/json' \
  -d '{"companyId":"cmp_...","type":"TRANSFER","sourceWarehouseId":"wh_main","targetWarehouseId":"wh_blr","post":true,
       "lines":[{"productId":"prd_...","quantity":"25"}]}'

# Count correction (+2 found, -1 damaged)
curl -X POST $HOST/api/v1/stock-entries -H 'content-type: application/json' \
  -d '{"companyId":"cmp_...","type":"ADJUSTMENT","targetWarehouseId":"wh_main","post":true,"reference":"Cycle count Oct",
       "lines":[{"productId":"prd_a","quantity":"2"},{"productId":"prd_b","quantity":"-1"}]}'

# Purchase: create, submit (auto-approves under the threshold), receive part of it
curl -X POST $HOST/api/v1/purchase-orders -H 'content-type: application/json' -H 'idempotency-key: po-123' \
  -d '{"companyId":"cmp_...","branchId":"br_...","warehouseId":"wh_main","vendorId":"ven_...",
       "lines":[{"productId":"prd_...","quantity":"100","unitPrice":"80"}]}'
curl -X POST $HOST/api/v1/purchase-orders/po_.../submit
curl -X POST $HOST/api/v1/purchase-orders/po_.../receive -H 'content-type: application/json' -H 'idempotency-key: grn-po123-1' \
  -d '{"lines":[{"purchaseOrderLineId":"pol_...","quantity":"60"}],"reference":"DC 5521"}'

# Vendor bill for what was received, then post it (three-way match)
curl -X POST $HOST/api/v1/vendor-bills -H 'content-type: application/json' \
  -d '{"companyId":"cmp_...","branchId":"br_...","vendorId":"ven_...","purchaseOrderId":"po_...",
       "vendorInvoiceNumber":"SUP/26/0918","billDate":"2026-10-16",
       "lines":[{"purchaseOrderLineId":"pol_...","quantity":"60"}]}'
curl -X POST $HOST/api/v1/vendor-bills/bill_.../post

# Sales: confirm (reserves), deliver part (issues stock), customer returns 2
curl -X POST $HOST/api/v1/sales-orders/so_.../confirm
curl -X POST $HOST/api/v1/sales-orders/so_.../deliver -H 'content-type: application/json' -H 'idempotency-key: dn-so9-1' \
  -d '{"lines":[{"salesOrderLineId":"sol_...","quantity":"10"}]}'
curl -X POST $HOST/api/v1/stock-entries/dn_.../return -H 'content-type: application/json' \
  -d '{"lines":[{"entryLineId":"sel_...","quantity":"2"}],"reason":"Damaged in transit"}'

# Levels, reorder suggestions, integrity check
curl "$HOST/api/v1/stock/levels?warehouseId=wh_main&lowOnly=true"
curl "$HOST/api/v1/stock/reorder-suggestions?companyId=cmp_..."
curl -X POST $HOST/api/v1/stock/reconcile -H 'content-type: application/json' -d '{"companyId":"cmp_..."}'
```

## Not implemented (by design for now)

- Purchase requisitions: purchase orders are created directly, or from reorder suggestions.
- FIFO / specific-identification costing, landed costs, and the GL postings for stock value
  (those come with the Finance phase).
- Automatic choice of a lot / serial on delivery (FEFO); the user names the lot.
- Re-reserving automatically after a delivery is cancelled.
