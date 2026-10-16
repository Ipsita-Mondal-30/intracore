import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { buildAccessContext } from "@/lib/access";
import { changeMemberRole, listMembers, setMemberStatus } from "@/features/admin/users";
import { createRole, getPermissionMatrix } from "@/features/admin/roles";
import { searchAuditLogs } from "@/features/admin/audit";
import { importTemplate, runImport } from "@/features/admin/imports";
import { applyRetentionPolicies, previewRetention, upsertRetentionPolicy } from "@/features/admin/retention";
import * as rolesRoute from "@/app/api/v1/admin/roles/route";
import * as roleRoute from "@/app/api/v1/admin/roles/[id]/route";
import * as memberActionRoute from "@/app/api/v1/admin/members/[id]/[action]/route";
import * as orgSettingsRoute from "@/app/api/v1/admin/settings/org/route";
import * as companySettingsRoute from "@/app/api/v1/admin/companies/[id]/settings/route";
import * as environmentRoute from "@/app/api/v1/admin/environment/route";
import * as auditRoute from "@/app/api/v1/admin/audit/route";
import * as importsRoute from "@/app/api/v1/admin/imports/route";
import * as retentionRoute from "@/app/api/v1/admin/retention/route";
import * as retentionTargetRoute from "@/app/api/v1/admin/retention/[target]/route";
import * as backupsRoute from "@/app/api/v1/admin/backups/route";
import { cleanupFixtures, createOrg, createUser, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));
vi.mock("@/lib/storage/objects", () => ({
  putObject: vi.fn(async () => undefined),
  removeObject: vi.fn(async () => undefined),
  signedObjectUrl: vi.fn(async () => ({ signedUrl: "https://storage.test/x", expiresAt: new Date().toISOString() })),
}));

let a: OrgFixture;
let b: OrgFixture;
const DAY = 86_400_000;

/** Member on a custom role with exactly these permissions. */
async function memberWith(org: OrgFixture, code: string, permissions: string[]) {
  const owner = await org.ctx(org.ownerId);
  const role = await createRole(owner, { code, name: code, permissions });
  const userId = await createUser(code);
  const member = await prisma.organizationMember.create({ data: { organizationId: org.org.id, userId, roleId: role.id } });
  await prisma.memberScope.create({ data: { organizationId: org.org.id, memberId: member.id, companyId: org.company.id } });
  await prisma.user.update({ where: { id: userId }, data: { activeOrganizationId: org.org.id } });
  return { userId, memberId: member.id, roleId: role.id };
}

beforeAll(async () => {
  a = await createOrg("Admin A");
  b = await createOrg("Admin B");
});
afterAll(cleanupFixtures);

