# Portal API

See `docs/PORTALS.md` for the identity model and field whitelists. Envelope as `/api/v1`:
`{ ok: true, data }` / `{ ok: false, error, code, details? }`. Lists take `page`, `pageSize`,
`sort`, `dir` (`listQuerySchema`).

## Internal administration (`/api/v1`, permission `portal.manage`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/portal-invitations` | Latest 200; each has `state` PENDING / ACCEPTED / REVOKED / EXPIRED. Never returns the token or its hash. |
| POST | `/api/v1/portal-invitations` | `{ email, kind, customerId? , vendorId?, employeeId? }` → 201 `{ invitation, acceptUrl, emailSent }`. `acceptUrl` is shown once. 404 party not in tenant, 422 wrong party for kind / not a dealer / technician not a member, 409 account already exists. |
| POST | `/api/v1/portal-invitations/:id/revoke` | 422 if already accepted; idempotent if already revoked. |
| GET | `/api/v1/portal-accounts?kind=&status=` | Accounts with user email/name and linked party name. |
| POST | `/api/v1/portal-accounts/:id/suspend` \| `/reactivate` | 404 outside the tenant. |

## Accept and organization choice

| Method | Path | Notes |
|---|---|---|
| POST | `/api/portal/accept` | `{ token }`, signed in. 401 signed out, 404 `INVALID_TOKEN`, 403 `EMAIL_MISMATCH`, 422 `INVITATION_REVOKED` / `INVITATION_EXPIRED` / `INVITATION_USED`. → `{ account, alreadyAccepted }`. |
| GET | `/api/portal/select-org?organizationId=&next=/portal/…` | Sets the `portalOrg` cookie and redirects (only to `/portal…`). Grants nothing. |

## Portal endpoints

All: 401 signed out, 403 no ACTIVE account of the kind (or suspended), 404 for records outside the
account's party. Multi-organization users pass `?portalOrg=<organizationId>` (strict) or rely on the cookie.

### Customer and dealer — `/api/portal/{customer|dealer}/…`

| Method | Path | Notes |
|---|---|---|
| GET | `quotations`, `quotations/:id` | Not DRAFT / PENDING_APPROVAL. `?status=` |
| GET | `orders`, `orders/:id` | Not DRAFT |
| GET | `invoices`, `invoices/:id` | POSTED only, with `outstanding` |
| GET | `payments` | POSTED receipts with settled invoices |
| GET | `tickets`, `tickets/:id` | `?status=`; detail has PUBLIC messages only |
| POST | `tickets` | `{ subject, description?, priority? LOW/MEDIUM/HIGH, companyId?, assetId?, categoryId? }` → 201 `{ id, number, status }` |
| POST | `tickets/:id/reply` | `{ body }` → public CUSTOMER message; 422 on CLOSED/CANCELLED |
| POST | `tickets/:id/feedback` | `{ rating 1–5, comment? }`; only RESOLVED/CLOSED, once |
| GET | `assets` | With warranties and `underWarranty` |
| GET | `contracts` | Not DRAFT, with assets and entitlements |
| GET | `service-history` | Completed visits (customer-facing fields) |
| GET | `catalog` | **dealer only** (404 on customer): authorized products and dealer prices |
| GET | `order-requests` | **dealer only**: own requests incl. drafts |
| POST | `order-requests` | **dealer only**: `{ lines: [{ productId, quantity }], customerPoNumber?, remarks?, companyId? }` → 201 DRAFT quotation; 422 for unauthorized products |

### Vendor — `/api/portal/vendor/…`

| Method | Path | Notes |
|---|---|---|
| GET | `purchase-orders`, `purchase-orders/:id` | Approved or later |
| GET | `receipts` | `?purchaseOrderId=`; posted GRNs / purchase returns, quantities only |
| GET | `bills` | Own bills with `outstanding` (posted) |
| POST | `bills` | Submit invoice `{ purchaseOrderId, vendorInvoiceNumber, billDate, dueDate?, remarks?, lines: [{ purchaseOrderLineId, quantity, unitPrice? }] }` → 201 DRAFT bill; 409 duplicate invoice number; 404 PO not the vendor's |
| GET | `payments` | Posted payments with settled bills |

### Employee — `/api/portal/employee/…`

| Method | Path | Notes |
|---|---|---|
| GET | `profile` | Own, non-sensitive fields |
| GET | `attendance` | `?from=&to=` |
| POST | `attendance/check-in` \| `attendance/check-out` | Today, org timezone; 422 if repeated / out before in |
| GET | `leave/balances?year=` | With `available` |
| GET | `leave/types` | Active types of the employee's company |
| GET | `leave/requests` | `?status=` |
| POST | `leave/requests` | `{ leaveTypeId, startDate, endDate, halfDayStart?, halfDayEnd?, reason? }` → 201; 422 `OVERLAP` / `INSUFFICIENT_BALANCE` |
| POST | `leave/requests/:id/cancel` | `{ reason? }`; PENDING, or APPROVED before start |
| GET | `payslips`, `payslips/:id` | APPROVED runs only |
| GET | `tasks` | `{ tasks, projectTasks }` assigned to the user |

### Technician — `/api/portal/technician/…`

| Method | Path | Notes |
|---|---|---|
| GET | `jobs?open=true\|false` | `{ visits, installations }` assigned to the user (default: open only) |
| GET | `visits/:id` | |
| POST | `visits/:id/start` \| `visits/:id/complete` | complete: `{ notes, workDone?, customerSignedBy? }` |
| GET | `installations/:id` | With checklist |
| POST | `installations/:id/start` \| `installations/:id/complete` | complete: `{ notes? }`; 422 `CHECKLIST_INCOMPLETE` |
| PATCH | `installations/:id/checklist/:itemId` | `{ done, note? }` |
