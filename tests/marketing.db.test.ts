import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { processQueue } from "@/lib/queue";
import type { AccessContext } from "@/lib/access";
import { createSegment, previewSegment, resolveAudience, updateSegment } from "@/features/marketing/segments";
import { campaignMetrics, createCampaign, getCampaign, startDueCampaigns, transitionCampaign, updateCampaign } from "@/features/marketing/campaigns";
import { dispatchCampaign } from "@/features/marketing/dispatch";
import { createFeedback, feedbackSummary, listFeedback } from "@/features/marketing/feedback";
import { adjustPoints, earnForInvoice, expireLoyaltyPoints, loyaltyBalance, loyaltyStatement, redeemPoints, reverseForInvoice } from "@/features/marketing/loyalty";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";
import * as campaignsRoute from "@/app/api/v1/campaigns/route";
import * as campaignActionRoute from "@/app/api/v1/campaigns/[id]/[action]/route";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

/** Simulated crash: queueMessage throws once `after` calls have succeeded. */
const crash = { after: Infinity, calls: 0 };
vi.mock("@/features/communication/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/communication/send")>();
  return {
    ...actual,
    queueMessage: async (...args: Parameters<typeof actual.queueMessage>) => {
      if (crash.calls >= crash.after) throw new Error("simulated crash");
      crash.calls++;
      return actual.queueMessage(...args);
    },
  };
});

let a: OrgFixture;
let b: OrgFixture;
let owner: AccessContext;
let mgr: AccessContext;
let admin: AccessContext;
let exec: AccessContext;
let salesExec: AccessContext;
let bAdmin: AccessContext;
let mgrId: string;
let adminId: string;
let promoTpl: string;
let smsTpl: string;
let badVarsTpl: string;
let bizSegment: string;
const customerIds: Record<string, string> = {};

const expectError = async (p: Promise<unknown>, status: number, code?: string) => {
  const err = (await p.then(() => null, (e) => e)) as { status?: number; code?: string; issues?: unknown } | null;
  expect(err, "expected an error").not.toBeNull();
  expect(err!.status ?? (err!.issues ? 422 : undefined)).toBe(status);
  if (code) expect(err!.code).toBe(code);
  return err as { details?: unknown };
};

const optIn = (address: string, status = "OPTED_IN") =>
  prisma.contactConsent.create({ data: { organizationId: a.org.id, channel: "EMAIL", address, purpose: "MARKETING", status } });

async function customer(org: OrgFixture, name: string, email: string | null, extra: object = {}) {
  const c = await prisma.customer.create({ data: { organizationId: org.org.id, name, email, createdById: org.ownerId, ...extra } });
  return c.id;
}

/** DRAFT → SENDING through the real transitions (mgr creates/submits, admin approves). */
async function launch(segmentId = bizSegment, name = `C ${Math.random()}`) {
  const c = await createCampaign(mgr, { name, channel: "EMAIL", templateId: promoTpl, segmentId });
  await transitionCampaign(mgr, c.id, "submit", {});
  await transitionCampaign(admin, c.id, "approve", {});
  await transitionCampaign(mgr, c.id, "send", {});
  return c.id;
}