describe("users and roles", () => {
  it("custom role writes are exactly what access resolution reads", async () => {
    const m = await memberWith(a, "reader_x", ["customer.view", "contact.view"]);
    const ctx = await buildAccessContext(m.userId, a.org.id);
    expect([...ctx.permissions].sort()).toEqual(["contact.view", "customer.view"]);
    const matrix = await getPermissionMatrix(await a.ctx(a.ownerId));
    expect(matrix.roles.find((r) => r.code === "reader_x")!.modules).toMatchObject({ customer: 1, contact: 1, finance: 0 });
  });

  it("guards against role escalation", async () => {
    const admin = await memberWith(a, "people_admin", ["member.view", "member.change_role", "member.remove", "role.view", "role.manage", "company.view"]);
    const lite = await memberWith(a, "lite_a", ["company.view"]);
    const ctx = await a.ctx(admin.userId);
    // Cannot hand out more than it holds.
    await expect(changeMemberRole(ctx, lite.memberId, { roleId: a.roles.get("admin")! })).rejects.toMatchObject({ code: "ROLE_ESCALATION", status: 403 });
    await expect(changeMemberRole(ctx, lite.memberId, { roleId: a.roles.get("owner")! })).rejects.toMatchObject({ code: "ROLE_ESCALATION" });
    await expect(createRole(ctx, { code: "sneaky", name: "Sneaky", permissions: ["finance.post"] })).rejects.toMatchObject({ code: "ROLE_ESCALATION" });
    // Cannot manage someone who holds more than it does.
    const sales = await a.addMember("sales_manager");
    await expect(changeMemberRole(ctx, sales.memberId, { roleId: lite.roleId })).rejects.toMatchObject({ code: "ROLE_ESCALATION" });
    await expect(setMemberStatus(ctx, sales.memberId, "DISABLED")).rejects.toMatchObject({ code: "ROLE_ESCALATION" });
    await expect(changeMemberRole(ctx, (await prisma.organizationMember.findFirstOrThrow({ where: { userId: a.ownerId } })).id, { roleId: lite.roleId })).rejects.toMatchObject({ status: 403 });
    // Within its own access: allowed and audited.
    const subset = await createRole(ctx, { code: "subset_a", name: "Subset", permissions: ["member.view"] });
    await changeMemberRole(ctx, lite.memberId, { roleId: subset.id });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.org.id, action: "member.role_changed", entityId: lite.memberId } });
    expect(log.next).toMatchObject({ roleId: subset.id, roleCode: "subset_a", isOwner: false });
  });

  it("blocks changing your own role and losing the last owner", async () => {
    const ownerCtx = await a.ctx(a.ownerId);
    const ownerMember = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: a.org.id, userId: a.ownerId } });
    await signInAs(a.ownerId);
    const self = await call(memberActionRoute.POST, { method: "POST", params: { id: ownerMember.id, action: "role" }, body: { roleId: a.roles.get("viewer") } });
    expect(self.status).toBe(422);
    expect(self.json.code).toBe("SELF_CHANGE");

    // Promote a second owner, who then demotes the first.
    const second = await a.addMember("viewer");
    await changeMemberRole(ownerCtx, second.memberId, { roleId: a.roles.get("owner")! });
    expect((await prisma.organizationMember.findUniqueOrThrow({ where: { id: second.memberId } })).isOwner).toBe(true);
    const secondCtx = await a.ctx(second.userId);
    await changeMemberRole(secondCtx, ownerMember.id, { roleId: a.roles.get("admin")! });
    // The first owner's stale context (still says owner) cannot now remove the last owner.
    await expect(changeMemberRole(ownerCtx, second.memberId, { roleId: a.roles.get("admin")! })).rejects.toMatchObject({ code: "LAST_OWNER", status: 422 });
    await expect(setMemberStatus(ownerCtx, second.memberId, "DISABLED")).rejects.toMatchObject({ code: "LAST_OWNER" });
    // Restore the original owner for later tests.
    await changeMemberRole(secondCtx, ownerMember.id, { roleId: a.roles.get("owner")! });
    expect((await prisma.organizationMember.findUniqueOrThrow({ where: { id: ownerMember.id } })).isOwner).toBe(true);
  });

  it("suspends and reactivates members", async () => {
    const m = await a.addMember("sales_executive");
    const ctx = await a.ctx(a.ownerId);
    await setMemberStatus(ctx, m.memberId, "DISABLED");
    await expect(buildAccessContext(m.userId, a.org.id)).rejects.toMatchObject({ status: 403 });
    await setMemberStatus(ctx, m.memberId, "ACTIVE");
    await expect(buildAccessContext(m.userId, a.org.id)).resolves.toBeTruthy();
    const page = await listMembers(ctx, { pageSize: 100 });
    expect(page.items.find((i) => i.id === m.memberId)!.scopes[0].company.code).toBe("MAIN");
  });

  it("validates custom roles; system roles are read-only; roles in use cannot be deleted", async () => {
    await signInAs(a.ownerId);
    const unknown = await call(rolesRoute.POST, { method: "POST", body: { code: "bad_role", name: "Bad", permissions: ["customer.view", "made.up"] } });
    expect(unknown.status).toBe(422);
    expect(unknown.json.error).toContain("made.up");
    const reserved = await call(rolesRoute.POST, { method: "POST", body: { code: "admin", name: "Admin 2", permissions: [] } });
    expect(reserved.status).toBe(422);

    const system = a.roles.get("sales_manager")!;
    expect((await call(roleRoute.PATCH, { method: "PATCH", params: { id: system }, body: { permissions: ["customer.view"] } })).json.code).toBe("SYSTEM_ROLE");
    expect((await call(roleRoute.DELETE, { method: "DELETE", params: { id: system } })).status).toBe(422);

    const created = await call(rolesRoute.POST, { method: "POST", body: { code: "temp_role", name: "Temp", permissions: ["customer.view"] } });
    expect(created.status).toBe(201);
    const roleId = created.json.data.id;
    const patched = await call(roleRoute.PATCH, { method: "PATCH", params: { id: roleId }, body: { permissions: ["customer.view", "customer.create"] } });
    expect(patched.json.data.permissions).toEqual(["customer.create", "customer.view"]);

    const m = await a.addMember("viewer");
    await changeMemberRole(await a.ctx(a.ownerId), m.memberId, { roleId });
    const inUse = await call(roleRoute.DELETE, { method: "DELETE", params: { id: roleId } });
    expect(inUse.status).toBe(422);
    expect(inUse.json.code).toBe("ROLE_IN_USE");
    await changeMemberRole(await a.ctx(a.ownerId), m.memberId, { roleId: a.roles.get("viewer")! });
    expect((await call(roleRoute.DELETE, { method: "DELETE", params: { id: roleId } })).status).toBe(200);
  });
});

