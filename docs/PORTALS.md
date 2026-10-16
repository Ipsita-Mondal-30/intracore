# External portals

Separate, permission-restricted experiences for customers, dealers, suppliers, employees and
service technicians. Code: `src/features/portal/*` (services), `src/app/api/portal/**` (portal API),
`src/app/portal/**` (portal UI), `src/app/api/v1/portal-*` + `/settings/portal-users` (internal admin).
Tests: `tests/portals.db.test.ts`.

## Identity model

- A **PortalAccount** `(organizationId, userId, kind)` links a login (Supabase user → `User`) to
  exactly one party in one organization:

  | kind | party | scope of every query |
  |---|---|---|
  | CUSTOMER | `customerId` | `customerId = account.customerId` |
  | DEALER | `customerId` (customer must have `isDealer`) | same, plus the dealer's `CustomerPrice` rows |
  | VENDOR | `vendorId` | `vendorId = account.vendorId` |
  | EMPLOYEE | `employeeId` | `employeeId = account.employeeId`; tasks by `assignedUserId/assigneeId = userId` |
  | TECHNICIAN | none (the user) | `technicianId = userId` |

- `getPortalContext(kind, org?)` (`features/portal/context.ts`) is the only authorization:
  signed out → 401; no ACTIVE account of that kind → 403; SUSPENDED → 403; a DEALER whose customer
  lost `isDealer`, or an inactive customer → 403. It **never builds an internal AccessContext and
  never calls `assertCan`**, so a portal identity cannot inherit internal role permissions, and an
  internal member using a portal sees only portal data.
- A portal-only user has no `OrganizationMember`, so every `/api/v1/*` call fails with 403
  (`NO_ORGANIZATION`) and the `(app)` layout redirects them to `/portal`.
- Records outside the account's party answer **404** (never 403), including other customers'
  documents, other tenants' ids and hidden states (drafts).
- Several organizations: the user picks one at `/portal` (`/api/portal/select-org` stores the
  `portalOrg` cookie). `?portalOrg=<id>` on an API call is strict (no account there → 403); the
  cookie is only a hint used to disambiguate.

## Invitations

`POST /api/v1/portal-invitations` (permission `portal.manage`):