beforeAll(async () => {
  a = await createOrg("Mkt A");
  b = await createOrg("Mkt B");
  mgrId = (await a.addMember("marketing_manager")).userId;
  adminId = (await a.addMember("admin")).userId;
  owner = await a.ctx(a.ownerId);
  mgr = await a.ctx(mgrId);
  admin = await a.ctx(adminId);
  exec = await a.ctx((await a.addMember("marketing_executive")).userId);
  salesExec = await a.ctx((await a.addMember("sales_executive")).userId);
  bAdmin = await b.ctx((await b.addMember("admin")).userId);

  const tpl = (channel: "EMAIL" | "SMS", name: string, category: string, variables = ["name"]) =>
    prisma.messageTemplate.create({ data: { organizationId: a.org.id, channel, name, category, subject: "Hello", body: `Hi ${variables.map((v) => `{{${v}}}`).join(" ")}`, variables } });
  promoTpl = (await tpl("EMAIL", "promo", "MARKETING")).id;
  smsTpl = (await tpl("SMS", "note", "TRANSACTIONAL")).id;
  badVarsTpl = (await tpl("EMAIL", "coupon", "MARKETING", ["name", "code"])).id;

  customerIds.c1 = await customer(a, "Asha", "c1@x.com");
  customerIds.c2 = await customer(a, "Bala", " C2@X.com ");
  customerIds.c3 = await customer(a, "Chitra", "c3@x.com");
  customerIds.c4 = await customer(a, "Dev", "c4@x.com");
  customerIds.c5 = await customer(a, "Esha", "not-an-email");
  customerIds.c6 = await customer(a, "Farhan", null);
  customerIds.ind = await customer(a, "Indi", "ind@x.com", { type: "INDIVIDUAL" });
  await optIn("c1@x.com");
  await optIn("c2@x.com");
  await optIn("c3@x.com", "OPTED_OUT");
  bizSegment = (await createSegment(mgr, { name: "Businesses", entity: "CUSTOMER", filters: [{ field: "type", op: "eq", value: "BUSINESS" }] })).id;
});
afterAll(cleanupFixtures);
beforeEach(() => {
  crash.after = Infinity;
  crash.calls = 0;
});

describe("segments", () => {
  it("rejects fields and operators outside the allowlist", async () => {
    const seg = (filters: unknown) => createSegment(mgr, { name: `s ${Math.random()}`, entity: "CUSTOMER", filters });
    await expectError(seg([{ field: "gstin", op: "eq", value: "x" }]), 422, "VALIDATION_ERROR");
    await expectError(seg([{ field: "__proto__", op: "eq", value: "x" }]), 422, "VALIDATION_ERROR");
    await expectError(seg([{ field: "name", op: "regex", value: ".*" }]), 422, "VALIDATION_ERROR");
    await expectError(seg([{ field: "type", op: "eq", value: "ROBOT" }]), 422, "VALIDATION_ERROR");
    await expectError(seg([{ field: "createdAt", op: "gte", value: "not a date" }]), 422, "VALIDATION_ERROR");
    await expectError(createSegment(mgr, { name: "lead", entity: "LEAD", filters: [{ field: "email", op: "eq", value: "x" }] }), 422, "VALIDATION_ERROR");
    await expectError(createSegment(exec, { name: "no", entity: "CUSTOMER", filters: [] }), 403);
  });

  it("treats injection-looking values as plain data", async () => {
    const before = await prisma.customer.count({ where: { organizationId: a.org.id } });
    const preview = await previewSegment(mgr, { entity: "CUSTOMER", filters: [{ field: "name", op: "eq", value: "x' OR 1=1; DROP TABLE customers; --" }], channel: "EMAIL" });
    expect(preview.total).toBe(0);
    expect(await prisma.customer.count({ where: { organizationId: a.org.id } })).toBe(before);
  });

  it("previews totals, addresses, consent eligibility and a sample", async () => {
    const p = await previewSegment(mgr, { segmentId: bizSegment, channel: "EMAIL", purpose: "MARKETING" });
    expect(p).toMatchObject({ total: 6, withAddress: 4, unique: 4, eligible: 2, blocked: { NO_CONSENT: 1, OPTED_OUT: 1, INVALID_ADDRESS: 2 } });
    expect(p.sample).toHaveLength(6);
    expect(p.sample.find((s) => s.name === "Bala")).toMatchObject({ address: "c2@x.com", status: "ELIGIBLE" });
    // transactional email needs no opt-in; c3's opt-out covers marketing only
    expect(await previewSegment(mgr, { segmentId: bizSegment, channel: "EMAIL", purpose: "TRANSACTIONAL" })).toMatchObject({ eligible: 4 });
    const ind = await previewSegment(mgr, { entity: "CUSTOMER", filters: [{ field: "type", op: "in", value: ["INDIVIDUAL"] }], channel: "EMAIL" });
    expect(ind).toMatchObject({ total: 1, eligible: 0 });
    await expectError(previewSegment(bAdmin, { segmentId: bizSegment, channel: "EMAIL" }), 404);
  });

  it("limits lead audiences to leads the viewer can see", async () => {
    await prisma.lead.createMany({
      data: [
        { organizationId: a.org.id, fullName: "Mine", email: "mine@x.com", assignedUserId: salesExec.userId },
        { organizationId: a.org.id, fullName: "Theirs", email: "theirs@x.com" },
      ],
    });
    const seg = { entity: "LEAD", filters: [{ field: "status", op: "eq", value: "NEW" }] };
    expect((await resolveAudience(prisma, a.org.id, seg, "EMAIL", salesExec)).map((m) => m.name)).toEqual(["Mine"]);
    expect(await resolveAudience(prisma, a.org.id, seg, "EMAIL", mgr)).toHaveLength(2); // lead.view_all
  });

  it("deduplicates contacts sharing an address", async () => {
    await prisma.contact.createMany({
      data: ["One", "Two"].map((n) => ({ organizationId: a.org.id, customerId: customerIds.c1, firstName: n, fullName: n, email: "Shared@x.com", jobTitle: "Buyer", createdById: a.ownerId })),
    });
    await optIn("shared@x.com");
    const p = await previewSegment(mgr, { entity: "CONTACT", filters: [{ field: "jobTitle", op: "eq", value: "buyer" }, { field: "customer.type", op: "eq", value: "BUSINESS" }], channel: "EMAIL" });
    expect(p).toMatchObject({ total: 2, unique: 1, eligible: 1 });
  });
});