describe("settings and environment", () => {
  it("validates org settings (422) and audits only the changed keys", async () => {
    await signInAs(a.ownerId);
    expect((await call(orgSettingsRoute.PATCH, { method: "PATCH", body: { loyalty: { pointValue: -1 } } })).status).toBe(422);
    expect((await call(orgSettingsRoute.PATCH, { method: "PATCH", body: { loyalty: { bogus: 1 } } })).status).toBe(422);
    const ok = await call(orgSettingsRoute.PATCH, { method: "PATCH", body: { loyalty: { enabled: true, pointValue: 0.5 } } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.loyalty).toMatchObject({ enabled: true, pointValue: 0.5, minRedeemPoints: 0 });
    expect(ok.json.data.duplicates.customer).toEqual(["gstin", "email", "phone"]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.org.id, action: "org.settings_updated" }, orderBy: { createdAt: "desc" } });
    expect(log.previous).toEqual({ "loyalty.enabled": false, "loyalty.pointValue": 0 });
    expect(log.next).toEqual({ "loyalty.enabled": true, "loyalty.pointValue": 0.5 });
  });

  it("edits company settings without clobbering other keys; finance settings are refused", async () => {
    await signInAs(a.ownerId);
    const id = a.company.id;
    await call(companySettingsRoute.PATCH, { method: "PATCH", params: { id }, body: { purchase: { approvalAmount: 50000 } } });
    const res = await call(companySettingsRoute.PATCH, { method: "PATCH", params: { id }, body: { quotation: { approvalDiscountPercent: 15 } } });
    expect(res.json.data.purchase.approvalAmount).toBe(50000);
    expect(res.json.data.quotation).toMatchObject({ approvalDiscountPercent: 15, defaultValidityDays: 30 });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.org.id, action: "company.settings_updated" }, orderBy: { createdAt: "desc" } });
    expect(log).toMatchObject({ companyId: id, previous: { "quotation.approvalDiscountPercent": 10 }, next: { "quotation.approvalDiscountPercent": 15 } });

    expect((await call(companySettingsRoute.PATCH, { method: "PATCH", params: { id }, body: { quotation: { approvalDiscountPercent: 150 } } })).status).toBe(422);
    const finance = await call(companySettingsRoute.PATCH, { method: "PATCH", params: { id }, body: { finance: { enabled: true } } });
    expect(finance.status).toBe(422);
    expect(finance.json.code).toBe("FINANCE_MANAGED");
    // Another tenant's company is a 404.
    await signInAs(b.ownerId);
    expect((await call(companySettingsRoute.PATCH, { method: "PATCH", params: { id }, body: { quotation: { approvalDiscountPercent: 5 } } })).status).toBe(404);
  });

  it("environment panel exposes booleans only", async () => {
    await signInAs(a.ownerId);
    const res = await call(environmentRoute.GET);
    expect(res.status).toBe(200);
    const leaves = (v: unknown): unknown[] => (v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v]);
    expect(leaves(res.json.data).every((v) => typeof v === "boolean")).toBe(true);
    expect(res.json.data).toMatchObject({ encryptionKey: true, cronSecret: true });
    const text = JSON.stringify(res.json);
    expect(text).not.toContain(process.env.ENCRYPTION_KEY!);
    expect(text).not.toContain(process.env.CRON_SECRET!);
  });
});

