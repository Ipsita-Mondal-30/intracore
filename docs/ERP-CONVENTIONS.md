# ERP module conventions

How every ERP module in this repo is built. Follow these rules exactly when adding a module.

## Layout

| Path | Contents |
|---|---|
| `src/features/<module>/*.ts` | Services: business rules, validation, authorization, transactions, audit |
| `src/app/api/v1/<resource>/.../route.ts` | Thin REST handlers that call services |
| `src/app/(app)/<area>/...` | Server-rendered pages: read via services, write via the REST API |
| `src/lib/*` | Shared infrastructure (access, api, audit, numbering, money, settings, storage, jobs) |
| `tests/<module>.db.test.ts` | Database tests against the local Postgres (never production) |
| `prisma/schema.prisma` + `prisma/migrations/*` | Schema and migrations, owned by the lead developer (one migration per phase) |

## Services

```ts
export async function doThing(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "module.action");               // 1. permission, deny by default
  const data = schema.parse(input);              // 2. zod validation → 422 VALIDATION_ERROR
  return prisma.$transaction(async (tx) => {     // 3. one transaction per command
    const row = await lockRow(tx, ctx, id);      // 4. SELECT … FOR UPDATE for state changes
    assertCompanyAccess(ctx, row.companyId, row.branchId); // 5. company/branch scope → 404
    if (row.status !== "X") throw new AppError("INVALID_STATE", "…", 422);
    const updated = await tx.thing.update(…);
    await audit(tx, ctx, { action: "thing.done", entity: "thing", entityId: id, companyId: row.companyId, previous, next });
    return updated;
  });
}
```

### Access and scope
- `AccessContext` (from `getAccessContext()`, or `buildAccessContext(userId, orgId)` in tests).
- `assertCan(ctx, code)` / `can(ctx, code)` check permission codes. Codes are `module.action`;
  register new ones in `src/lib/permissions/catalog.ts` and add them to the relevant system role templates.
- **Org-level master data** (customers, vendors, products, employees …) is filtered by
  `organizationId: ctx.organizationId`.
- **Company/branch-scoped data** is filtered with `companyScopeWhere(ctx)` in lists and checked
  with `assertCompanyAccess(ctx, companyId, branchId)` on single records. Out-of-scope ids answer
  **404, never 403**.

### Never trust client ids
- Every referenced id must belong to the tenant. Prefer composite FKs
  `(organizationId, xId) → X(organizationId, id)` so the database enforces it.
- Use `assertActiveMember` for user ids, and `resolveEntity` for polymorphic `entityType/entityId`.

### State and records
- **State machines:** explicit transition tables; invalid transitions → `422 INVALID_STATE`.
  Transitions lock the row first.
- **Retry safety:** posting-type operations return the existing result when already done.
  Natural uniqueness (`@@unique`) backs this up, and the API's `Idempotency-Key` replays responses.

### Values and numbering
- **Money and quantities:** `Decimal` columns. Parse with `zDecimal()`, compute with
  `Prisma.Decimal` (`src/lib/money.ts`), and return decimal strings. Never use JS floats for amounts.
- **Numbering:** `nextDocumentNumber(tx, orgId, companyId, type, date)` inside the creating
  transaction. Add a prefix to `DOCUMENT_PREFIXES`; use `{FY}` for per-fiscal-year counters.
- **Settings:** typed JSON via `src/lib/settings.ts`. Add keys with defaults; no data migration is needed.

### Side effects
- **Accounting:** only `postJournal` / `reverseJournal` in `features/finance/ledger.ts`.
  Gate journals with `isJournaled(tx, companyId, date)`.
- **Stock:** only stock entries (`features/inventory/entries.ts`) move stock.
- **Notifications:** `createSystemNotification(...)`.
- **Tasks:** `features/tasks/service.ts`.
- **Files:** `features/documents/service.ts`, plus `resolveEntity` registrations in `src/lib/entities.ts`.
- **Jobs:** add to `JOBS` in `src/lib/jobs.ts`. Jobs must be idempotent: claim rows with a
  conditional `updateMany` before acting, so overlapping runs never duplicate work.

## API routes

```ts
export const GET = api((ctx, { query }) => listThings(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createThing(ctx, body), { status: 201, idempotent: true });
// actions: /things/:id/[action]/route.ts dispatching on params.action, 404 for unknown actions
```

- Responses are `{ ok, data }` or `{ ok:false, error, code, details? }`; the `api()` wrapper
  maps AppError, ZodError and Prisma errors.
- Lists use `listQuerySchema` + `listArgs` (sort whitelist) + `paginate`.
- Document every endpoint in `docs/API.md`.

## Tests

```ts
vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() })); // for route tests
const a = await createOrg("Name");          // tests/helpers/fixtures.ts: roles, company, branch, warehouse, catalog
const member = await a.addMember("role_code", [{ companyId, branchId? }]);
const ctx = await a.ctx(member.userId);     // build AccessContext directly for service tests
await signInAs(userId); await call(route.POST, { method: "POST", body, headers }); // route tests
afterAll(cleanupFixtures);
```

- Cover:
  - permission denial (403);
  - cross-tenant and cross-company access (404);
  - validation (422);
  - invalid transitions;
  - retries / idempotency;
  - rollback (nothing persisted after a failure);
  - every money or quantity rule.
- Run a single file with `npx vitest run tests/<file>.db.test.ts`.
- **Never** run `scripts/reset-test-db.sh` while other people or agents are running tests.

## UI

- **Server pages:** `const ctx = await getAccessContext()`, read via services, gate controls with `can()`.
- **Writes** go only through `ApiForm`, `ActionButton` or `apiFetch` (`src/components/erp/*`,
  `src/lib/api/client.ts`). No server actions in ERP modules.
- Lists use `ListToolbar` + `Pagination` + `RecordsTable`; documents use `DocumentLines` /
  `DocumentTotals` / `AuditTrail`.
- Pass Prisma Decimals to client components as strings.