describe("campaign workflow", () => {
  it("validates template channel, purpose and variables", async () => {
    const base = { name: "x", segmentId: bizSegment };
    await expectError(createCampaign(mgr, { ...base, channel: "EMAIL", templateId: smsTpl }), 422, "TEMPLATE_CHANNEL");
    await expectError(createCampaign(mgr, { ...base, channel: "EMAIL", templateId: promoTpl, purpose: "TRANSACTIONAL" }), 422, "VALIDATION_ERROR");
    await expectError(createCampaign(mgr, { ...base, channel: "EMAIL", templateId: badVarsTpl }), 422, "TEMPLATE_VARIABLES");
    const c = await createCampaign(mgr, { ...base, channel: "EMAIL", templateId: promoTpl });
    expect(c).toMatchObject({ status: "DRAFT", purpose: "MARKETING" });
  });

  it("enforces approval segregation and state transitions", async () => {
    const c = await createCampaign(mgr, { name: "Diwali", channel: "EMAIL", templateId: promoTpl, segmentId: bizSegment });
    await expectError(transitionCampaign(admin, c.id, "approve", {}), 422, "INVALID_STATE"); // still DRAFT
    await expectError(transitionCampaign(mgr, c.id, "send", {}), 422, "INVALID_STATE");
    await transitionCampaign(mgr, c.id, "submit", {});
    await expectError(updateCampaign(mgr, c.id, { name: "late edit" }), 422, "INVALID_STATE");
    await expectError(transitionCampaign(mgr, c.id, "approve", {}), 403); // no campaign.approve
    await expectError(transitionCampaign(admin, c.id, "reject", {}), 422); // reason required
    expect(await transitionCampaign(admin, c.id, "reject", { reason: "Fix copy" })).toMatchObject({ status: "DRAFT" });
    await transitionCampaign(mgr, c.id, "submit", {});
    expect(await transitionCampaign(admin, c.id, "approve", {})).toMatchObject({ status: "APPROVED", approvedById: adminId });
    await expectError(transitionCampaign(mgr, c.id, "schedule", { scheduledAt: new Date(Date.now() - 60_000).toISOString() }), 422);

    // creators can't approve their own campaign, whatever their role
    const own = await createCampaign(admin, { name: "Own", channel: "EMAIL", templateId: promoTpl, segmentId: bizSegment });
    await transitionCampaign(admin, own.id, "submit", {});
    await expectError(transitionCampaign(admin, own.id, "approve", {}), 403, "FORBIDDEN");
    expect(await transitionCampaign(owner, own.id, "approve", {})).toMatchObject({ status: "APPROVED" });
    expect(await transitionCampaign(admin, own.id, "cancel", {})).toMatchObject({ status: "CANCELLED" });
    await expectError(transitionCampaign(admin, own.id, "cancel", {}), 422, "INVALID_STATE");
  });

  it("refuses to submit an audience with nobody eligible", async () => {
    const empty = await createSegment(mgr, { name: "Individuals", entity: "CUSTOMER", filters: [{ field: "type", op: "eq", value: "INDIVIDUAL" }] });
    const c = await createCampaign(mgr, { name: "Nobody", channel: "EMAIL", templateId: promoTpl, segmentId: empty.id });
    const err = await expectError(transitionCampaign(mgr, c.id, "submit", {}), 422, "AUDIENCE_EMPTY");
    expect(err.details).toMatchObject({ total: 1, eligible: 0, blocked: { NO_CONSENT: 1 } });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("DRAFT");
  });

  it("answers 404 across tenants", async () => {
    const c = await createCampaign(mgr, { name: "Private", channel: "EMAIL", templateId: promoTpl, segmentId: bizSegment });
    await expectError(getCampaign(bAdmin, c.id), 404);
    await expectError(transitionCampaign(bAdmin, c.id, "submit", {}), 404);
    await expectError(updateSegment(bAdmin, bizSegment, { name: "mine" }), 404);
    await expectError(createCampaign(bAdmin, { name: "x", channel: "EMAIL", templateId: promoTpl, segmentId: bizSegment }), 422, "INVALID_REFERENCE");
  });
});