describe("audit search", () => {
  it("filters by action prefix, text, entity and dates, and stays inside the tenant and company scope", async () => {
    const other = await prisma.company.create({ data: { organizationId: a.org.id, code: "OTHER", name: "Other Co" } });
    const old = new Date(Date.now() - 10 * DAY);
    await prisma.auditLog.createMany({
      data: [
        { organizationId: a.org.id, userId: a.ownerId, action: "zzsearch.created", entity: "zz", entityId: "1", companyId: a.company.id },
        { organizationId: a.org.id, userId: a.ownerId, action: "zzsearch.approved", entity: "zz", entityId: "2", createdAt: old },
        { organizationId: a.org.id, userId: a.ownerId, action: "zzsearch.created", entity: "zz", entityId: "3", companyId: other.id },
        { organizationId: b.org.id, userId: b.ownerId, action: "zzsearch.created", entity: "zz", entityId: "4" },
      ],
    });
    const owner = await a.ctx(a.ownerId);
    expect((await searchAuditLogs(owner, { action: "zzsearch." })).total).toBe(3);
    expect((await searchAuditLogs(owner, { action: "zzsearch.", q: "APPROVED" })).items.map((i) => i.entityId)).toEqual(["2"]);
    expect((await searchAuditLogs(owner, { entity: "zz", entityId: "3" })).total).toBe(1);
    expect((await searchAuditLogs(owner, { action: "zzsearch.", to: new Date(Date.now() - 5 * DAY).toISOString() })).items.map((i) => i.entityId)).toEqual(["2"]);
    expect((await searchAuditLogs(owner, { action: "zzsearch.", userId: a.ownerId, companyId: a.company.id })).total).toBe(1);

    // An accountant scoped to the default company never sees OTHER's entries.
    const accountant = await a.addMember("accountant");
    const scoped = await searchAuditLogs(await a.ctx(accountant.userId), { action: "zzsearch." });
    expect(scoped.items.map((i) => i.entityId).sort()).toEqual(["1", "2"]);
    expect((await searchAuditLogs(await b.ctx(b.ownerId), { action: "zzsearch." })).items.map((i) => i.entityId)).toEqual(["4"]);

    const support = await a.addMember("support_executive");
    await signInAs(support.userId);
    expect((await call(auditRoute.GET)).status).toBe(403);
  });
});

