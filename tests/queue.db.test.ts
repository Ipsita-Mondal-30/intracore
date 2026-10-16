import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { enqueue, processQueue, STALE_LOCK_MS } from "@/lib/queue";
import { sanitizeError } from "@/lib/sanitize";
import { createSystemNotification } from "@/lib/notifications/create";
import { checkConsent, normalizeAddress, queueMessage, renderTemplate } from "@/features/communication/send";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";

const calls: string[] = [];
vi.mock("@/lib/queue-handlers", () => ({
  QUEUE_HANDLERS: {
    "test.ok": async (p: { n: string }) => { calls.push(p.n); return { done: p.n }; },
    "test.fail": async () => { throw new Error("upstream 500 Authorization: Bearer FAKE-TOKEN-0123456789abcdef"); },
    "test.slow": async (p: { n: string }) => { await new Promise((r) => setTimeout(r, 50)); calls.push(p.n); },
  },
}));

let a: OrgFixture;
const T = ["test.ok", "test.fail", "test.slow"];
const job = (type: "test.ok" | "test.fail" | "test.slow", key: string, extra: object = {}) =>
  enqueue(prisma, { type: type as never, key: `${a.org.id}:${key}`, organizationId: a.org.id, payload: { n: key }, ...extra });

beforeAll(async () => {
  a = await createOrg("Queue A");
});
afterAll(cleanupFixtures);

describe("background queue", () => {
  it("enqueue is idempotent on key", async () => {
    const one = await job("test.ok", "k1");
    const two = await job("test.ok", "k1");
    expect(two.id).toBe(one.id);
    expect(await prisma.backgroundJob.count({ where: { key: `${a.org.id}:k1` } })).toBe(1);
  });

  it("runs due jobs once, even with overlapping runners", async () => {
    await job("test.slow", "k2");
    const [r1, r2] = await Promise.all([processQueue({ types: T }), processQueue({ types: T })]);
    expect(r1.succeeded + r2.succeeded).toBe(2); // k1 and k2
    expect(calls.filter((c) => c === "k2")).toHaveLength(1);
    const done = await prisma.backgroundJob.findUniqueOrThrow({ where: { key: `${a.org.id}:k1` } });
    expect(done).toMatchObject({ status: "SUCCEEDED", attempts: 1, result: { done: "k1" } });
    expect((await processQueue({ types: T })).claimed).toBe(0);
  });

  it("does not run jobs before runAt", async () => {
    await job("test.ok", "later", { runAt: new Date(Date.now() + 3600_000) });
    expect((await processQueue({ types: T })).claimed).toBe(0);
  });

  it("retries with backoff, sanitizes errors, and goes DEAD after maxAttempts", async () => {
    await job("test.fail", "f1", { maxAttempts: 2 });
    const t0 = new Date();
    expect(await processQueue({ types: T, now: t0 })).toMatchObject({ retried: 1, dead: 0 });
    let row = await prisma.backgroundJob.findUniqueOrThrow({ where: { key: `${a.org.id}:f1` } });
    expect(row).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(row.runAt.getTime()).toBe(t0.getTime() + 60_000);
    expect(row.lastError).toContain("[redacted]");
    expect(row.lastError).not.toContain("FAKE-TOKEN");

    expect((await processQueue({ types: T, now: new Date(t0.getTime() + 30_000) })).claimed).toBe(0); // backoff
    expect(await processQueue({ types: T, now: new Date(t0.getTime() + 61_000) })).toMatchObject({ dead: 1 });
    row = await prisma.backgroundJob.findUniqueOrThrow({ where: { key: `${a.org.id}:f1` } });
    expect(row).toMatchObject({ status: "DEAD", attempts: 2 });
    expect((await processQueue({ types: ["test.fail"], now: new Date(t0.getTime() + 86_400_000) })).claimed).toBe(0);
  });

  it("reclaims jobs whose runner died mid-flight", async () => {
    const j = await job("test.ok", "stale");
    await prisma.backgroundJob.update({ where: { id: j.id }, data: { status: "RUNNING", lockedAt: new Date(Date.now() - STALE_LOCK_MS - 1000), attempts: 1 } });
    expect(await processQueue({ types: T })).toMatchObject({ succeeded: 1 });
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  });
});