describe("dispatch", () => {
  const logs = (campaignId: string) => prisma.communicationLog.findMany({ where: { organizationId: a.org.id, campaignId } });

  it("is idempotent: one log per recipient, skipped reasons recorded, campaign completes", async () => {
    const id = await launch();
    expect(await prisma.backgroundJob.count({ where: { key: `campaign.dispatch:${id}` } })).toBe(1);
    await processQueue({ types: ["campaign.dispatch"] });
    await dispatchCampaign({ campaignId: id }); // already COMPLETED: no-op
    await prisma.campaign.update({ where: { id }, data: { status: "SENDING" } }); // force a full re-run
    await dispatchCampaign({ campaignId: id });

    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: id } });
    expect(recipients).toHaveLength(5); // c6 has no email
    const byAddr = Object.fromEntries(recipients.map((r) => [r.address, r]));
    expect(byAddr["c1@x.com"]).toMatchObject({ status: "QUEUED" });
    expect(byAddr["c2@x.com"]).toMatchObject({ status: "QUEUED" });
    expect(byAddr["c3@x.com"]).toMatchObject({ status: "SKIPPED", skipReason: "OPTED_OUT" });
    expect(byAddr["c4@x.com"]).toMatchObject({ status: "SKIPPED", skipReason: "NO_CONSENT" });
    expect(byAddr["not-an-email"]).toMatchObject({ status: "SKIPPED", skipReason: "INVALID_ADDRESS" });
    const l = await logs(id);
    expect(l).toHaveLength(5);
    expect(new Set(l.map((x) => x.idempotencyKey)).size).toBe(5);
    expect(recipients.every((r) => l.some((x) => x.id === r.communicationLogId))).toBe(true);
    const c = await getCampaign(mgr, id);
    expect(c.status).toBe("COMPLETED");
    expect(c.metrics).toMatchObject({ targeted: 5, skipped: 3, skippedByReason: { OPTED_OUT: 1, NO_CONSENT: 1, INVALID_ADDRESS: 1 }, queued: 2, sent: 0 });
  });

  it("resumes after a crash without double-sending", async () => {
    crash.after = 2;
    const id = await launch();
    await expect(dispatchCampaign({ campaignId: id })).rejects.toThrow("simulated crash");
    expect(await prisma.campaignRecipient.count({ where: { campaignId: id, status: "PENDING" } })).toBe(3);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("SENDING");
    crash.after = Infinity;
    await dispatchCampaign({ campaignId: id });
    await dispatchCampaign({ campaignId: id });
    expect(await logs(id)).toHaveLength(5);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: id, status: "PENDING" } })).toBe(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("COMPLETED");
  });

  it("stops queuing once cancelled mid-send", async () => {
    crash.after = 1;
    const id = await launch();
    await expect(dispatchCampaign({ campaignId: id })).rejects.toThrow();
    crash.after = Infinity;
    await transitionCampaign(mgr, id, "cancel", {});
    expect(await dispatchCampaign({ campaignId: id })).toMatchObject({ skipped: "CANCELLED" });
    expect(await logs(id)).toHaveLength(1);
    expect((await campaignMetrics(id)).skippedByReason).toMatchObject({ CANCELLED: 4 });
  });

  it("scheduler starts each due campaign once, even when runs overlap", async () => {
    const c = await createCampaign(mgr, { name: "Later", channel: "EMAIL", templateId: promoTpl, segmentId: bizSegment, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    await transitionCampaign(mgr, c.id, "submit", {});
    await transitionCampaign(admin, c.id, "approve", {});
    await startDueCampaigns();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("APPROVED"); // not due yet
    const later = new Date(Date.now() + 2 * 3600_000);
    await Promise.all([startDueCampaigns(later), startDueCampaigns(later), startDueCampaigns(later)]);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "SENDING" });
    expect(await prisma.backgroundJob.count({ where: { key: { startsWith: `campaign.dispatch:${c.id}` } } })).toBe(1);
  });
});

