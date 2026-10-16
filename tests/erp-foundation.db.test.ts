import { createHmac } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { encrypt } from "@/lib/crypto/encryption";
import { assertCompanyAccess, companyScopeWhere } from "@/lib/access";
import { withIdempotency } from "@/lib/api/idempotency";
import { nextDocumentNumber } from "@/lib/numbering";
import { resolveEntity } from "@/lib/entities";
import { assertLeadRefs } from "@/lib/tenant/refs";
import {
  createBranch,
  createCompany,
  listCompanies,
  setMemberScopes,
  updateCompany,
  updateNumberSequence,
} from "@/features/companies/service";
import { createTask, listTasks, processDueTaskReminders, updateTask } from "@/features/tasks/service";
import { listAuditLogs } from "@/features/audit/service";
import * as companiesRoute from "@/app/api/v1/companies/route";
import * as tasksRoute from "@/app/api/v1/tasks/route";
import * as jobsRoute from "@/app/api/v1/jobs/run/route";
import * as webhookRoute from "@/app/api/integrations/[provider]/webhook/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: () => unknown) => fn,
}));

let a: OrgFixture;
let b: OrgFixture;

beforeAll(async () => {
  a = await createOrg("Acme");
  b = await createOrg("Beta");
});
afterAll(cleanupFixtures);

