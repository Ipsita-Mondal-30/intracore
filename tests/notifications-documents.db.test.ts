import { createHash, createHmac } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { encrypt } from "@/lib/crypto/encryption";
import { createSystemNotification } from "@/lib/notifications/create";
import { addMonthsUtc, processReminders } from "@/features/notifications/reminders";
import { ESIGN_PROVIDERS, mockESignProvider } from "@/features/documents/esign";
import * as remindersRoute from "@/app/api/v1/reminders/route";
import * as reminderRoute from "@/app/api/v1/reminders/[id]/route";
import * as notificationsRoute from "@/app/api/v1/notifications/route";
import * as readRoute from "@/app/api/v1/notifications/[id]/read/route";
import * as readAllRoute from "@/app/api/v1/notifications/read-all/route";
import * as prefsRoute from "@/app/api/v1/notification-preferences/route";
import * as documentsRoute from "@/app/api/v1/documents/route";
import * as documentRoute from "@/app/api/v1/documents/[id]/route";
import * as versionsRoute from "@/app/api/v1/documents/[id]/versions/route";
import * as signaturesRoute from "@/app/api/v1/signature-requests/route";
import * as signatureRoute from "@/app/api/v1/signature-requests/[id]/route";
import * as signatureActionRoute from "@/app/api/v1/signature-requests/[id]/[action]/route";
import * as webhookRoute from "@/app/api/webhooks/esign/[provider]/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));
vi.mock("@/lib/storage/objects", () => ({
  putObject: vi.fn(async () => {}),
  removeObject: vi.fn(async () => {}),
  signedObjectUrl: vi.fn(async (_bucket: string, path: string) => ({ signedUrl: `https://storage.test/${path}`, expiresAt: new Date().toISOString() })),
}));

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml word/document.xml")]);

async function upload(entity: { type: string; id: string } | null, file: { bytes: Buffer; name: string; type: string }, versionOf?: string) {
  const form = new FormData();
  if (entity) {
    form.set("entityType", entity.type);
    form.set("entityId", entity.id);
  }
  form.set("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  const req = new Request("http://test.local/api", { method: "POST", body: form });
  const res = versionOf
    ? await versionsRoute.POST(req, { params: Promise.resolve({ id: versionOf }) })
    : await documentsRoute.POST(req, { params: Promise.resolve({}) as never });
  return { status: res.status, json: await res.json() };
}

const WEBHOOK_SECRET = "whsec_test_0123456789";
async function webhook(provider: string, payload: object, opts: { secret?: string; timestamp?: number } = {}) {
  const raw = JSON.stringify(payload);
  const ts = String(opts.timestamp ?? Date.now());
  const sig = createHmac("sha256", opts.secret ?? WEBHOOK_SECRET).update(`${ts}.${raw}`).digest("hex");
  const req = new Request("http://test.local/api/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-esign-timestamp": ts, "x-esign-signature": `sha256=${sig}` },
    body: raw,
  });
  const res = await webhookRoute.POST(req, { params: Promise.resolve({ provider }) });
  return { status: res.status, json: await res.json() };
}

const connect = (orgId: string, provider: string) =>
  prisma.integration.create({
    data: { organizationId: orgId, provider, status: "CONNECTED", secrets: encrypt(JSON.stringify({ webhookSecret: WEBHOOK_SECRET })) },
  });

let a: OrgFixture;
let b: OrgFixture;
let company2: string;

beforeAll(async () => {
  a = await createOrg("NotifDocs A");
  b = await createOrg("NotifDocs B");
  company2 = (await prisma.company.create({ data: { organizationId: a.org.id, code: "C2", name: "Second Co" } })).id;
});
afterAll(cleanupFixtures);

// ─── Reminders ────────────────────────────────────────────────────────────────

const reminderNotes = (userId: string) =>
  prisma.notification.findMany({ where: { organizationId: a.org.id, userId, type: "reminder" }, orderBy: { createdAt: "asc" } });