describe("metrics", () => {
  it("reports simulated deliveries separately and never as real delivery", async () => {
    const c = await prisma.campaign.create({ data: { organizationId: a.org.id, name: "M", channel: "EMAIL", templateId: promoTpl, segmentId: bizSegment, status: "COMPLETED" } });
    const rows: [string, boolean, string | null][] = [
      ["SENT", false, null], ["DELIVERED", false, null], ["READ", false, null], ["FAILED", false, "NOT_CONFIGURED: no enabled EMAIL integration"], ["FAILED", false, "NOT_CONFIGURED"], ["FAILED", false, "provider said no"],
      ["DELIVERED", true, null], ["READ", true, null], ["SENT", true, null],
    ];
    await prisma.communicationLog.createMany({
      data: rows.map(([status, simulated, error], i) => ({ organizationId: a.org.id, channel: "EMAIL" as const, provider: simulated ? "mock" : "smtp", campaignId: c.id, toAddress: `m${i}@x.com`, body: "b", status, simulated, error })),
    });
    const m = await campaignMetrics(c.id);
    expect(m).toMatchObject({ sent: 3, delivered: 2, read: 1, failed: 3, failedByReason: { NOT_CONFIGURED: 2, ERROR: 1 }, deliveryRate: 0.6667 });
    expect(m.simulated).toMatchObject({ total: 3, sent: 3, delivered: 2, read: 1 });

    const none = await prisma.campaign.create({ data: { organizationId: a.org.id, name: "N", channel: "EMAIL", templateId: promoTpl, segmentId: bizSegment, status: "COMPLETED" } });
    await prisma.communicationLog.create({ data: { organizationId: a.org.id, channel: "EMAIL", provider: "mock", campaignId: none.id, toAddress: "s@x.com", body: "b", status: "DELIVERED", simulated: true } });
    expect(await campaignMetrics(none.id)).toMatchObject({ sent: 0, delivered: 0, deliveryRate: null, simulated: { delivered: 1 } });
  });
});