describe("imports", () => {
  const csv = (rows: string[][]) => rows.map((r) => r.map((c) => (c.includes(",") ? `"${c}"` : c)).join(",")).join("\n");

  it("dry run reports row errors and duplicates and writes nothing", async () => {
    const owner = await a.ctx(a.ownerId);
    await prisma.customer.create({ data: { organizationId: a.org.id, name: "Existing Co", gstin: "29ABCDE1234F1Z5", createdById: a.ownerId } });
    const file = csv([
      ["name", "code", "email", "gstin", "paymentTermsDays"],
      ["Dry One", "D1", "one@dry.test", "", "30"],
      ["Dry Two", "D2", "not-an-email", "", ""],
      ["Dup Co", "D3", "", "29ABCDE1234F1Z5", ""],
      ["Dry Four", "D1", "", "", ""],
    ]);
    const before = await prisma.customer.count({ where: { organizationId: a.org.id } });
    const jobsBefore = await prisma.importJob.count({ where: { organizationId: a.org.id } });
    const auditBefore = await prisma.auditLog.count({ where: { organizationId: a.org.id } });
    const result = await runImport(owner, { entity: "customer", csv: file, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, jobId: null, totalRows: 4, imported: 1, errors: 1, duplicates: 2 });
    expect(result.failedRows.find((f) => f.kind === "error")).toMatchObject({ row: 3 });
    expect(result.failedRows.find((f) => f.row === 3)!.reason).toContain("email");
    expect(await prisma.customer.count({ where: { organizationId: a.org.id } })).toBe(before);
    expect(await prisma.importJob.count({ where: { organizationId: a.org.id } })).toBe(jobsBefore);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id } })).toBe(auditBefore);
  });

  it("commit creates through the services, skips duplicates and records the job", async () => {
    await signInAs(a.ownerId);
    const file = csv([
      ["name", "code", "email", "gstin"],
      ["Import One", "I1", "i1@import.test", ""],
      ["Import Two", "I2", "bad", ""],
      ["Import Dup", "I3", "", "29ABCDE1234F1Z5"],
      ["Import Three", "I4", "i3@import.test", ""],
    ]);
    const res = await call(importsRoute.POST, { method: "POST", body: { entity: "customer", csv: file, dryRun: false, filename: "c.csv" } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ totalRows: 4, imported: 2, errors: 1, duplicates: 1 });
    const created = await prisma.customer.findMany({ where: { organizationId: a.org.id, code: { in: ["I1", "I4"] } } });
    expect(created).toHaveLength(2);
    const audits = await prisma.auditLog.count({ where: { action: "customer.created", entityId: { in: created.map((c) => c.id) } } });
    expect(audits).toBe(2);
    const job = await prisma.importJob.findUniqueOrThrow({ where: { id: res.json.data.jobId } });
    expect(job).toMatchObject({ entity: "customer", imported: 2, errors: 1, duplicates: 1, status: "COMPLETED_WITH_ERRORS", createdById: a.ownerId });
    // Re-running the same file only finds duplicates and the bad row.
    const again = await runImport(await a.ctx(a.ownerId), { entity: "customer", csv: file, dryRun: false });
    expect(again).toMatchObject({ imported: 0, duplicates: 3, errors: 1 });
  });

  it("imports products, vendors and contacts with reference resolution", async () => {
    const owner = await a.ctx(a.ownerId);
    const products = await runImport(owner, {
      entity: "product",
      dryRun: false,
      csv: csv([
        ["sku", "name", "uom", "taxRate", "salesPrice", "trackInventory"],
        ["IMP-1", "Bracket", "nos", "GST 18%", "120.50", "yes"],
        ["IMP-2", "Mystery", "parsecs", "", "", ""],
        ["IMP-1", "Bracket again", "NOS", "", "", ""],
      ]),
    });
    expect(products).toMatchObject({ imported: 1, errors: 1, duplicates: 1 });
    expect(products.failedRows.find((f) => f.row === 3)!.reason).toContain("parsecs");
    const product = await prisma.product.findFirstOrThrow({ where: { organizationId: a.org.id, sku: "IMP-1" } });
    expect(product.salesPrice.toString()).toBe("120.5");

    const vendors = await runImport(owner, { entity: "vendor", dryRun: false, csv: csv([["name", "code"], ["Vendor X", "VX"], ["Vendor Y", "VX"]]) });
    expect(vendors).toMatchObject({ imported: 1, duplicates: 1 });

    const contacts = await runImport(owner, {
      entity: "contact",
      dryRun: false,
      csv: csv([["firstName", "email", "customer"], ["Asha", "asha@import.test", "I1"], ["Ravi", "", "No Such Customer"]]),
    });
    expect(contacts).toMatchObject({ imported: 1, errors: 1 });
    const contact = await prisma.contact.findFirstOrThrow({ where: { organizationId: a.org.id, email: "asha@import.test" }, include: { customer: true } });
    expect(contact.customer!.code).toBe("I1");
  });

  it("rejects bad files and requires data.import AND the entity's create permission", async () => {
    const owner = await a.ctx(a.ownerId);
    await expect(runImport(owner, { entity: "customer", csv: "nam,email\nx,y" })).rejects.toMatchObject({ code: "INVALID_COLUMNS", status: 422 });
    await expect(runImport(owner, { entity: "invoice", csv: "a\n1" })).rejects.toMatchObject({ status: 422 });
    const big = "name\n" + Array.from({ length: 5001 }, (_, i) => `n${i}`).join("\n");
    await expect(runImport(owner, { entity: "customer", csv: big })).rejects.toMatchObject({ code: "TOO_MANY_ROWS" });
    expect(importTemplate(owner, "product").csv.split("\n")[0]).toContain("sku,name,uom");

    const importOnly = await memberWith(a, "import_only", ["data.import"]);
    const createOnly = await memberWith(a, "create_only", ["customer.create"]);
    const both = await memberWith(a, "import_customers", ["data.import", "customer.create"]);
    const file = "name\nPerm Test Co";
    await expect(runImport(await a.ctx(importOnly.userId), { entity: "customer", csv: file })).rejects.toMatchObject({ status: 403 });
    await expect(runImport(await a.ctx(createOnly.userId), { entity: "customer", csv: file })).rejects.toMatchObject({ status: 403 });
    await expect(runImport(await a.ctx(both.userId), { entity: "vendor", csv: "name\nV" })).rejects.toMatchObject({ status: 403 });
    expect(await runImport(await a.ctx(both.userId), { entity: "customer", csv: file, dryRun: false })).toMatchObject({ imported: 1 });
    await signInAs(importOnly.userId);
    expect((await call(importsRoute.POST, { method: "POST", body: { entity: "customer", csv: file } })).status).toBe(403);
  });
});

