# Analytics, MIS, report builder and exports API

All endpoints are under `/api/v1`, use the session cookie and return `{ ok, data }` /
`{ ok: false, error, code, details? }`. Metric definitions: `docs/METRICS.md`.

## Dashboard

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/analytics?from=&to=&companyId=` | `dashboard.view` (+ each metric's own) | Sections the caller can't see are omitted |
| GET | `/analytics/metrics` | `dashboard.view` | Definitions only (no values) |
| GET | `/mis?companyId=&from=&to=` | `finance.report` | One company; every line has a `source` |

`from`/`to` are `yyyy-mm-dd` (inclusive, UTC). Default period: month to date. `companyId` outside the caller's
scope → 404. `from > to` → 422.

```json
{ "period": { "from": "2026-10-01", "to": "2026-10-16" }, "asOf": "…", "currencies": ["INR"],
  "companies": [{ "id": "…", "code": "HO", "name": "…", "currency": "INR" }],
  "sections": [{ "key": "sales", "label": "Sales and quotations", "metrics": [
    { "key": "sales.invoiced_value", "label": "Invoiced (taxable value)", "unit": "money",
      "value": { "INR": "125000.00" }, "definition": "…", "statusInclusion": "…",
      "dateField": "sales_invoices.invoiceDate", "aggregation": "sum(taxableTotal)", "currency": "…", "permissions": ["invoice.view"] } ] } ] }
```

## Report builder

| Method | Path | Permission |
|---|---|---|
| GET | `/reports/catalog` | `report.build`; lists only entities the caller can read |
| POST | `/reports/run` | `report.build` + the entity's permission |
| GET | `/saved-reports?q=&entity=&page=` | own reports + shared reports whose entity the caller can read |
| POST | `/saved-reports` `{ name, definition, isShared? }` | `report.build` + entity permission (409 on duplicate name) |
| GET / PATCH / DELETE | `/saved-reports/:id` | GET: visible; PATCH/DELETE: `report.build` and creator only (403 otherwise) |
| POST | `/saved-reports/:id/run` | visible to the caller (entity permission); runs with the caller's own scope |

Definition (anything outside the catalog → **422 VALIDATION_ERROR**; unknown properties are rejected):

```json
{
  "entity": "sales_invoices",
  "columns": ["number", "customer", "grandTotal"],
  "filters": [
    { "field": "status", "op": "eq", "value": "POSTED" },
    { "field": "invoiceDate", "op": "between", "value": ["2026-04-01", "2026-09-30"] },
    { "field": "customer", "op": "contains", "value": "acme" }
  ],
  "groupBy": [],
  "aggregates": [],
  "sort": [{ "field": "grandTotal", "dir": "desc" }],
  "limit": 200
}
```

- **Entities:** `customers`, `leads`, `quotations`, `sales_orders`, `sales_invoices`, `purchase_orders`,
  `vendor_bills`, `stock_balances`, `expense_claims`, `tickets`, `employees` (non-sensitive fields only),
  `time_entries`. Each has a fixed permission and scope rule (`GET /reports/catalog` shows both).
- **Operators by type:** string `eq neq in contains is_null`; enum `eq neq in is_null`;
  number/money `eq neq gt gte lt lte between in is_null`; date `eq gt gte lt lte between is_null`.
  `in` takes 1–100 values, `between` exactly two, `is_null` `true`/`false`.
- **Grouping:** up to 3 `groupBy` fields (string/enum/date); `aggregates` `count` (optionally on a field),
  `sum`/`avg` (number, money), `min`/`max` (number, money, date). When grouping, `columns` must be empty or a
  subset of `groupBy`. Aggregate outputs are named `fn_field` (or `count`) and may be sorted on.
- **Limits:** `limit` 1–1000 (default 200); the response says `truncated: true` when more rows exist.
  Queries run with `statement_timeout = 5s`; exceeding it → **422 QUERY_TIMEOUT**.
- **Safety:** SQL is assembled only from catalog constants; every user value is a bound parameter and output
  columns are aliased `c0…cn`. Tenant, company/branch and module visibility filters are always applied.

Response: `{ entity, columns: [{ key, label, type }], rows: [{ key: value }], rowCount, limit, truncated }`.
Money is a 2-dp string, numbers are strings, dates `yyyy-mm-dd`.

## Exports

| Method | Path | Permission |
|---|---|---|
| POST | `/data-exports` `{ definition }` or `{ savedReportId }` | `data.export` + the entity's permission → 201 PENDING |
| GET | `/data-exports` | `data.export`; the caller's own exports |
| GET | `/data-exports/:id` | requester only |
| GET | `/data-exports/:id/download` | requester only, still holding `data.export` + entity permission → `{ url, expiresAt, fileName }` (60 s signed URL) |

- Generation runs in the background queue (`export.generate`, key `export.generate:<id>`). It rebuilds the
  requester's access context **at generation time**; a removed member or revoked permission marks the export
  `FAILED` without writing a file. Rows are produced by the same builder (≤ 50 000 rows, 20 s timeout).
- CSV: RFC 4180 quoting, CRLF line ends; text cells starting with `= + - @`, tab or CR are prefixed with `'`
  (spreadsheet formula injection).
- Files: private `documents` bucket, `exports/<org>/<id>.csv`, `expiresAt` = completion + 7 days; an expired
  export answers **410 EXPIRED**. Statuses: `PENDING → RUNNING → COMPLETED | FAILED`, `EXPIRED`.
- Re-running a completed or failed export is a no-op; transient upload errors are retried by the queue and the
  export is marked FAILED after the last attempt.
- Other members (including other `data.export` holders) get 404 on someone else's export, because their
  company scope and permissions may differ from the requester's.