describe("loyalty", () => {
  let cust: string;
  const setLoyalty = (loyalty: object) => prisma.organization.update({ where: { id: a.org.id }, data: { settings: { loyalty } } });
  const invoice = (customerId: string, grandTotal: string, status: "DRAFT" | "POSTED" | "CANCELLED" = "POSTED") =>
    prisma.salesInvoice.create({
      data: { organizationId: a.org.id, companyId: a.company.id, branchId: a.branch.id, customerId, status, invoiceDate: new Date(), dueDate: new Date(), grandTotal, createdById: a.ownerId },
    });
  const balance = async (customerId: string) => (await loyaltyBalance(owner, customerId)).balance;

  beforeAll(async () => {
    cust = await customer(a, "Loyal", "loyal@x.com");
  });

  it("refuses everything while the programme is disabled", async () => {
    const inv = await invoice(cust, "1000.00");
    await expectError(earnForInvoice(owner, inv.id), 422, "LOYALTY_DISABLED");
    await expectError(redeemPoints(owner, cust, { points: 1 }), 422, "LOYALTY_DISABLED");
    await setLoyalty({ enabled: true, pointsPerCurrencyUnit: 0.01, pointValue: 0.5, minRedeemPoints: 10, expiryDays: 30 });
  });

  it("earns once per posted invoice", async () => {
    await expectError(earnForInvoice(owner, (await invoice(cust, "5000.00", "DRAFT")).id), 422, "INVALID_STATE");
    const inv = await invoice(cust, "12345.67");
    const [e1, e2] = await Promise.all([earnForInvoice(owner, inv.id), earnForInvoice(owner, inv.id)]);
    expect(e1!.id).toBe(e2!.id);
    expect(e1).toMatchObject({ kind: "EARN", points: 123, balanceAfter: 123 });
    expect(e1!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(await prisma.loyaltyLedgerEntry.count({ where: { sourceId: inv.id } })).toBe(1);
    expect(await earnForInvoice(owner, (await invoice(cust, "50.00")).id)).toBeNull(); // 0.5 points → nothing
    await expectError(earnForInvoice(bAdmin, inv.id), 404);
    await expectError(earnForInvoice(exec, inv.id), 403);
  });

  it("applies redemption rules", async () => {
    await expectError(redeemPoints(owner, cust, { points: 5 }), 422, "BELOW_MINIMUM");
    await expectError(redeemPoints(owner, cust, { points: 1000 }), 422, "INSUFFICIENT_POINTS");
    await expectError(redeemPoints(owner, cust, { points: 12.5 }), 422);
    const r = await redeemPoints(owner, cust, { points: 20, reference: "BILL-1" });
    expect(r).toMatchObject({ kind: "REDEEM", points: -20, balanceAfter: 103, value: "10.00" });
    expect((await redeemPoints(owner, cust, { points: 20, reference: "BILL-1" })).id).toBe(r.id); // retry-safe
    await expectError(redeemPoints(owner, cust, { points: 30, reference: "BILL-1" }), 409);
    await expectError(redeemPoints(bAdmin, cust, { points: 10 }), 404);
  });

  it("never overspends under concurrent redemptions", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => redeemPoints(owner, cust, { points: 20 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await balance(cust)).toBe(3);
    const entries = await prisma.loyaltyLedgerEntry.findMany({ where: { customerId: cust } });
    expect(entries.every((e) => e.balanceAfter >= 0)).toBe(true);
  });

  it("reverses a cancelled invoice, clamped to the remaining balance", async () => {
    const inv = await prisma.loyaltyLedgerEntry.findFirstOrThrow({ where: { customerId: cust, kind: "EARN" } });
    await expectError(reverseForInvoice(owner, inv.sourceId!), 422, "INVALID_STATE"); // still posted
    await prisma.salesInvoice.update({ where: { id: inv.sourceId! }, data: { status: "CANCELLED" } });
    const rev = await reverseForInvoice(owner, inv.sourceId!);
    expect(rev).toMatchObject({ kind: "REVERSAL", points: -3, balanceAfter: 0 });
    expect(rev!.reason).toMatch(/3 of 123/);
    expect((await reverseForInvoice(owner, inv.sourceId!))!.id).toBe(rev!.id);
  });

  it("adjusts with a reason and never below zero", async () => {
    await expectError(adjustPoints(owner, cust, { points: 10 }), 422);
    await expectError(adjustPoints(owner, cust, { points: -1, reason: "oops" }), 422, "INSUFFICIENT_POINTS");
    expect(await adjustPoints(owner, cust, { points: 7, reason: "Goodwill" })).toMatchObject({ kind: "ADJUST", balanceAfter: 7 });
    expect((await loyaltyStatement(owner, cust, {})).total).toBeGreaterThan(5);
  });

  it("expires unused points FIFO, once per lot", async () => {
    const c = await customer(a, "Expiring", "exp@x.com");
    const lotA = await earnForInvoice(owner, (await invoice(c, "10000.00")).id); // 100
    const lotB = await earnForInvoice(owner, (await invoice(c, "5000.00")).id); // 50
    await prisma.loyaltyLedgerEntry.update({ where: { id: lotB!.id }, data: { expiresAt: new Date(Date.now() + 60 * 86_400_000) } });
    await redeemPoints(owner, c, { points: 30 }); // consumes lot A first
    const at31 = new Date(Date.now() + 31 * 86_400_000);
    await expireLoyaltyPoints(at31);
    await expireLoyaltyPoints(at31);
    const expired = await prisma.loyaltyLedgerEntry.findMany({ where: { customerId: c, kind: "EXPIRE" } });
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ sourceId: lotA!.id, points: -70, balanceAfter: 50 });
    await expireLoyaltyPoints(new Date(Date.now() + 61 * 86_400_000));
    expect(await balance(c)).toBe(0);
    expect(lotB).toBeTruthy();
  });
});