describe("retention", () => {
  let userId: string;
  beforeEach(async () => {
    const { putObject } = await import("@/lib/storage/objects");
    vi.mocked(putObject).mockReset().mockResolvedValue(undefined);
  });
  beforeAll(async () => {
    userId = (await a.addMember("viewer")).userId;
  });

  it("previews counts and purges only what the allowlisted rule and keepDays allow", async () => {
    const owner = await a.ctx(a.ownerId);
    const old = new Date(Date.now() - 40 * DAY);
    await prisma.notification.createMany({
      data: [
        { organizationId: a.org.id, userId, type: "t", title: "old read", readAt: old, createdAt: old },
        { organizationId: a.org.id, userId, type: "t", title: "old unread", createdAt: old },
        { organizationId: a.org.id, userId, type: "t", title: "new read", readAt: new Date() },
        { organizationId: b.org.id, userId: b.ownerId, type: "t", title: "other tenant old read", readAt: old, createdAt: old },
      ],
    });
    await prisma.communicationLog.createMany({
      data: [
        { organizationId: a.org.id, channel: "EMAIL", provider: "mock", toAddress: "x@t.test", body: "b", status: "DELIVERED", createdAt: old },
        { organizationId: a.org.id, channel: "EMAIL", provider: "mock", toAddress: "x@t.test", body: "b", status: "BLOCKED", createdAt: old },
        { organizationId: a.org.id, channel: "EMAIL", provider: "mock", toAddress: "x@t.test", body: "b", status: "QUEUED", createdAt: old },
      ],
    });
    expect(await previewRetention(owner, "notifications", { keepDays: 30 })).toMatchObject({ count: 1 });
    expect(await previewRetention(owner, "notifications", { keepDays: 60 })).toMatchObject({ count: 0 });
    await expect(previewRetention(owner, "journal_entries", {})).rejects.toMatchObject({ status: 404 });
    await expect(upsertRetentionPolicy(owner, "notifications", { keepDays: 1 })).rejects.toMatchObject({ name: "ZodError" });

    await upsertRetentionPolicy(owner, "notifications", { keepDays: 30, isEnabled: true });
    await upsertRetentionPolicy(owner, "communication_logs", { keepDays: 30, isEnabled: true });
    const run = await applyRetentionPolicies(new Date(), a.org.id);
    expect(run.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "notifications", purged: 1 }),
      expect.objectContaining({ target: "communication_logs", purged: 1 }),
    ]));
    const titles = (await prisma.notification.findMany({ where: { organizationId: { in: [a.org.id, b.org.id] } } })).map((n) => n.title).sort();
    expect(titles).toEqual(["new read", "old unread", "other tenant old read"]);
    expect((await prisma.communicationLog.findMany({ where: { organizationId: a.org.id } })).map((c) => c.status).sort()).toEqual(["BLOCKED", "QUEUED"]);

    // Idempotent: a second run finds nothing more.
    const again = await applyRetentionPolicies(new Date(), a.org.id);
    expect(again.purged).toBe(0);
    const policy = await prisma.retentionPolicy.findFirstOrThrow({ where: { organizationId: a.org.id, target: "notifications" } });
    expect(policy.lastRunAt).not.toBeNull();
    expect(policy.lastPurged).toBe(0);
  });

  it("audit logs: 365-day minimum, owners only, archived to storage before deletion", async () => {
    const owner = await a.ctx(a.ownerId);
    await expect(upsertRetentionPolicy(owner, "audit_logs", { keepDays: 100, isEnabled: true })).rejects.toMatchObject({ name: "ZodError" });
    const manager = await memberWith(a, "retention_mgr", ["retention.manage"]);
    await expect(upsertRetentionPolicy(await a.ctx(manager.userId), "audit_logs", { keepDays: 400, isEnabled: true })).rejects.toMatchObject({ status: 403 });
    await signInAs(manager.userId);
    expect((await call(retentionTargetRoute.PUT, { method: "PUT", params: { target: "audit_logs" }, body: { keepDays: 400 } })).status).toBe(403);
    expect((await call(retentionTargetRoute.PUT, { method: "PUT", params: { target: "webhook_events" }, body: { keepDays: 30 } })).status).toBe(200);

    const ancient = new Date(Date.now() - 400 * DAY);
    await prisma.auditLog.createMany({
      data: [
        { organizationId: a.org.id, action: "zzold.one", entity: "zz", entityId: "a1", createdAt: ancient, next: { x: 1 } },
        { organizationId: a.org.id, action: "zzold.two", entity: "zz", entityId: "a2", createdAt: ancient },
        { organizationId: b.org.id, action: "zzold.other", entity: "zz", entityId: "b1", createdAt: ancient },
      ],
    });
    await upsertRetentionPolicy(owner, "audit_logs", { keepDays: 365, isEnabled: true });
    const { putObject } = await import("@/lib/storage/objects");

    // Storage down: nothing is deleted.
    vi.mocked(putObject).mockRejectedValueOnce(new Error("storage unavailable"));
    const failed = await applyRetentionPolicies(new Date(), a.org.id);
    expect(failed.results.find((r) => r.target === "audit_logs")).toMatchObject({ purged: 0, error: expect.stringContaining("storage unavailable") });
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "zzold." } } })).toBe(3);

    const ok = await applyRetentionPolicies(new Date(), a.org.id);
    const result = ok.results.find((r) => r.target === "audit_logs")!;
    expect(result.purged).toBe(2);
    expect(result.archive).toMatch(new RegExp(`^archives/${a.org.id}/audit-.*\\.csv$`));
    const [bucket, path, body, mime] = vi.mocked(putObject).mock.calls.at(-1)!;
    expect([bucket, path, mime]).toEqual(["documents", result.archive, "text/csv"]);
    const archived = body.toString();
    expect(archived).toContain("zzold.one");
    expect(archived).toContain('"{""x"":1}"');
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "zzold." } } })).toBe(1);
  });

  it("is permission-gated", async () => {
    const support = await a.addMember("support_executive");
    await signInAs(support.userId);
    expect((await call(retentionRoute.GET)).status).toBe(403);
  });
});