describe("authentication and authorization", () => {
  it("rejects unauthenticated API calls with 401", async () => {
    await signInAs(null);
    const res = await call(companiesRoute.GET);
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  });

  it("serves an authenticated member their scoped companies", async () => {
    await signInAs(a.ownerId);
    const res = await call(companiesRoute.GET);
    expect(res.status).toBe(200);
    expect(res.json.data.map((c: { id: string }) => c.id)).toEqual([a.company.id]);
  });

  it("denies roles without the permission (403)", async () => {
    const viewer = await a.addMember("viewer");
    await signInAs(viewer.userId);
    const res = await call(companiesRoute.POST, { method: "POST", body: { code: "NEW", name: "New Co" } });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("FORBIDDEN");
  });

  it("maps validation failures to 422 with field details", async () => {
    await signInAs(a.ownerId);
    const res = await call(companiesRoute.POST, {
      method: "POST",
      body: { code: "GST", name: "Bad GST", gstin: "NOT-A-GSTIN" },
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("VALIDATION_ERROR");
    expect(res.json.details[0].path).toBe("gstin");
  });

  it("rejects a GSTIN that contradicts the PAN or state code", async () => {
    const ctx = await a.ctx(a.ownerId);
    await expect(
      createCompany(ctx, { code: "KA", name: "KA", pan: "AAAAA1111A", stateCode: "29", gstin: "27BBBBB2222B1Z5" }),
    ).rejects.toThrow(/state code/);
  });
});

describe("company and branch scoping", () => {
  it("hides other tenants' and unscoped companies (404, not 403)", async () => {
    const ownerCtx = await a.ctx(a.ownerId);
    const second = await createCompany(ownerCtx, { code: "SECOND", name: "Second Co" });
    const member = await a.addMember("admin"); // scoped to default company only
    const ctx = await a.ctx(member.userId);

    expect((await listCompanies(ctx)).map((c) => c.id)).toEqual([a.company.id]);
    await expect(updateCompany(ctx, second.id, { name: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(updateCompany(ctx, b.company.id, { name: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("limits branch-scoped members to their branches", async () => {
    const ownerCtx = await a.ctx(a.ownerId);
    const b2 = await createBranch(ownerCtx, a.company.id, { code: "BLR", name: "Bengaluru" });
    const member = await a.addMember("admin", [{ companyId: a.company.id, branchId: a.branch.id }]);
    const ctx = await a.ctx(member.userId);

    expect(() => assertCompanyAccess(ctx, a.company.id, a.branch.id)).not.toThrow();
    expect(() => assertCompanyAccess(ctx, a.company.id, b2.id)).toThrow(/Branch not found/);
    expect(() => assertCompanyAccess(ctx, a.company.id)).toThrow(/branch you have access to/);
    await expect(resolveEntity(ctx, "branch", b2.id)).rejects.toMatchObject({ status: 404 });
    // Branch admins cannot create branches or edit the company.
    await expect(createBranch(ctx, a.company.id, { code: "X", name: "X" })).rejects.toMatchObject({ status: 404 });

    expect(companyScopeWhere(ctx).OR).toEqual([
      { companyId: a.company.id, branchId: { in: [a.branch.id] } },
    ]);
  });

  it("does not let admins grant companies they do not hold", async () => {
    const ownerCtx = await a.ctx(a.ownerId);
    const restricted = await createCompany(ownerCtx, { code: "RESTRICTED", name: "Restricted" });
    const admin = await a.addMember("admin");
    const target = await a.addMember("viewer");
    const ctx = await a.ctx(admin.userId);
    await expect(
      setMemberScopes(ctx, target.memberId, { scopes: [{ companyId: restricted.id }] }),
    ).rejects.toMatchObject({ status: 404 });
    // A branch from another company is rejected by the composite foreign key.
    await expect(
      setMemberScopes(ownerCtx, target.memberId, { scopes: [{ companyId: a.company.id, branchId: b.branch.id }] }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects client-supplied lead references from another tenant", async () => {
    const foreignStage = await prisma.leadStage.findFirstOrThrow({ where: { organizationId: b.org.id } });
    await expect(assertLeadRefs(a.org.id, { stageId: foreignStage.id })).rejects.toMatchObject({
      code: "INVALID_REFERENCE",
    });
    await expect(assertLeadRefs(a.org.id, { assignedUserId: b.ownerId })).rejects.toMatchObject({
      code: "INVALID_REFERENCE",
    });
  });
});

describe("audit trail", () => {
  it("records actor, action, entity and only the changed fields", async () => {
    const ctx = await a.ctx(a.ownerId);
    const company = await createCompany(ctx, { code: "AUD", name: "Audited" });
    // Each request builds a fresh context; the new company is visible from the next one.
    await updateCompany(await a.ctx(a.ownerId), company.id, { name: "Audited Ltd", legalName: null });

    const logs = await prisma.auditLog.findMany({
      where: { entity: "company", entityId: company.id },
      orderBy: { createdAt: "asc" },
    });
    expect(logs.map((l) => l.action)).toEqual(["company.created", "company.updated"]);
    expect(logs[1]).toMatchObject({
      userId: a.ownerId,
      organizationId: a.org.id,
      companyId: company.id,
      previous: { name: "Audited" },
      next: { name: "Audited Ltd" },
    });

    const page = await listAuditLogs(await a.ctx(a.ownerId), { entity: "company", entityId: company.id });
    expect(page.total).toBe(2);
  });

  it("validates and merges company settings, auditing the change", async () => {
    const ctx = await a.ctx(a.ownerId);
    const updated = await updateCompany(ctx, a.company.id, { settings: { inventory: { allowNegativeStock: true } } });
    expect(updated.settings).toMatchObject({
      inventory: { allowNegativeStock: true },
      quotation: { approvalDiscountPercent: 10 },
    });
    await expect(
      updateCompany(ctx, a.company.id, { settings: { quotation: { approvalDiscountPercent: 150 } } }),
    ).rejects.toThrow();
    await updateCompany(ctx, a.company.id, { settings: { inventory: { allowNegativeStock: false } } });
  });
});

describe("transactions", () => {
  it("rolls back every write when a later step fails", async () => {
    const ctx = await a.ctx(a.ownerId);
    const before = await prisma.auditLog.count({ where: { organizationId: a.org.id } });
    // Duplicate company code fails the insert; nothing else may persist.
    await expect(createCompany(ctx, { code: "MAIN", name: "Dup" })).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id } })).toBe(before);
  });

  it("keeps document numbers gapless across a rollback", async () => {
    const take = () =>
      prisma.$transaction((tx) => nextDocumentNumber(tx, a.org.id, a.company.id, "quotation"));
    const first = await take();
    await expect(
      prisma.$transaction(async (tx) => {
        await nextDocumentNumber(tx, a.org.id, a.company.id, "quotation");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const second = await take();
    expect(Number(second.slice(3))).toBe(Number(first.slice(3)) + 1);
  });

  it("only lets the number sequence move forward", async () => {
    const ctx = await a.ctx(a.ownerId);
    await updateNumberSequence(ctx, a.company.id, "sales_order", { prefix: "ACME/SO/", nextNumber: 100 });
    const number = await prisma.$transaction((tx) => nextDocumentNumber(tx, a.org.id, a.company.id, "sales_order"));
    expect(number).toBe("ACME/SO/00100");
    await expect(
      updateNumberSequence(ctx, a.company.id, "sales_order", { nextNumber: 5 }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("idempotency", () => {
  it("replays the stored response for a retried request", async () => {
    await signInAs(a.ownerId);
    const send = (title: string) =>
      call(tasksRoute.POST, { method: "POST", body: { title }, headers: { "idempotency-key": "retry-1" } });

    const first = await send("Call the bank");
    const retry = await send("Call the bank");
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.json.data.id).toBe(first.json.data.id);
    expect(await prisma.task.count({ where: { organizationId: a.org.id, title: "Call the bank" } })).toBe(1);

    const reused = await send("Something else");
    expect(reused.status).toBe(422);
    expect(reused.json.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects a concurrent retry while the first attempt runs, and frees the key on failure", async () => {
    const ctx = { organizationId: a.org.id, userId: a.ownerId };
    let release!: () => void;
    const slow = withIdempotency(ctx, "concurrent-1", "{}", () =>
      new Promise((resolve) => (release = () => resolve({ status: 200, body: { ok: true } }))),
    );
    await new Promise((r) => setTimeout(r, 50));
    await expect(
      withIdempotency(ctx, "concurrent-1", "{}", async () => ({ status: 200, body: {} })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS" });
    release();
    await slow;

    await expect(
      withIdempotency(ctx, "fails-1", "{}", async () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow("transient");
    const retried = await withIdempotency(ctx, "fails-1", "{}", async () => ({ status: 200, body: { ok: 1 } }));
    expect(retried.replayed).toBeUndefined();
  });
});

describe("tasks: pagination, filtering, visibility, reminders", () => {
  it("paginates, sorts, filters and searches", async () => {
    const ctx = await a.ctx(a.ownerId);
    for (let i = 1; i <= 12; i++) {
      await createTask(ctx, { title: `Paged task ${String(i).padStart(2, "0")}`, priority: i % 2 ? "HIGH" : "LOW" });
    }
    const page2 = await listTasks(ctx, { q: "Paged task", page: "2", pageSize: "5", sort: "title", dir: "asc" });
    expect(page2.total).toBe(12);
    expect(page2.items.map((t) => t.title)).toEqual([6, 7, 8, 9, 10].map((n) => `Paged task ${String(n).padStart(2, "0")}`));

    const high = await listTasks(ctx, { q: "Paged task", pageSize: "100", status: "PENDING" });
    expect(high.items.every((t) => t.status === "PENDING")).toBe(true);
    await expect(listTasks(ctx, { sort: "secret" })).rejects.toThrow(/sort must be one of/);
    await expect(listTasks(ctx, { pageSize: "500" })).rejects.toThrow();
  });

  it("shows members only their own tasks without task.view_all", async () => {
    const exec = await a.addMember("viewer");
    const ownerCtx = await a.ctx(a.ownerId);
    await createTask(ownerCtx, { title: "Owner private" });
    await createTask(ownerCtx, { title: "For the viewer", assignedUserId: exec.userId });
    const ctx = await a.ctx(exec.userId);
    const mine = await listTasks(ctx, { pageSize: "100" });
    expect(mine.items.map((t) => t.title)).toEqual(["For the viewer"]);
    // Viewers lack task.create, but may complete tasks assigned to them.
    const done = await updateTask(ctx, mine.items[0].id, { status: "COMPLETED" });
    expect(done.completedAt).toBeInstanceOf(Date);
    await expect(createTask(ctx, { title: "nope" })).rejects.toMatchObject({ status: 403 });
  });

  it("refuses tasks on records the caller cannot reach", async () => {
    const ctx = await a.ctx(a.ownerId);
    await expect(
      createTask(ctx, { title: "x", entityType: "company", entityId: b.company.id }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(createTask(ctx, { title: "x", assignedUserId: b.ownerId })).rejects.toMatchObject({
      code: "INVALID_REFERENCE",
    });
  });

  it("sends each due reminder exactly once", async () => {
    const ctx = await a.ctx(a.ownerId);
    const task = await createTask(ctx, { title: "Remind me", remindAt: new Date(Date.now() - 60_000) });
    const first = await processDueTaskReminders();
    const second = await processDueTaskReminders();
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect(second.sent).toBe(0);
    const notes = await prisma.notification.findMany({
      where: { userId: a.ownerId, type: "task.reminder", title: "Reminder: Remind me" },
    });
    expect(notes).toHaveLength(1);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).remindedAt).not.toBeNull();
  });
});

describe("protected endpoints", () => {
  it("requires the cron secret to run jobs", async () => {
    const denied = await call(jobsRoute.POST, { method: "POST" });
    expect(denied.status).toBe(401);
    const ran = await call(jobsRoute.POST, {
      method: "POST",
      query: "job=idempotency-cleanup",
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    expect(ran.status).toBe(200);
    expect(ran.json.data["idempotency-cleanup"].ok).toBe(true);
  });

  it("accepts integration webhooks only with a valid signature", async () => {
    const secret = "whsec_test";
    await prisma.integration.create({
      data: { organizationId: a.org.id, provider: "website", status: "CONNECTED", credentialsRef: encrypt(secret) },
    });
    const body = JSON.stringify({ organizationId: a.org.id, provider: "website", firstName: "Web", phone: "9876543210" });
    const post = (headers: Record<string, string>) =>
      webhookRoute.POST(new Request("http://test.local/api/integrations/website/webhook", { method: "POST", body, headers }));

    expect((await post({})).status).toBe(401);
    const ts = String(Date.now());
    const bad = createHmac("sha256", "wrong").update(`${ts}.${body}`).digest("hex");
    expect((await post({ "x-intracore-timestamp": ts, "x-intracore-signature": `sha256=${bad}` })).status).toBe(401);
    const good = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const ok = await post({ "x-intracore-timestamp": ts, "x-intracore-signature": `sha256=${good}` });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
  });
});