describe("reminders", () => {
  it("one-off fires once and deactivates", async () => {
    const m = await a.addMember("sales_executive");
    await signInAs(m.userId);
    const res = await call(remindersRoute.POST, { method: "POST", body: { title: "Call back", nextRunAt: "2030-01-10T09:00:00Z" } });
    expect(res.status).toBe(201);
    const id = res.json.data.id;
    await processReminders(new Date("2030-01-10T09:00:05Z"));
    await processReminders(new Date("2030-01-11T09:00:05Z"));
    const notes = await reminderNotes(m.userId);
    expect(notes).toHaveLength(1);
    expect(notes[0].dedupeKey).toBe(`reminder:${id}:2030-01-10T09:00:00.000Z`);
    const r = await prisma.reminder.findUniqueOrThrow({ where: { id } });
    expect(r).toMatchObject({ isActive: false, fireCount: 1 });
  });

  it("recurring advances; missed occurrences fire once; endsAt stops", async () => {
    const m = await a.addMember("sales_executive");
    const ctx = await a.ctx(m.userId);
    const { createReminder } = await import("@/features/notifications/reminders");
    const r = await createReminder(ctx, { title: "Daily standup", nextRunAt: "2030-03-01T08:00:00Z", recurrence: "DAILY", endsAt: "2030-03-12T00:00:00Z" });
    // job was down for 9 days: one notification, next run is the first future occurrence
    await processReminders(new Date("2030-03-10T09:00:00Z"));
    expect(await reminderNotes(m.userId)).toHaveLength(1);
    let row = await prisma.reminder.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.nextRunAt.toISOString()).toBe("2030-03-11T08:00:00.000Z");
    expect(row.isActive).toBe(true);
    await processReminders(new Date("2030-03-11T08:00:00Z"));
    row = await prisma.reminder.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.isActive).toBe(false); // 2030-03-12T08:00 is past endsAt
    expect(row.fireCount).toBe(2);
    expect(await reminderNotes(m.userId)).toHaveLength(2);
  });

  it("monthly is month-end safe", async () => {
    expect(addMonthsUtc(new Date("2031-01-31T10:00:00Z"), 1).toISOString()).toBe("2031-02-28T10:00:00.000Z");
    expect(addMonthsUtc(new Date("2032-01-31T10:00:00Z"), 1).toISOString()).toBe("2032-02-29T10:00:00.000Z");
    expect(addMonthsUtc(new Date("2031-11-30T10:00:00Z"), 3).toISOString()).toBe("2032-02-29T10:00:00.000Z");
    const m = await a.addMember("sales_executive");
    const { createReminder } = await import("@/features/notifications/reminders");
    const r = await createReminder(await a.ctx(m.userId), { title: "Close books", nextRunAt: "2031-01-31T10:00:00Z", recurrence: "MONTHLY" });
    await processReminders(new Date("2031-01-31T10:00:05Z"));
    const row = await prisma.reminder.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.nextRunAt.toISOString()).toBe("2031-02-28T10:00:00.000Z");
  });

  it("overlapping runs do not double-notify", async () => {
    const m = await a.addMember("sales_executive");
    const { createReminder } = await import("@/features/notifications/reminders");
    const r = await createReminder(await a.ctx(m.userId), { title: "Weekly review", nextRunAt: "2030-05-06T07:00:00Z", recurrence: "WEEKLY" });
    const now = new Date("2030-05-06T07:00:01Z");
    await Promise.all([processReminders(now), processReminders(now), processReminders(now)]);
    expect(await reminderNotes(m.userId)).toHaveLength(1);
    const row = await prisma.reminder.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.fireCount).toBe(1);
    expect(row.nextRunAt.toISOString()).toBe("2030-05-13T07:00:00.000Z");
  });

  it("disabled preference suppresses the notification but still advances", async () => {
    const m = await a.addMember("sales_executive");
    await signInAs(m.userId);
    expect((await call(prefsRoute.PATCH, { method: "PATCH", body: { reminders: false } })).json.data.reminders).toBe(false);
    const { createReminder } = await import("@/features/notifications/reminders");
    const r = await createReminder(await a.ctx(m.userId), { title: "Muted", nextRunAt: "2030-06-01T07:00:00Z", recurrence: "DAILY" });
    await processReminders(new Date("2030-06-01T07:00:01Z"));
    expect(await reminderNotes(m.userId)).toHaveLength(0);
    expect((await prisma.reminder.findUniqueOrThrow({ where: { id: r.id } })).fireCount).toBe(1);
  });

  it("validation, other-user rules and access", async () => {
    const exec = await a.addMember("sales_executive");
    const manager = await a.addMember("sales_manager");
    await signInAs(exec.userId);
    expect((await call(remindersRoute.POST, { method: "POST", body: { title: "", nextRunAt: "2030-01-01" } })).status).toBe(422);
    expect((await call(remindersRoute.POST, { method: "POST", body: { title: "x", nextRunAt: "2030-01-02", endsAt: "2030-01-01" } })).status).toBe(422);
    expect((await call(remindersRoute.POST, { method: "POST", body: { title: "x", nextRunAt: "2030-01-02", recurrence: "HOURLY" } })).status).toBe(422);
    expect((await call(remindersRoute.POST, { method: "POST", body: { title: "for you", nextRunAt: "2030-01-02", userId: manager.userId } })).status).toBe(403);

    await signInAs(manager.userId);
    expect((await call(remindersRoute.POST, { method: "POST", body: { title: "outsider", nextRunAt: "2030-01-02", userId: b.ownerId } })).status).toBe(422);
    const forExec = await call(remindersRoute.POST, { method: "POST", body: { title: "for exec", nextRunAt: "2030-01-02", userId: exec.userId } });
    expect(forExec.status).toBe(201);

    // exec sees it (it's theirs); a peer without task.view_all does not; other tenants get 404
    const peer = await a.addMember("sales_executive");
    await signInAs(exec.userId);
    expect((await call(reminderRoute.GET, { params: { id: forExec.json.data.id } })).status).toBe(200);
    await signInAs(peer.userId);
    expect((await call(reminderRoute.GET, { params: { id: forExec.json.data.id } })).status).toBe(404);
    expect((await call(reminderRoute.DELETE, { method: "DELETE", params: { id: forExec.json.data.id } })).status).toBe(404);
    await signInAs(b.ownerId);
    expect((await call(reminderRoute.GET, { params: { id: forExec.json.data.id } })).status).toBe(404);

    await signInAs(exec.userId);
    const patched = await call(reminderRoute.PATCH, { method: "PATCH", params: { id: forExec.json.data.id }, body: { title: "renamed", isActive: false } });
    expect(patched.json.data).toMatchObject({ title: "renamed", isActive: false });
    expect((await call(reminderRoute.DELETE, { method: "DELETE", params: { id: forExec.json.data.id } })).status).toBe(200);
  });
});