describe("authorization", () => {
  it("answers 403 without permission and 404 across tenants", async () => {
    const support = await a.addMember("support_executive");
    await signInAs(support.userId);
    expect((await call(rolesRoute.GET)).status).toBe(403);
    expect((await call(orgSettingsRoute.PATCH, { method: "PATCH", body: { loyalty: { enabled: false } } })).status).toBe(403);
    expect((await call(environmentRoute.GET)).status).toBe(403);
    expect((await call(backupsRoute.GET)).status).toBe(403);

    await signInAs(b.ownerId);
    const aRole = a.roles.get("viewer")!;
    expect((await call(roleRoute.GET, { params: { id: aRole } })).status).toBe(404);
    expect((await call(roleRoute.DELETE, { method: "DELETE", params: { id: aRole } })).status).toBe(404);
    const aMember = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: a.org.id, isOwner: false } });
    expect((await call(memberActionRoute.POST, { method: "POST", params: { id: aMember.id, action: "suspend" } })).status).toBe(404);
    // A's role cannot be assigned inside B.
    const bMember = await b.addMember("viewer");
    expect((await call(memberActionRoute.POST, { method: "POST", params: { id: bMember.memberId, action: "role" }, body: { roleId: aRole } })).status).toBe(422);
    expect((await call(memberActionRoute.POST, { method: "POST", params: { id: bMember.memberId, action: "explode" } })).status).toBe(404);
    expect((await call(backupsRoute.GET)).status).toBe(200);
  });
});
