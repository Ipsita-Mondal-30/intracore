import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { createProduct } from "@/features/catalog/service";
import { createCustomer } from "@/features/customers/service";
import { createAsset, createWarranty, getAsset, transitionAsset, updateAsset } from "@/features/service/assets";
import { createContract, createRenewalQuotation, sendContractAndWarrantyReminders, transitionContract, updateContract } from "@/features/service/contracts";
import { submitClaim, transitionClaim } from "@/features/service/claims";
import { getVisit, listVisits, scheduleVisit, transitionVisit } from "@/features/service/field";
import { createInstallationJob, transitionInstallationJob, updateChecklistItem } from "@/features/service/installations";
import { createDispatch, transitionDispatch } from "@/features/service/dispatch";
import { NotConfiguredRouteProvider } from "@/features/service/providers";
import * as assetsRoute from "@/app/api/v1/assets/route";
import * as assetRoute from "@/app/api/v1/assets/[id]/route";
import * as contractsRoute from "@/app/api/v1/service-contracts/route";
import * as contractActionRoute from "@/app/api/v1/service-contracts/[id]/[action]/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

let a: OrgFixture;
let b: OrgFixture;
let owner: AccessContext;
let manager: AccessContext;
let tech: AccessContext;
let tech2: AccessContext;
let managerId: string;
let techId: string;
let custA: string;
let custB: string;
let productId: string;

const DAY = 86_400_000;
const day = (offset: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + offset * DAY).toISOString().slice(0, 10);
};
let tagN = 0;
const asset = (extra: Record<string, unknown> = {}) =>
  createAsset(manager, { companyId: a.company.id, tag: `T-${++tagN}`, name: "Chiller", ownership: "CUSTOMER", customerId: custA, ...extra });

/** Active contract for `assetId` with the given entitlements. */
async function activeContract(assetId: string, entitlements: { serviceType: string; quantity?: number | null }[], period = { startDate: day(-30), endDate: day(335) }) {
  const c = await createContract(manager, { companyId: a.company.id, customerId: custA, ...period, value: "12000", assetIds: [assetId], entitlements });
  return transitionContract(manager, c.id, "activate", {});
}

beforeAll(async () => {
  a = await createOrg("Service Co");
  b = await createOrg("Other Service Co");
  owner = await a.ctx(a.ownerId);
  const m = await a.addMember("service_manager");
  managerId = m.userId;
  manager = await a.ctx(m.userId);
  const t = await a.addMember("technician");
  techId = t.userId;
  tech = await a.ctx(t.userId);
  tech2 = await a.ctx((await a.addMember("technician")).userId);
  custA = (await createCustomer(owner, { name: "Acme Foods", ignoreDuplicates: true })).id;
  custB = (await createCustomer(owner, { name: "Beta Mills", ignoreDuplicates: true })).id;
  const nos = (await prisma.uom.findFirstOrThrow({ where: { organizationId: a.org.id, code: "NOS" } })).id;
  productId = (await createProduct(owner, { sku: "CHILLER-5T", name: "Chiller 5T", uomId: nos, salesPrice: "250000" })).id;
});
afterAll(cleanupFixtures);

