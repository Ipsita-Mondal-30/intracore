# Manufacturing and quality

Code: `src/features/manufacturing/` (BOMs, work orders, MRP) and `src/features/quality/` (inspections,
NCRs, suppliers). Endpoints: `docs/api/manufacturing-quality.md`. Stock always moves through the
inventory engine (`docs/INVENTORY.md`); this module never writes balances, reservations' quantities
on consumption, `consumedQty` or `producedQty` itself.

## Bills of materials

- A BOM is a numbered **version** per product: `DRAFT` → `ACTIVE` → `ARCHIVED`. One ACTIVE version
  per product; activating a draft archives the previous one (both under a lock on the product row).
- Lines are editable only while DRAFT. To change an active BOM, `copy` it into a new draft, edit, activate.
- `outputQuantity` units of the product need the line quantities. Quantities are in each product's
  base unit. Product and components must be stock-tracked goods; a product can't list itself.
- Activation refuses circular structures (`CYCLE`): it walks the components' active BOMs and fails
  if any path leads back to the product.

## Work orders

```
DRAFT --release--> RELEASED --start / first issue or receipt--> IN_PROGRESS --complete--> COMPLETED
DRAFT | RELEASED | IN_PROGRESS --cancel--> CANCELLED   (only while nothing is consumed or produced)
```

- **Materials** are a snapshot of the chosen BOM's direct components at creation:
  `requiredQty = line qty × WO qty ÷ outputQuantity × (1 + scrap% ÷ 100)`, rounded **up** to 4 dp.
  Sub-assemblies are made by their own work orders (MRP shows what to make).
- **Release** reserves each material from the order's warehouse up to its open quantity
  (`reserveWorkOrder`), as far as free stock allows. **Shortages do not block release** — the
  response lists `reserved` / `short` per material, the work order page and `GET /mrp` show them,
  and `reserve` tops reservations up after stock arrives. Issuing is still bounded by real stock.
- **Issue** (`PRODUCTION_ISSUE`, from the order's warehouse at moving-average cost). The engine
  adds to `consumedQty` and consumes the material's reservation. This module refuses issuing more
  than `required − consumed` unless `allowOverIssue` (audited). Negative stock and stock reserved for
  other orders are refused by the engine; the whole step rolls back, number included.
- **Receive** (`PRODUCTION_RECEIPT` into the order's warehouse). The engine adds to `producedQty`.
  More than planned needs `allowOverReceipt`. **Complete** needs `producedQty > 0` and releases
  remaining reservations; **cancel** also releases them.
- Material returns: cancel the issue's stock entry (reversing moves; `consumedQty` goes down).

### Costing

```
consumed value = −Σ value of the order's PRODUCTION_ISSUE moves (reversals included)
absorbed value =  Σ value of the order's PRODUCTION_RECEIPT moves
WIP            = consumed − absorbed
receipt unit cost = WIP ÷ max(receipt qty, planned − produced)
```

So a receipt spreads the WIP not yet absorbed over the quantity still to be produced, and a
receipt that reaches (or passes) the planned quantity absorbs all of it. If you receive part of the
order before issuing all materials, early units carry less cost and later ones more; the total
always equals what was consumed (± a paisa of rounding). Materials issued *after* the final
receipt stay in WIP (`costs.wipValue` on the work order) — receive more output or cancel that issue.
Costs never go negative (a WIP below zero after cancelled issues is treated as zero).

### Accounting

With finance enabled (`docs/FINANCE.md`) the engine journals production entries:
issue — Dr Work in progress (1450) / Cr Inventory; receipt — Dr Inventory / Cr Work in progress.
A fully absorbed order nets WIP to zero.

## Material requirements (MRP)

`GET /mrp` with `productId` and `quantity` explodes **multi-level** through ACTIVE BOMs. Each
requirement is netted against available stock (`on hand − reserved`, in the warehouse or
company-wide), shared across the whole tree; the shortage of a component that has its own active BOM
is exploded further (`MAKE`), others must be bought (`BUY`). A cycle (path guard) or more than 25
levels → `422 CYCLE`. Without a product it lists open work-order shortages:
`open − reserved for those orders − free stock`. No scheduling, lead times or incoming POs.

## Quality inspections

- Templates hold checks: BOOLEAN (pass/fail), NUMERIC (`minValue`/`maxValue`), TEXT (recorded only).
  Checks are frozen once a template has inspections (make a new template).
- An inspection is against a **posted goods receipt** (with the product) or a **work order**.
  Results are evaluated; any failed check requires rejecting some quantity (default: all inspected).
  `result` = PASSED / FAILED (all rejected) / PARTIAL.
- Receipts: cumulative inspected quantity per product ≤ received (receipt row locked).
- **Rejected incoming goods:** recorded on the inspection; with `returnRejected: true` a posted
  `PURCHASE_RETURN` is created in the same transaction (at the receipt's cost, from the receipt's
  location, updating the PO line's `returnedQty`). Without it the goods stay in stock — return them
  later from the receipt (`POST /stock-entries/:id/return`) or move them to a quarantine warehouse.
- **Rejected production:** added to `WorkOrder.rejectedQty`; stock is not moved (scrap with an issue).
- Rejections raise an NCR unless `raiseNcr: false`.

## Non-conformances (NCR)

`OPEN → IN_PROGRESS → CLOSED` (`reopen` → IN_PROGRESS). Numbered `NCR-…` per company. Corrective
actions are tasks (`entityType: "nonconformance"`, tasks service) and move an OPEN NCR to
IN_PROGRESS. Closing needs a root cause and every corrective task COMPLETED or CANCELLED.

## Supplier qualification and procurement reporting

- Evaluations score quality / delivery / price 0–100 and may set `Vendor.qualificationStatus`
  (`APPROVED`, `CONDITIONAL`, `PENDING`, `BLOCKED`; audited).
- `BLOCKED` vendors: creating, editing, submitting or approving a purchase order → `422
  VENDOR_NOT_QUALIFIED`. Already-approved orders can still be received.
- `GET /procurement-reports`: per vendor PO count and value, on-time receipt % (receipt posted on or
  before the PO's expected date), average lead time (order date → first receipt), rejection rate
  (rejected ÷ inspected on that vendor's receipts), NCRs, and the latest evaluation.

## Not implemented

Routings / operations, capacity and scheduling, backflushing, by-products, standard costing and
variances, WIP write-off, editing a work order after creation (cancel and recreate), automatic
re-planning, quarantine locations.