// ─── Notification history & preferences ───────────────────────────────────────

describe("notification history", () => {
  it("dedupeKey never notifies twice", async () => {
    const m = await a.addMember("sales_executive");
    const send = () => createSystemNotification({ organizationId: a.org.id, userId: m.userId, type: "x.test", title: "once", dedupeKey: "k:1" });
    await send();
    expect(await send()).toBeNull();
    expect(await prisma.notification.count({ where: { userId: m.userId, dedupeKey: "k:1" } })).toBe(1);
  });

  it("lists with filters, marks read, and only shows the caller's own", async () => {
    const m = await a.addMember("sales_executive");
    const other = await a.addMember("sales_executive");
    const base = { organizationId: a.org.id, userId: m.userId };
    await prisma.notification.createMany({
      data: [
        { ...base, type: "invoice.overdue", title: "Overdue 1", createdAt: new Date("2030-02-01T00:00:00Z") },
        { ...base, type: "invoice.overdue", title: "Overdue 2", createdAt: new Date("2030-02-05T00:00:00Z") },
        { ...base, type: "task.reminder", title: "Task", createdAt: new Date("2030-02-10T00:00:00Z"), readAt: new Date() },
        { organizationId: a.org.id, userId: other.userId, type: "task.reminder", title: "Not mine" },
      ],
    });
    await signInAs(m.userId);
    const all = await call(notificationsRoute.GET);
    expect(all.json.data).toMatchObject({ total: 3, unread: 2 });
    expect((await call(notificationsRoute.GET, { query: "unread=true" })).json.data.total).toBe(2);
    expect((await call(notificationsRoute.GET, { query: "type=task.reminder" })).json.data.total).toBe(1);
    expect((await call(notificationsRoute.GET, { query: "from=2030-02-04&to=2030-02-06" })).json.data.items.map((n: { title: string }) => n.title)).toEqual(["Overdue 2"]);
    expect((await call(notificationsRoute.GET, { query: "sort=title" })).status).toBe(422);

    const first = all.json.data.items.find((n: { title: string }) => n.title === "Overdue 1");
    expect((await call(readRoute.POST, { method: "POST", params: { id: first.id } })).json.data.readAt).not.toBeNull();
    const notMine = await prisma.notification.findFirstOrThrow({ where: { userId: other.userId } });
    expect((await call(readRoute.POST, { method: "POST", params: { id: notMine.id } })).status).toBe(404);
    expect((await call(readAllRoute.POST, { method: "POST", body: {} })).json.data.count).toBe(1);
    expect((await call(notificationsRoute.GET, { query: "unread=true" })).json.data.total).toBe(0);
    expect(await prisma.notification.count({ where: { userId: other.userId, readAt: null } })).toBe(1);
  });

  it("preferences: all keys, unknown key rejected, disabled key suppresses", async () => {
    const m = await a.addMember("sales_executive");
    await signInAs(m.userId);
    const got = await call(prefsRoute.GET);
    expect(got.json.data).toMatchObject({ approvalRequests: true, reminders: true, taskNotifications: true, browserNotifications: false });
    expect((await call(prefsRoute.PATCH, { method: "PATCH", body: { bogus: true } })).status).toBe(422);
    expect((await call(prefsRoute.PATCH, { method: "PATCH", body: { approvalRequests: "no" } })).status).toBe(422);
    await call(prefsRoute.PATCH, { method: "PATCH", body: { approvalRequests: false } });
    const sent = await createSystemNotification({ organizationId: a.org.id, userId: m.userId, type: "approval.requested", title: "Approve", preferenceKey: "approvalRequests" });
    expect(sent).toBeNull();
  });
});