describe("asset register", () => {
  it("registers assets with unique product serials, lifecycle and assignment history", async () => {
    const x = await asset({ productId, serialNumber: "SN-001" });
    await expect(asset({ productId, serialNumber: "SN-001" })).rejects.toMatchObject({ status: 409 });
    await expect(asset({ ownership: "CUSTOMER", customerId: null })).rejects.toMatchObject({ status: 422 });
    await expect(asset({ assignedToId: b.ownerId })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });

    await updateAsset(manager, x.id, { assignedToId: techId, location: "Plant 2" });
    const history = await prisma.auditLog.findFirstOrThrow({ where: { entity: "asset", entityId: x.id, action: "asset.updated" } });
    expect(history.next).toMatchObject({ assignedToId: techId, location: "Plant 2" });

    await expect(transitionAsset(manager, x.id, "dispose", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    await transitionAsset(manager, x.id, "retire", {});
    expect((await transitionAsset(manager, x.id, "dispose", {})).status).toBe("DISPOSED");
    await expect(transitionAsset(manager, x.id, "bogus", {})).rejects.toMatchObject({ status: 404 });
  });

  it("denies without permission and hides other tenants' assets", async () => {
    await expect(createAsset(tech, { companyId: a.company.id, tag: "NOPE", name: "x" })).rejects.toMatchObject({ status: 403 });
    const x = await asset();
    await expect(getAsset(await b.ctx(b.ownerId), x.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("warranty eligibility", () => {
  it("covers a claim inside the warranty window only for that customer's asset", async () => {
    const x = await asset();
    await createWarranty(manager, { assetId: x.id, startDate: day(-10), endDate: day(100) });
    const ok = await submitClaim(manager, { assetId: x.id, customerId: custA, serviceType: "repair" });
    expect(ok).toMatchObject({ status: "PENDING", claimType: "WARRANTY", covered: true });

    await expect(submitClaim(manager, { assetId: x.id, customerId: custB, serviceType: "REPAIR" })).rejects.toMatchObject({ code: "ASSET_CUSTOMER_MISMATCH", status: 422 });

    const partsOnly = await asset();
    await createWarranty(manager, { assetId: partsOnly.id, startDate: day(-10), endDate: day(100), coversLabor: false });
    expect((await submitClaim(manager, { assetId: partsOnly.id, serviceType: "LABOR" })).decisionReason).toContain("WARRANTY_TYPE_NOT_COVERED");
  });

  it("records an expired warranty claim as not covered", async () => {
    const x = await asset();
    await createWarranty(manager, { assetId: x.id, startDate: day(-400), endDate: day(-35) });
    const claim = await submitClaim(manager, { assetId: x.id, serviceType: "REPAIR" });
    expect(claim).toMatchObject({ status: "REJECTED", covered: false });
    expect(claim.decisionReason).toContain("WARRANTY_EXPIRED");
    await expect(createWarranty(manager, { assetId: x.id, startDate: day(5), endDate: day(1) })).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("AMC entitlements", () => {
  it("validates service type and consumes entitlements without over-consuming", async () => {
    const x = await asset();
    const contract = await activeContract(x.id, [{ serviceType: "PREVENTIVE", quantity: 1 }, { serviceType: "BREAKDOWN", quantity: null }]);

    const notCovered = await submitClaim(manager, { assetId: x.id, serviceType: "UPGRADE", claimType: "AMC" });
    expect(notCovered.decisionReason).toBe("SERVICE_TYPE_NOT_COVERED");

    const c1 = await submitClaim(manager, { assetId: x.id, serviceType: "PREVENTIVE" });
    const c2 = await submitClaim(manager, { assetId: x.id, serviceType: "PREVENTIVE" });
    expect([c1.status, c1.claimType, c1.contractId]).toEqual(["PENDING", "AMC", contract.id]);

    const results = await Promise.allSettled([transitionClaim(manager, c1.id, "approve", {}), transitionClaim(manager, c2.id, "approve", {})]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "ENTITLEMENT_EXHAUSTED" } });
    const ent = () => prisma.contractEntitlement.findFirstOrThrow({ where: { contractId: contract.id, serviceType: "PREVENTIVE" } });
    expect((await ent()).usedCount).toBe(1);

    // Re-approving the approved claim is a no-op, not a second consumption.
    const approvedId = results[0].status === "fulfilled" ? c1.id : c2.id;
    await Promise.all([transitionClaim(manager, approvedId, "approve", {}), transitionClaim(manager, approvedId, "approve", {})]);
    expect((await ent()).usedCount).toBe(1);

    const exhausted = await submitClaim(manager, { assetId: x.id, serviceType: "PREVENTIVE" });
    expect(exhausted).toMatchObject({ status: "REJECTED", decisionReason: "NO_WARRANTY,ENTITLEMENT_EXHAUSTED" });

    // Unlimited entitlements keep counting.
    const br = await submitClaim(manager, { assetId: x.id, serviceType: "BREAKDOWN" });
    await transitionClaim(manager, br.id, "approve", {});
    expect((await prisma.contractEntitlement.findFirstOrThrow({ where: { contractId: contract.id, serviceType: "BREAKDOWN" } })).usedCount).toBe(1);

    await expect(transitionClaim(tech, br.id, "reject", { reason: "x" })).rejects.toMatchObject({ status: 403 });
  });

  it("does not cover assets outside the contract period", async () => {
    const x = await asset();
    await activeContract(x.id, [{ serviceType: "PREVENTIVE", quantity: 4 }], { startDate: day(10), endDate: day(375) });
    expect((await submitClaim(manager, { assetId: x.id, serviceType: "PREVENTIVE", claimType: "AMC" })).decisionReason).toBe("NO_ACTIVE_CONTRACT");
  });
});

describe("contracts", () => {
  it("enforces the state machine", async () => {
    const x = await asset();
    const empty = await createContract(manager, { companyId: a.company.id, customerId: custA, startDate: day(0), endDate: day(364), value: "5000" });
    expect(empty.number).toMatch(/^AMC-/);
    await expect(transitionContract(manager, empty.id, "activate", {})).rejects.toMatchObject({ status: 422 });
    await updateContract(manager, empty.id, { assetIds: [x.id], entitlements: [{ serviceType: "PREVENTIVE", quantity: 2 }] });
    const active = await transitionContract(manager, empty.id, "activate", {});
    expect(active.status).toBe("ACTIVE");
    await expect(transitionContract(manager, empty.id, "activate", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(updateContract(manager, empty.id, { value: "1" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(transitionContract(manager, empty.id, "cancel", {})).rejects.toMatchObject({ name: "ZodError" });
    expect((await transitionContract(manager, empty.id, "expire", {})).status).toBe("EXPIRED");
    await expect(transitionContract(manager, empty.id, "cancel", { reason: "late" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("rolls back a contract covering another customer's asset", async () => {
    const other = await asset({ customerId: custB });
    const seq = () => prisma.numberSequence.findUnique({ where: { companyId_documentType: { companyId: a.company.id, documentType: "service_contract" } } });
    const [count, before] = [await prisma.serviceContract.count({ where: { organizationId: a.org.id } }), await seq()];
    await expect(createContract(manager, { companyId: a.company.id, customerId: custA, startDate: day(0), endDate: day(10), value: "1", assetIds: [other.id] })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    expect(await prisma.serviceContract.count({ where: { organizationId: a.org.id } })).toBe(count);
    expect((await seq())?.nextNumber).toBe(before?.nextNumber);
  });

  it("creates a draft renewal quotation once", async () => {
    const x = await asset();
    const c = await activeContract(x.id, [{ serviceType: "PREVENTIVE", quantity: 4 }]);
    const q = await createRenewalQuotation(manager, c.id, { branchId: a.branch.id });
    expect(q).toMatchObject({ status: "DRAFT", customerId: custA, companyId: a.company.id });
    expect(q.grandTotal.toString()).toBe("12000");
    expect((await prisma.serviceContract.findUniqueOrThrow({ where: { id: c.id } })).renewalQuotationId).toBe(q.id);
    expect((await createRenewalQuotation(manager, c.id, { branchId: a.branch.id })).id).toBe(q.id);
    await expect(createRenewalQuotation(tech, c.id, { branchId: a.branch.id })).rejects.toMatchObject({ status: 403 });
  });

  it("sends each expiry reminder once, even with overlapping runs", async () => {
    const x = await asset({ assignedToId: techId });
    await createWarranty(manager, { assetId: x.id, startDate: day(-300), endDate: day(5) });
    const c = await activeContract(x.id, [{ serviceType: "PREVENTIVE", quantity: 1 }], { startDate: day(-355), endDate: day(10) });
    const now = new Date();
    await Promise.all([sendContractAndWarrantyReminders(now), sendContractAndWarrantyReminders(now)]);
    await sendContractAndWarrantyReminders(now);
    const notes = await prisma.notification.findMany({ where: { organizationId: a.org.id, type: { in: ["service_contract.expiring", "warranty.expiring"] } } });
    expect(notes.filter((n) => (n.data as { contractId?: string }).contractId === c.id)).toHaveLength(1);
    expect(notes.filter((n) => (n.data as { assetId?: string }).assetId === x.id && n.type === "warranty.expiring")).toHaveLength(1);
    expect(notes.find((n) => n.type === "warranty.expiring" && (n.data as { assetId?: string }).assetId === x.id)?.userId).toBe(techId);
    expect(notes.find((n) => (n.data as { contractId?: string }).contractId === c.id)?.userId).toBe(managerId);
  });
});

describe("field visits", () => {
  const slot = (h1: number, h2: number) => ({ scheduledStart: `2030-01-07T${String(h1).padStart(2, "0")}:00:00Z`, scheduledEnd: `2030-01-07T${String(h2).padStart(2, "0")}:00:00Z` });

  it("refuses double-booking and lets only the technician work their visit", async () => {
    const v = await scheduleVisit(manager, { companyId: a.company.id, technicianId: techId, ...slot(10, 12), serviceType: "preventive" });
    await expect(scheduleVisit(manager, { companyId: a.company.id, technicianId: techId, ...slot(11, 13) })).rejects.toMatchObject({ code: "DOUBLE_BOOKED", status: 422 });
    await scheduleVisit(manager, { companyId: a.company.id, technicianId: techId, ...slot(12, 13) });
    await expect(scheduleVisit(manager, { companyId: a.company.id, technicianId: b.ownerId, ...slot(10, 12) })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(scheduleVisit(manager, { companyId: a.company.id, technicianId: techId, ...slot(12, 11) })).rejects.toMatchObject({ name: "ZodError" });
    await expect(scheduleVisit(tech, { companyId: a.company.id, technicianId: techId, ...slot(14, 15) })).rejects.toMatchObject({ status: 403 });

    expect((await listVisits(tech, {})).items.every((x) => x.technicianId === techId)).toBe(true);
    await expect(getVisit(tech2, v.id)).rejects.toMatchObject({ status: 404 });

    await transitionVisit(tech, v.id, "start", {});
    await expect(transitionVisit(tech, v.id, "complete", {})).rejects.toMatchObject({ name: "ZodError" });
    const done = await transitionVisit(tech, v.id, "complete", { notes: "Cleaned coils", customerSignedBy: "R. Rao" });
    expect(done).toMatchObject({ status: "COMPLETED", notes: "Cleaned coils" });
    // A completed visit frees the slot.
    await scheduleVisit(manager, { companyId: a.company.id, technicianId: techId, ...slot(10, 11) });
  });
});

describe("installations", () => {
  it("blocks completion until required checklist items are done", async () => {
    const job = await createInstallationJob(manager, {
      companyId: a.company.id,
      customerId: custA,
      technicianId: techId,
      scheduledStart: "2030-02-01T09:00:00Z",
      scheduledEnd: "2030-02-01T17:00:00Z",
      checklist: [{ label: "Mount unit" }, { label: "Site photo", required: false }],
    });
    expect(job).toMatchObject({ status: "SCHEDULED" });
    expect(job.number).toMatch(/^INS-/);
    await expect(scheduleVisit(manager, { companyId: a.company.id, technicianId: techId, scheduledStart: "2030-02-01T10:00:00Z", scheduledEnd: "2030-02-01T11:00:00Z" })).rejects.toMatchObject({ code: "DOUBLE_BOOKED" });

    await transitionInstallationJob(tech, job.id, "start", {});
    await expect(transitionInstallationJob(tech, job.id, "complete", {})).rejects.toMatchObject({ code: "CHECKLIST_INCOMPLETE" });
    await expect(updateChecklistItem(tech2, job.id, job.checklist[0].id, { done: true })).rejects.toMatchObject({ status: 404 });
    await updateChecklistItem(tech, job.id, job.checklist[0].id, { done: true });
    expect((await transitionInstallationJob(tech, job.id, "complete", {})).status).toBe("COMPLETED");
    await expect(updateChecklistItem(tech, job.id, job.checklist[1].id, { done: true })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("dispatch and proof of delivery", () => {
  const entry = (status: "POSTED" | "DRAFT", type: "DELIVERY" | "RECEIPT" = "DELIVERY") =>
    prisma.stockEntry.create({
      data: { organizationId: a.org.id, companyId: a.company.id, branchId: a.branch.id, number: `DN-T-${Math.random().toString(36).slice(2, 8)}`, type, status, customerId: custA, createdById: a.ownerId },
    });

  it("requires a posted delivery and POD to mark delivered", async () => {
    await expect(createDispatch(manager, { stockEntryId: (await entry("DRAFT")).id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(createDispatch(manager, { stockEntryId: (await entry("POSTED", "RECEIPT")).id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const e = await entry("POSTED");
    await expect(createDispatch(await b.ctx(b.ownerId), { stockEntryId: e.id })).rejects.toMatchObject({ status: 404 });
    const d = await createDispatch(manager, { stockEntryId: e.id, carrier: "BlueDart", trackingNumber: "BD123" });
    expect((await createDispatch(manager, { stockEntryId: e.id })).id).toBe(d.id);

    await expect(transitionDispatch(tech, d.id, "deliver", {})).rejects.toMatchObject({ name: "ZodError" });
    await transitionDispatch(tech, d.id, "in-transit", {});
    const delivered = await transitionDispatch(tech, d.id, "deliver", { receivedByName: "Store keeper" });
    expect(delivered).toMatchObject({ status: "DELIVERED", receivedByName: "Store keeper" });
    expect(delivered.deliveredAt).toBeInstanceOf(Date);
    await expect(transitionDispatch(tech, d.id, "fail", { reason: "x" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("route/location providers are not configured", async () => {
    await expect(NotConfiguredRouteProvider.planRoute({ latitude: 0, longitude: 0 }, [])).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("routes", () => {
  it("maps 403, 404, 422 and replays idempotent posts", async () => {
    await signInAs(techId);
    expect((await call(assetsRoute.POST, { method: "POST", body: { companyId: a.company.id, tag: "R-1", name: "x" } })).status).toBe(403);

    const x = await asset();
    await signInAs(b.ownerId);
    expect((await call(assetRoute.GET, { params: { id: x.id } })).status).toBe(404);

    await signInAs(managerId);
    const bad = await call(contractsRoute.POST, { method: "POST", body: { companyId: a.company.id, customerId: custA, startDate: day(10), endDate: day(1), value: "1" } });
    expect([bad.status, bad.json.code]).toEqual([422, "VALIDATION_ERROR"]);
    expect((await call(contractActionRoute.POST, { method: "POST", params: { id: "nope", action: "explode" }, body: {} })).status).toBe(404);

    const body = { companyId: a.company.id, customerId: custA, startDate: day(0), endDate: day(364), value: "9000", assetIds: [x.id], entitlements: [{ serviceType: "PREVENTIVE", quantity: 2 }] };
    const send = () => call(contractsRoute.POST, { method: "POST", body, headers: { "idempotency-key": `amc-${x.id}` } });
    const r1 = await send();
    const r2 = await send();
    expect(r1.status).toBe(201);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(r2.json.data.id).toBe(r1.json.data.id);
    expect(await prisma.contractAsset.count({ where: { assetId: x.id } })).toBe(1);
  });
});