describe("feedback", () => {
  it("validates rating, references and public consent", async () => {
    await expectError(createFeedback(owner, { rating: 6 }), 422);
    await expectError(createFeedback(owner, { rating: 4.5 }), 422);
    await expectError(createFeedback(owner, { rating: 5, isPublic: true }), 422);
    await expectError(createFeedback(owner, { rating: 5, customerId: await customer(b, "Other", null) }), 422, "INVALID_REFERENCE");
    await expectError(createFeedback(exec, { rating: 5 }), 403);
    const f = await createFeedback(mgr, { rating: 5, customerId: customerIds.c1, comment: "Great", isPublic: true, publicConsent: true });
    expect(f).toMatchObject({ isPublic: true, source: "MANUAL" });
    await createFeedback(mgr, { rating: "2", customerId: customerIds.c1 });
    expect(await feedbackSummary(mgr, { customerId: customerIds.c1 })).toMatchObject({ count: 2, averageRating: 3.5, distribution: { 5: 1, 2: 1 } });
    expect((await listFeedback(mgr, { isPublic: "true" })).total).toBe(1);
    expect((await listFeedback(bAdmin, {})).total).toBe(0);
  });
});

describe("routes", () => {
  it("replays campaign creation for the same Idempotency-Key and maps errors", async () => {
    await signInAs(mgrId);
    const body = { name: "Via API", channel: "EMAIL", templateId: promoTpl, segmentId: bizSegment };
    const headers = { "idempotency-key": `mkt-${a.org.id}` };
    const r1 = await call(campaignsRoute.POST, { method: "POST", body, headers });
    const r2 = await call(campaignsRoute.POST, { method: "POST", body, headers });
    expect(r1.status).toBe(201);
    expect(r2.json.data.id).toBe(r1.json.data.id);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(await prisma.campaign.count({ where: { organizationId: a.org.id, name: "Via API" } })).toBe(1);

    const id = r1.json.data.id;
    expect((await call(campaignActionRoute.POST, { method: "POST", params: { id, action: "explode" } })).status).toBe(404);
    expect((await call(campaignActionRoute.POST, { method: "POST", params: { id, action: "approve" } })).status).toBe(403);
    const metrics = await call(campaignActionRoute.GET, { params: { id, action: "metrics" } });
    expect(metrics.json.data).toMatchObject({ targeted: 0, simulated: { total: 0 } });
  });
});