- party validated in the tenant per kind: CUSTOMER/DEALER need an active customer (DEALER: `isDealer`),
  VENDOR a vendor, EMPLOYEE a non-exited employee (if the employee already has a login, the invite
  email must be that login's), TECHNICIAN needs the email to belong to an **active member** of the
  organization, because visits/jobs are assigned to member user ids (`assertTechnician`).
- 32 random bytes (base64url) token; only `sha256(token)` is stored. The accept URL is returned
  to the admin once and emailed when email is configured (`emailSent`). Inviting the same
  email + kind again revokes the earlier pending invitation. Expires after 7 days.
- Accept (`/portal/accept?token=…` → `POST /api/portal/accept`): signed-in user, email equal to the
  invited email (case-insensitive), token not expired / revoked / used. Creates the PortalAccount
  (upsert on `(org, user, kind)`) and marks the invitation accepted. Single use: the same user
  re-accepting gets the same account (`alreadyAccepted: true`); anyone else → 422 `INVITATION_USED`.
  The party link is re-checked at accept time.
- Admins list/revoke invitations and suspend/reactivate accounts at `/settings/portal-users`.

## What each portal can see and do (field whitelists)

Every service uses an explicit Prisma `select`. Never selected anywhere: internal `notes`,
approval notes/reasons, `createdBy`/`approvedBy`, journal ids, bank accounts, cost
(`purchasePrice`, `unitCost`, valuation), list prices, other parties' rows, INTERNAL ticket messages,
assignee/technician identities, SLA internals, exit reasons, salary structures.

### Customer (and dealer, for its own customer)
- **Quotations** (not DRAFT / PENDING_APPROVAL): number, revision, status, dates, totals, company
  name, terms, lines (description, product sku/name/HSN, qty, unit, rate, discount %, GST rate and
  split, taxable, line total), linked order number.
- **Sales orders** (not DRAFT): number, status, dates, customer PO, shipping address, delivery
  instructions, totals, lines incl. delivered / returned / invoiced qty.
- **Invoices** (POSTED only): number, dates, GSTINs, addresses, totals with CGST/SGST/IGST,
  paid, credited, **outstanding**, terms, IRN, lines, settlements (receipt / credit note numbers).
- **Payments** (POSTED receipts): number, date, amount, method, reference, invoices settled.
- **Tickets**: list/open (source PORTAL, status NEW, SLA from the priority policy; asset must be
  the customer's; company chosen or the default company; `createdById` left null, the audit log
  records the portal user), PUBLIC messages only, reply (always `authorType CUSTOMER`,
  `visibility PUBLIC`; not on CLOSED/CANCELLED), feedback once after RESOLVED/CLOSED.
  Ticket fields: number, subject, description, priority, status, dates, resolution code,
  feedback, asset tag/name, category name. Resolution notes stay internal.
- **Assets & warranty**: tag, name, serial, location, status, install date, product, warranties
  (type, period, parts/labour cover, terms), `underWarranty`. Asset value/geo/assignee stay internal.
- **Contracts** (not DRAFT): number, status, period, value, terms, covered assets, entitlements used.
- **Service history**: COMPLETED visits on the customer's assets/tickets/contracts — service type,
  dates, `workDone`, `customerSignedBy`. The technician's own `notes` and identity stay internal.

### Dealer (additionally)
- **Authorized catalog** = the dealer's `CustomerPrice` rows for active products: sku, name,
  description, HSN, unit, GST rate, the dealer's price.
- **Order request**: product + quantity lines only (authorized products only; price, discount
  and tax are server-side). Creates a **DRAFT quotation** priced by `priceLines` (dealer price,
  product tax, GST split from branch vs dealer state), branch = the company's first active branch,
  `notes` starting "Portal request" (+ dealer PO / remarks), `createdById` = portal user. Staff
  review it like any draft. The dealer sees its own requests (incl. drafts) under "Your requests".

### Vendor
- **Purchase orders** approved or later (DRAFT, PENDING_APPROVAL and cancelled-before-approval are
  hidden): number, status, dates, company, delivery warehouse name, totals, lines with
  received / returned / billed qty.
- **Goods receipts / purchase returns** (POSTED, against the vendor's POs): number, type, date,
  reference, PO, product, quantity, unit, lot/expiry. Never `unitCost` or valuation.
- **Bills**: own vendor's bills (DRAFT = under review, POSTED = accepted) with total, paid,
  debited, outstanding (posted only). **Payments**: POSTED vendor payments and bills settled.
- **Submit invoice**: against one of its issued POs; lines are PO lines + quantity (+ optional
  rate). Creates a **DRAFT vendor bill** (same pricing as `createVendorBill`, notes "Submitted via
  vendor portal", `createdById` = portal user); the three-way match runs when staff post it. A
  repeated vendor invoice number → 409. Attachments are not supported yet (the documents service
  needs an internal context).

### Employee
- **Profile**: employee no., name, work email, phone, type, status, joining/confirmation dates,
  company, branch, department, designation, manager name, shift. No exit reason, DOB or salary structure.
- **Attendance**: own records; self check-in / check-out for today (org timezone), same rules as
  `hr/attendance.ts punch()`.
- **Leave**: balances (available = opening + accrued + adjusted − used − pending), active types of
  the employee's company, own requests, apply (same day counting via `countLeaveDays`, overlap and
  balance rules as `applyLeave`; manager notified), cancel (PENDING, or APPROVED before it starts).
- **Payslips**: own, from APPROVED payroll runs only (period, days, gross, deductions, net, lines).
- **Tasks**: `Task.assignedUserId` and `ProjectTask.assigneeId` = the portal user (read-only).

### Technician
- Visits and installation jobs where `technicianId` = the user: schedule, status, service type,
  visit notes, equipment (tag, name, serial, location), ticket number/subject/description,
  customer name + phone, site address, checklist.
- Start / complete visits (notes required) and installation jobs (required checklist items
  first), tick checklist items. Same state rules as `service/field.ts` and
  `service/installations.ts`; rescheduling and cancelling stay internal.

## Implementation notes

- Portal writes that the internal services implement with an `AccessContext` (leave apply/cancel,
  check-in/out, visit/installation transitions, ticket create/reply/feedback, draft quotation,
  draft vendor bill) are re-implemented in `features/portal/*` with the same validations, row
  locks and audit entries (`via: "portal"`), reusing exported pure helpers (`priceLines`,
  `countLeaveDays`, `localParts`, `resolveSlaPolicy`, `slaDueDates`). Keep them in step when the
  internal rules change.
- Portal POSTs accept an `Idempotency-Key` (same store as `/api/v1`).
- Signed-out users opening `/portal/accept?token=…` are redirected to `/login` by the middleware
  without the token, and login always lands on `/dashboard` → `/portal`; they must reopen the link
  after signing in (see "shared changes" in the Phase 7 report).