describe("sanitizeError", () => {
  it("redacts tokens and secrets", () => {
    const text = sanitizeError(new Error('GET /x?access_token=EAAB123456789012345678901234 failed {"secret":"abc123"}'));
    expect(text).not.toMatch(/EAAB1234|abc123/);
  });
});

describe("notification dedupe", () => {
  it("never notifies the same recipient twice for one key", async () => {
    const n = { organizationId: a.org.id, userId: a.ownerId, type: "TEST", title: "Hi", dedupeKey: "evt-1" };
    expect(await createSystemNotification(n)).not.toBeNull();
    expect(await createSystemNotification(n)).toBeNull();
    expect(await prisma.notification.count({ where: { organizationId: a.org.id, dedupeKey: "evt-1" } })).toBe(1);
  });
});

describe("queueMessage consent", () => {
  let email: string;
  let promo: string;
  let wa: string;
  beforeAll(async () => {
    const mk = (channel: "EMAIL" | "WHATSAPP", name: string, category: string) =>
      prisma.messageTemplate.create({ data: { organizationId: a.org.id, channel, name, category, body: "Hi {{name}}", variables: ["name"] } });
    email = (await mk("EMAIL", "receipt", "TRANSACTIONAL")).id;
    promo = (await mk("EMAIL", "promo", "MARKETING")).id;
    wa = (await mk("WHATSAPP", "update", "TRANSACTIONAL")).id;
  });
  const send = (templateId: string, channel: "EMAIL" | "WHATSAPP", to: string, key: string) =>
    queueMessage(prisma, { organizationId: a.org.id, channel, to, templateId, variables: { name: "Asha" }, idempotencyKey: key });

  it("normalizes addresses and renders declared variables only", () => {
    expect(normalizeAddress("EMAIL", " A@B.co ")).toBe("a@b.co");
    expect(normalizeAddress("SMS", "+91 98765-43210")).toBe("919876543210");
    expect(normalizeAddress("SMS", "12")).toBeNull();
    expect(() => renderTemplate({ body: "{{x}}", subject: null, variables: [] }, { x: "1" })).toThrow(/Undeclared/);
    expect(() => renderTemplate({ body: "{{x}}", subject: null, variables: ["x"] }, {})).toThrow(/Missing/);
  });

  it("allows transactional email, blocks marketing without opt-in and anyone opted out", async () => {
    const ok = await send(email, "EMAIL", "c@x.com", "m1");
    expect(ok.status).toBe("QUEUED");
    expect(await prisma.backgroundJob.count({ where: { key: `communication.deliver:${ok.id}` } })).toBe(1);
    expect((await send(email, "EMAIL", "c@x.com", "m1")).id).toBe(ok.id); // idempotent

    expect(await send(promo, "EMAIL", "c@x.com", "m2")).toMatchObject({ status: "BLOCKED", error: "NO_CONSENT" });
    await prisma.contactConsent.create({ data: { organizationId: a.org.id, channel: "EMAIL", address: "c@x.com", purpose: "MARKETING", status: "OPTED_IN" } });
    expect((await send(promo, "EMAIL", "c@x.com", "m3")).status).toBe("QUEUED");

    await prisma.contactConsent.create({ data: { organizationId: a.org.id, channel: "EMAIL", address: "out@x.com", purpose: "TRANSACTIONAL", status: "OPTED_OUT" } });
    expect(await send(email, "EMAIL", "out@x.com", "m4")).toMatchObject({ status: "BLOCKED", error: "OPTED_OUT" });
    expect(await send(email, "EMAIL", "not-an-email", "m5")).toMatchObject({ status: "BLOCKED", error: "INVALID_ADDRESS" });
  });

  it("requires WhatsApp opt-in even for transactional messages", async () => {
    expect((await checkConsent(prisma, a.org.id, "WHATSAPP", "919876543210", "TRANSACTIONAL")).allowed).toBe(false);
    expect(await send(wa, "WHATSAPP", "+91 98765 43210", "w1")).toMatchObject({ status: "BLOCKED", error: "NO_CONSENT" });
  });

  it("rejects a template from another channel", async () => {
    await expect(send(wa, "EMAIL", "c@x.com", "w2")).rejects.toMatchObject({ status: 422 });
  });
});