// ─── Documents ────────────────────────────────────────────────────────────────

describe("documents", () => {
  it("stores a sha256 checksum and rejects content that does not match the declared type", async () => {
    await signInAs(a.ownerId);
    const company = { type: "company", id: a.company.id };
    const ok = await upload(company, { bytes: PDF, name: "contract.pdf", type: "application/pdf" });
    expect(ok.status).toBe(201);
    expect(ok.json.data).toMatchObject({ checksum: createHash("sha256").update(PDF).digest("hex"), version: 1, versionGroupId: ok.json.data.id });

    expect((await upload(company, { bytes: PNG, name: "fake.pdf", type: "application/pdf" })).status).toBe(422);
    expect((await upload(company, { bytes: PDF, name: "fake.png", type: "image/png" })).status).toBe(422);
    expect((await upload(company, { bytes: Buffer.from([0x4d, 0x5a, 0, 1, 2]), name: "x.txt", type: "text/plain" })).status).toBe(422);
    expect((await upload(company, { bytes: Buffer.from("<html>"), name: "x.html", type: "text/html" })).status).toBe(422);
    expect((await upload(company, { bytes: PDF, name: "x.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).status).toBe(422);
    expect((await upload(company, { bytes: DOCX, name: "x.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).status).toBe(201);
    expect((await upload(company, { bytes: Buffer.from("a,b\n1,2\n"), name: "x.csv", type: "text/csv" })).status).toBe(201);
    expect((await upload(company, { bytes: PNG, name: "x.png", type: "image/png" })).status).toBe(201);
  });

  it("numbers versions gaplessly, lists latest only by default", async () => {
    await signInAs(a.ownerId);
    const entity = { type: "branch", id: a.branch.id };
    const v1 = (await upload(entity, { bytes: PDF, name: "policy.pdf", type: "application/pdf" })).json.data;
    const v2 = await upload(null, { bytes: Buffer.concat([PDF, Buffer.from("v2")]), name: "policy.pdf", type: "application/pdf" }, v1.id);
    expect(v2.status).toBe(201);
    expect(v2.json.data).toMatchObject({ version: 2, versionGroupId: v1.id, entityType: "branch", entityId: a.branch.id });
    // concurrent uploads, even against an old version id, still get distinct consecutive numbers
    const [x, y] = await Promise.all([
      upload(null, { bytes: PDF, name: "p.pdf", type: "application/pdf" }, v1.id),
      upload(null, { bytes: PDF, name: "p.pdf", type: "application/pdf" }, v2.json.data.id),
    ]);
    expect([x.json.data.version, y.json.data.version].sort()).toEqual([3, 4]);
    expect((await upload(null, { bytes: PNG, name: "p.pdf", type: "application/pdf" }, v1.id)).status).toBe(422);

    const latest = await call(documentsRoute.GET, { query: `entityType=branch&entityId=${a.branch.id}` });
    expect(latest.json.data).toHaveLength(1);
    expect(latest.json.data[0].version).toBe(4);
    expect((await call(documentsRoute.GET, { query: `entityType=branch&entityId=${a.branch.id}&allVersions=true` })).json.data).toHaveLength(4);
    const versions = await call(versionsRoute.GET, { params: { id: v1.id } });
    expect(versions.json.data.items.map((d: { version: number }) => d.version)).toEqual([4, 3, 2, 1]);
    expect(versions.json.data.items.filter((d: { supersededAt: string | null }) => !d.supersededAt)).toHaveLength(1);
  });

  it("access follows the attached record: 404 out of scope or tenant, 403 without permission", async () => {
    await signInAs(a.ownerId);
    const hidden = (await upload({ type: "company", id: company2 }, { bytes: PDF, name: "secret.pdf", type: "application/pdf" })).json.data;
    const viewer = await a.addMember("viewer"); // scoped to the default company only
    await signInAs(viewer.userId);
    expect((await call(documentRoute.GET, { params: { id: hidden.id } })).status).toBe(404);
    expect((await call(versionsRoute.GET, { params: { id: hidden.id } })).status).toBe(404);
    expect((await call(documentsRoute.GET, { query: `entityType=company&entityId=${company2}` })).status).toBe(404);
    expect((await upload({ type: "company", id: a.company.id }, { bytes: PDF, name: "v.pdf", type: "application/pdf" })).status).toBe(403);
    expect((await call(documentRoute.DELETE, { method: "DELETE", params: { id: hidden.id } })).status).toBe(403);
    await signInAs(b.ownerId);
    expect((await call(documentRoute.GET, { params: { id: hidden.id } })).status).toBe(404);
    expect((await upload(null, { bytes: PDF, name: "v.pdf", type: "application/pdf" }, hidden.id)).status).toBe(404);
    expect((await call(signaturesRoute.POST, { method: "POST", body: { documentId: hidden.id, signers: [{ name: "X", email: "x@test.local" }] } })).status).toBe(404);
  });
});

// ─── E-signatures ─────────────────────────────────────────────────────────────

describe("e-signatures", () => {
  it("is NOT_CONFIGURED until a provider is connected", async () => {
    const c = await createOrg("NotifDocs NoProvider");
    await signInAs(c.ownerId);
    const doc = (await upload({ type: "company", id: c.company.id }, { bytes: PDF, name: "a.pdf", type: "application/pdf" })).json.data;
    const res = await call(signaturesRoute.POST, { method: "POST", body: { documentId: doc.id, signers: [{ name: "Asha", email: "asha@test.local" }] } });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("NOT_CONFIGURED");
    await prisma.integration.create({ data: { organizationId: c.org.id, provider: "esign_mock", status: "DISCONNECTED" } });
    expect((await call(signaturesRoute.POST, { method: "POST", body: { documentId: doc.id, signers: [{ name: "Asha", email: "asha@test.local" }] } })).json.code).toBe("NOT_CONFIGURED");
  });

  it("full lifecycle through a verified webhook; simulated; no user path to SIGNED", async () => {
    await connect(a.org.id, "esign_mock");
    await signInAs(a.ownerId);
    const doc = (await upload({ type: "company", id: a.company.id }, { bytes: PDF, name: "nda.pdf", type: "application/pdf" })).json.data;
    const png = (await upload({ type: "company", id: a.company.id }, { bytes: PNG, name: "sig.png", type: "image/png" })).json.data;
    const signers = [{ name: "Asha Rao", email: "Asha@Test.local" }];

    expect((await call(signaturesRoute.POST, { method: "POST", body: { documentId: png.id, signers } })).status).toBe(422);
    expect((await call(signaturesRoute.POST, { method: "POST", body: { documentId: doc.id, signers: [{ name: "A", email: "nope" }] } })).status).toBe(422);
    expect((await call(signaturesRoute.POST, { method: "POST", body: { documentId: doc.id, signers: [] } })).status).toBe(422);

    const exec = await a.addMember("sales_executive");
    await signInAs(exec.userId);
    expect((await call(signaturesRoute.POST, { method: "POST", body: { documentId: doc.id, signers } })).status).toBe(403);

    await signInAs(a.ownerId);
    const created = await call(signaturesRoute.POST, { method: "POST", body: { documentId: doc.id, signers } });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ status: "DRAFT", simulated: true, notice: "Simulated – not a legal signature", signers: [{ email: "asha@test.local", order: 1 }] });
    const id = created.json.data.id;
    expect((await call(signaturesRoute.POST, { method: "POST", body: { documentId: doc.id, signers } })).status).toBe(409);

    // nothing a user can call marks it signed
    for (const action of ["sign", "complete", "mark-signed", "signed"]) {
      expect((await call(signatureActionRoute.POST, { method: "POST", params: { id, action } })).status).toBe(404);
    }
    expect(Object.keys(signatureRoute)).toEqual(["GET"]);
    expect(Object.keys(signatureActionRoute)).toEqual(["POST"]);

    const sent = await call(signatureActionRoute.POST, { method: "POST", params: { id, action: "send" } });
    expect(sent.json.data).toMatchObject({ status: "SENT" });
    const providerRequestId = sent.json.data.providerRequestId as string;
    expect(providerRequestId).toMatch(/^mock_/);
    expect((await call(signatureActionRoute.POST, { method: "POST", params: { id, action: "send" } })).status).toBe(422);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).signatureStatus).toBe("PENDING");
    // polling the mock changes nothing
    expect((await call(signatureActionRoute.POST, { method: "POST", params: { id, action: "refresh" } })).json.data.status).toBe("SENT");

    const event = (eventId: string, status: string) => ({ eventId, requestId: providerRequestId, status, evidence: { auditTrail: `trail-${eventId}` } });
    const bad = await webhook("esign_mock", event("e-bad", "SIGNED"), { secret: "wrong-secret" });
    const unknownProvider = await webhook("docusign_fake", event("e-x", "SIGNED"));
    const unknownEnvelope = await webhook("esign_mock", { ...event("e-y", "SIGNED"), requestId: "mock_missing" });
    const stale = await webhook("esign_mock", event("e-stale", "SIGNED"), { timestamp: Date.now() - 10 * 60_000 });
    for (const r of [bad, unknownProvider, unknownEnvelope, stale]) {
      expect(r.status).toBe(401);
      expect(r.json).toEqual({ ok: false, error: "Unauthorized" });
    }
    expect((await prisma.signatureRequest.findUniqueOrThrow({ where: { id } })).status).toBe("SENT");

    expect((await webhook("esign_mock", event("e-1", "VIEWED"))).json.data).toEqual({ duplicate: false, status: "PROCESSED" });
    expect((await webhook("esign_mock", event("e-2", "SIGNED"))).json.data).toEqual({ duplicate: false, status: "PROCESSED" });
    const dup = await webhook("esign_mock", event("e-2", "SIGNED"));
    expect(dup.status).toBe(200);
    expect(dup.json.data.duplicate).toBe(true);
    // a late out-of-order event is acknowledged but ignored
    expect((await webhook("esign_mock", event("e-3", "VIEWED"))).json.data.status).toBe("IGNORED");
    expect(await prisma.webhookEvent.count({ where: { organizationId: a.org.id, provider: "esign_mock" } })).toBe(3);

    const done = await call(signatureRoute.GET, { params: { id } });
    expect(done.json.data).toMatchObject({ status: "SIGNED", simulated: true, notice: "Simulated – not a legal signature", evidence: { auditTrail: "trail-e-2" } });
    expect(done.json.data.completedAt).not.toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).signatureStatus).toBe("SIGNED");

    // signed documents cannot be deleted or voided
    const del = await call(documentRoute.DELETE, { method: "DELETE", params: { id: doc.id } });
    expect(del.status).toBe(422);
    expect(del.json.code).toBe("SIGNED_DOCUMENT");
    expect((await call(signatureActionRoute.POST, { method: "POST", params: { id, action: "void" } })).status).toBe(422);
    expect((await call(signaturesRoute.GET, { query: `documentId=${doc.id}` })).json.data).toHaveLength(1);
  });

  it("void cancels an open request; documents out for signature cannot be deleted", async () => {
    await signInAs(a.ownerId);
    const doc = (await upload({ type: "company", id: a.company.id }, { bytes: PDF, name: "q.pdf", type: "application/pdf" })).json.data;
    const id = (await call(signaturesRoute.POST, { method: "POST", body: { documentId: doc.id, signers: [{ name: "B", email: "b@test.local" }] } })).json.data.id;
    await call(signatureActionRoute.POST, { method: "POST", params: { id, action: "send" } });
    expect((await call(documentRoute.DELETE, { method: "DELETE", params: { id: doc.id } })).json.code).toBe("SIGNATURE_PENDING");
    expect((await call(signatureActionRoute.POST, { method: "POST", params: { id, action: "void" } })).json.data.status).toBe("VOIDED");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).signatureStatus).toBe("VOIDED");
    expect((await call(documentRoute.DELETE, { method: "DELETE", params: { id: doc.id } })).status).toBe(200);
  });

  it("stores a provider's signed file as the next version", async () => {
    ESIGN_PROVIDERS.esign_test = {
      ...mockESignProvider,
      key: "esign_test",
      downloadSigned: async () => Buffer.concat([PDF, Buffer.from("%signed")]),
    };
    const c = await createOrg("NotifDocs Signed");
    await connect(c.org.id, "esign_test");
    await signInAs(c.ownerId);
    const doc = (await upload({ type: "company", id: c.company.id }, { bytes: PDF, name: "deed.pdf", type: "application/pdf" })).json.data;
    const id = (await call(signaturesRoute.POST, { method: "POST", body: { documentId: doc.id, signers: [{ name: "C", email: "c@test.local" }] } })).json.data.id;
    const { providerRequestId } = (await call(signatureActionRoute.POST, { method: "POST", params: { id, action: "send" } })).json.data;
    const payload = { eventId: "s-1", requestId: providerRequestId, status: "SIGNED", evidence: { certificate: "cert-1" } };
    await Promise.all([webhook("esign_test", payload), webhook("esign_test", { ...payload, eventId: "s-2" })]);

    const request = await prisma.signatureRequest.findUniqueOrThrow({ where: { id } });
    expect(request.status).toBe("SIGNED");
    const versions = (await call(versionsRoute.GET, { params: { id: doc.id } })).json.data.items;
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ id: request.signedDocumentId, version: 2, signatureStatus: "SIGNED", fileName: "deed-signed.pdf" });
    delete ESIGN_PROVIDERS.esign_test;
  });
});
