import { createHmac, randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { processQueue } from "@/lib/queue";
import { queueMessage } from "@/features/communication/send";
import { deliverMessage } from "@/features/communication/deliver";
import { createTemplate, updateTemplate } from "@/features/communication/templates";
import { optOut, recordConsent } from "@/features/communication/consent";
import { checkIntegration, configureIntegration, setIntegrationEnabled } from "@/features/integrations/service";
import * as integrationsRoute from "@/app/api/v1/integrations/route";
import * as integrationRoute from "@/app/api/v1/integrations/[provider]/route";
import * as communicationsRoute from "@/app/api/v1/communications/route";
import * as communicationRoute from "@/app/api/v1/communications/[id]/route";
import * as templateRoute from "@/app/api/v1/message-templates/[id]/route";
import * as jobReplayRoute from "@/app/api/v1/background-jobs/[id]/replay/route";
import * as jobRoute from "@/app/api/v1/background-jobs/[id]/route";
import * as eventsRoute from "@/app/api/v1/webhook-events/route";
import * as waWebhook from "@/app/api/webhooks/whatsapp/[integrationId]/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let a: OrgFixture;
let b: OrgFixture;
let viewer: string;
let tpl: { email: string; sms: string; wa: string; waPromo: string };
const WA_TOKEN = "EAAGsecretTokenValue1234567890abcdef";
const APP_SECRET = "app-secret-123";
const VERIFY = "verify-me-456";
const PNID = `pn${randomUUID().slice(0, 8)}`;
let waIntegrationId: string;
const T = (...types: string[]) => ({ types });

const logFor = (id: string) => prisma.communicationLog.findUniqueOrThrow({ where: { id } });
const jobFor = (logId: string) => prisma.backgroundJob.findUniqueOrThrow({ where: { key: `communication.deliver:${logId}` } });
const send = (templateId: string, channel: "EMAIL" | "SMS" | "WHATSAPP", to: string, variables: Record<string, string> = { name: "Asha" }) =>
  queueMessage(prisma, { organizationId: a.org.id, channel, to, templateId, variables, idempotencyKey: randomUUID() });

beforeAll(async () => {
  a = await createOrg("Comms A");
  b = await createOrg("Comms B");
  viewer = (await a.addMember("viewer")).userId;
  const ctx = await a.ctx(a.ownerId);
  tpl = {
    email: (await createTemplate(ctx, { channel: "EMAIL", name: "receipt", subject: "Receipt for {{name}}", body: "Hi {{name}}", variables: "name" })).id,
    sms: (await createTemplate(ctx, { channel: "SMS", name: "otp", body: "Hi {{name}}", variables: ["name"] })).id,
    wa: (await createTemplate(ctx, { channel: "WHATSAPP", name: "shipped", body: "Hi {{name}}, order {{order}} shipped", variables: ["name", "order"], providerTemplateName: "order_shipped", language: "en_US" })).id,
    waPromo: (await createTemplate(ctx, { channel: "WHATSAPP", name: "promo", category: "MARKETING", body: "Sale for {{name}}", variables: ["name"], providerTemplateName: "promo_sale" })).id,
  };
});
afterAll(cleanupFixtures);

describe("templates", () => {
  it("requires declared placeholders, provider names for WhatsApp, and administer permission", async () => {
    const ctx = await a.ctx(a.ownerId);
    await expect(createTemplate(ctx, { channel: "SMS", name: "bad", body: "Hi {{who}}" })).rejects.toMatchObject({ status: 422 });
    await expect(createTemplate(ctx, { channel: "WHATSAPP", name: "bad2", body: "Hi" })).rejects.toMatchObject({ status: 422 });
    await expect(updateTemplate(ctx, tpl.sms, { body: "Hi {{name}} {{x}}" })).rejects.toMatchObject({ status: 422 });
    await expect(createTemplate(await a.ctx(viewer), { channel: "SMS", name: "v", body: "Hi" })).rejects.toMatchObject({ status: 403 });
  });

  it("inactive templates cannot be used", async () => {
    const ctx = await a.ctx(a.ownerId);
    const t = await createTemplate(ctx, { channel: "SMS", name: "old", body: "Hi" });
    await updateTemplate(ctx, t.id, { isActive: false });
    await expect(send(t.id, "SMS", "+91 98765 43210")).rejects.toMatchObject({ status: 422 });
  });
});

describe("integrations: encrypted secrets", () => {
  it("stores secrets encrypted and never returns them", async () => {
    await signInAs(viewer);
    expect((await call(integrationRoute.PUT, { method: "PUT", params: { provider: "whatsapp_cloud" }, body: {} })).status).toBe(403);

    await signInAs(a.ownerId);
    const res = await call(integrationRoute.PUT, {
      method: "PUT",
      params: { provider: "whatsapp_cloud" },
      body: { config: { phoneNumberId: PNID }, secrets: { accessToken: WA_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY } },
    });
    expect(res.status).toBe(200);
    expect(res.json.data.secretsConfigured).toEqual({ accessToken: true, appSecret: true, verifyToken: true });
    expect(JSON.stringify(res.json)).not.toContain(WA_TOKEN);
    waIntegrationId = res.json.data.id;

    const list = await call(integrationsRoute.GET);
    expect(JSON.stringify(list.json)).not.toMatch(new RegExp(`${WA_TOKEN}|${APP_SECRET}|${VERIFY}`));
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: waIntegrationId } });
    expect(row.secrets).toBeTruthy();
    expect(row.secrets).not.toContain(WA_TOKEN);
    expect(row.secrets).not.toContain(APP_SECRET);

    // blank secrets keep the stored values; unknown providers are rejected
    const again = await call(integrationRoute.PUT, { method: "PUT", params: { provider: "whatsapp_cloud" }, body: { config: { phoneNumberId: PNID }, secrets: { accessToken: "" } } });
    expect(again.json.data.secretsConfigured.accessToken).toBe(true);
    expect((await call(integrationRoute.GET, { params: { provider: "evil" } })).status).toBe(404);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, entity: "integration" } });
    expect(JSON.stringify(auditRows)).not.toContain(WA_TOKEN);
  });

  it("records a health check timeout", async () => {
    const ctx = await a.ctx(a.ownerId);
    await setIntegrationEnabled(ctx, "whatsapp_cloud", true);
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const result = await checkIntegration(ctx, "whatsapp_cloud");
    expect(result.ok).toBe(false);
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: waIntegrationId } });
    expect(row).toMatchObject({ status: "ERROR" });
    expect(row.lastError).toMatch(/Timed out/);
    expect(row.lastCheckedAt).not.toBeNull();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: PNID }));
    expect((await checkIntegration(ctx, "whatsapp_cloud")).ok).toBe(true);
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: waIntegrationId } })).toMatchObject({ status: "CONNECTED", lastError: null });
  });
});

describe("delivery", () => {
  it("mock provider marks messages simulated and SENT, never contacting anything", async () => {
    await setIntegrationEnabled(await a.ctx(a.ownerId), "mock_email", true);
    const log = await send(tpl.email, "EMAIL", "c@x.com");
    await processQueue(T("communication.deliver"));
    expect(await logFor(log.id)).toMatchObject({ status: "SENT", simulated: true, provider: "mock_email", attempts: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    await deliverMessage({ logId: log.id }); // idempotent
    expect((await logFor(log.id)).attempts).toBe(1);

    await signInAs(a.ownerId);
    expect((await call(communicationRoute.GET, { params: { id: log.id } })).json.data.simulated).toBe(true);
  });

  it("NOT_CONFIGURED fails the message without a retry loop", async () => {
    const log = await send(tpl.sms, "SMS", "+91 98765 43210");
    await processQueue(T("communication.deliver"));
    expect(await logFor(log.id)).toMatchObject({ status: "FAILED" });
    expect((await logFor(log.id)).error).toMatch(/NOT_CONFIGURED/);
    expect(await jobFor(log.id)).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
  });

  it("sends WhatsApp templates with ordered parameters; the token stays in the header", async () => {
    await prisma.contactConsent.create({ data: { organizationId: a.org.id, channel: "WHATSAPP", address: "919876543210", purpose: "TRANSACTIONAL", status: "OPTED_IN" } });
    const wamid = `wamid.${randomUUID()}`;
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: wamid }] }));
    const log = await send(tpl.wa, "WHATSAPP", "+91 98765 43210", { order: "SO-1", name: "Asha" });
    await deliverMessage({ logId: log.id, variables: { order: "SO-1", name: "Asha" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://graph.facebook.com/v21.0/${PNID}/messages`);
    expect(url).not.toContain(WA_TOKEN);
    expect(init.headers.authorization).toBe(`Bearer ${WA_TOKEN}`);
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ to: "919876543210", type: "template", template: { name: "order_shipped", language: { code: "en_US" } } });
    expect(sent.template.components[0].parameters).toEqual([{ type: "text", text: "Asha" }, { type: "text", text: "SO-1" }]);
    expect(init.body).not.toContain(WA_TOKEN);
    expect(await logFor(log.id)).toMatchObject({ status: "SENT", simulated: false, provider: "whatsapp_cloud", providerMessageId: wamid });
  });

  it("permanent provider errors fail without retry and are sanitized", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { code: 131009, message: `Invalid parameter access_token=${WA_TOKEN}` } }));
    const log = await send(tpl.wa, "WHATSAPP", "919876543210", { name: "A", order: "1" });
    await processQueue(T("communication.deliver"));
    const row = await logFor(log.id);
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/HTTP_400/);
    expect(row.error).not.toContain(WA_TOKEN);
    expect(await jobFor(log.id)).toMatchObject({ status: "SUCCEEDED" });
  });

  it("transient errors retry with backoff, go DEAD, and can be replayed (job.replay only)", async () => {
    const ctx = await a.ctx(a.ownerId);
    await configureIntegration(ctx, "email_resend", { config: { fromEmail: "Acme <a@acme.test>" }, secrets: { apiKey: "re_live_supersecretkey12345678" } });
    await setIntegrationEnabled(ctx, "email_resend", true); // disables mock_email (one provider per channel)
    fetchMock.mockImplementation(async () => jsonResponse(500, { message: "upstream exploded Authorization: Bearer re_live_supersecretkey12345678" }));
    const log = await send(tpl.email, "EMAIL", "d@x.com");
    const job = await jobFor(log.id);
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { maxAttempts: 2 } });

    const t0 = new Date();
    await processQueue({ ...T("communication.deliver"), now: t0 });
    let j = await jobFor(log.id);
    expect(j).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(j.runAt.getTime()).toBe(t0.getTime() + 60_000);
    expect(j.lastError).not.toContain("supersecret");
    expect(await logFor(log.id)).toMatchObject({ status: "QUEUED" });
    expect(fetchMock.mock.calls[0][1].headers["idempotency-key"]).toBe(log.id);

    await processQueue({ ...T("communication.deliver"), now: new Date(t0.getTime() + 61_000) });
    j = await jobFor(log.id);
    expect(j).toMatchObject({ status: "DEAD", attempts: 2 });
    const failed = await logFor(log.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).not.toContain("supersecret");

    await signInAs(viewer);
    expect((await call(jobReplayRoute.POST, { method: "POST", params: { id: j.id } })).status).toBe(403);
    await signInAs(b.ownerId);
    expect((await call(jobReplayRoute.POST, { method: "POST", params: { id: j.id } })).status).toBe(404);
    expect((await call(jobRoute.GET, { params: { id: j.id } })).status).toBe(404);

    await signInAs(a.ownerId);
    const replay = await call(jobReplayRoute.POST, { method: "POST", params: { id: j.id } });
    expect(replay.status).toBe(200);
    expect(await jobFor(log.id)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(await logFor(log.id)).toMatchObject({ status: "QUEUED" });
    expect((await call(jobReplayRoute.POST, { method: "POST", params: { id: j.id } })).status).toBe(422); // no longer DEAD

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "resend-1" }));
    await processQueue(T("communication.deliver"));
    expect(await logFor(log.id)).toMatchObject({ status: "SENT", providerMessageId: "resend-1", simulated: false });
  });
});

describe("WhatsApp webhook", () => {
  const route = { params: Promise.resolve({ integrationId: "" }) };
  const params = () => ({ params: Promise.resolve({ integrationId: waIntegrationId }) });
  const verify = (token: string) =>
    waWebhook.GET(new Request(`http://test.local/api/webhooks/whatsapp/x?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`), params());
  const post = (body: unknown, secret = APP_SECRET) => {
    const raw = JSON.stringify(body);
    const sig = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    return waWebhook.POST(new Request("http://test.local/api/webhooks/whatsapp/x", { method: "POST", body: raw, headers: { "x-hub-signature-256": sig } }), params());
  };
  const payload = (value: object) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: PNID }, ...value } }] }],
  });
  const events = () => prisma.webhookEvent.findMany({ where: { organizationId: a.org.id } });

  it("verifies the subscription with the decrypted verify token", async () => {
    const ok = await verify(VERIFY);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/plain");
    expect(await ok.text()).toBe("12345");
    expect((await verify("wrong")).status).toBe(403);
    route.params = Promise.resolve({ integrationId: "nope" });
    expect((await waWebhook.GET(new Request(`http://test.local/x?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`), route)).status).toBe(403);
  });

  it("rejects bad signatures", async () => {
    expect((await post(payload({ statuses: [] }), "wrong-secret")).status).toBe(401);
    const res = await waWebhook.POST(new Request("http://test.local/x", { method: "POST", body: "{}" }), params());
    expect(res.status).toBe(401);
  });

  it("stores events once, applies statuses monotonically, ignores late ones", async () => {
    const sent = await prisma.communicationLog.findFirstOrThrow({ where: { organizationId: a.org.id, provider: "whatsapp_cloud", status: "SENT" } });
    const wamid = sent.providerMessageId!;
    const ts = String(Math.floor(Date.now() / 1000));
    const read = payload({ statuses: [{ id: wamid, status: "read", timestamp: ts, recipient_id: "919876543210" }] });
    expect((await post(read)).status).toBe(200);
    expect((await post(read)).status).toBe(200); // duplicate delivery
    let rows = await events();
    expect(rows.filter((e) => e.externalId === `${wamid}:read`)).toHaveLength(1);
    expect(await prisma.backgroundJob.count({ where: { organizationId: a.org.id, type: "webhook.process" } })).toBe(1);

    await processQueue(T("webhook.process"));
    expect(await logFor(sent.id)).toMatchObject({ status: "READ" });

    await post(payload({ statuses: [{ id: wamid, status: "delivered", timestamp: ts }] }));
    await processQueue(T("webhook.process"));
    expect(await logFor(sent.id)).toMatchObject({ status: "READ" });
    rows = await events();
    expect(rows.find((e) => e.externalId === `${wamid}:delivered`)).toMatchObject({ status: "IGNORED" });
    expect(rows.find((e) => e.externalId === `${wamid}:read`)).toMatchObject({ status: "PROCESSED" });
  });

  it("inbound STOP opts the sender out; later marketing sends are BLOCKED", async () => {
    await recordConsent(await a.ctx(a.ownerId), { channel: "WHATSAPP", address: "+91 90000 00001", purpose: "MARKETING", status: "OPTED_IN" });
    expect((await send(tpl.waPromo, "WHATSAPP", "919000000001")).status).toBe("QUEUED");

    const msgId = `wamid.in.${randomUUID()}`;
    await post(payload({ contacts: [{ wa_id: "919000000001" }], messages: [{ id: msgId, from: "919000000001", type: "text", timestamp: "1700000000", text: { body: " stop " } }] }));
    await processQueue(T("webhook.process"));
    const inbound = await prisma.communicationLog.findFirstOrThrow({ where: { organizationId: a.org.id, providerMessageId: msgId } });
    expect(inbound).toMatchObject({ direction: "INBOUND", status: "RECEIVED", fromAddress: "919000000001" });
    const consents = await prisma.contactConsent.findMany({ where: { organizationId: a.org.id, channel: "WHATSAPP", address: "919000000001" } });
    expect(consents.map((c) => [c.purpose, c.status]).sort()).toEqual([["MARKETING", "OPTED_OUT"], ["TRANSACTIONAL", "OPTED_OUT"]]);
    expect(await send(tpl.waPromo, "WHATSAPP", "919000000001")).toMatchObject({ status: "BLOCKED", error: "OPTED_OUT" });
    expect(await send(tpl.wa, "WHATSAPP", "919000000001", { name: "A", order: "1" })).toMatchObject({ status: "BLOCKED", error: "OPTED_OUT" });
  });

  it("lists webhook events only for the caller's org", async () => {
    await signInAs(b.ownerId);
    expect((await call(eventsRoute.GET)).json.data.total).toBe(0);
    await signInAs(a.ownerId);
    expect((await call(eventsRoute.GET)).json.data.total).toBeGreaterThan(0);
  });
});

describe("consent", () => {
  it("validates addresses, requires consent.manage, and opts out of every purpose", async () => {
    const ctx = await a.ctx(a.ownerId);
    await expect(recordConsent(ctx, { channel: "EMAIL", address: "nope", purpose: "MARKETING", status: "OPTED_IN" })).rejects.toMatchObject({ status: 422 });
    await expect(recordConsent(await a.ctx(viewer), { channel: "EMAIL", address: "v@x.com", purpose: "MARKETING", status: "OPTED_IN" })).rejects.toMatchObject({ status: 403 });
    const rows = await optOut(ctx, { channel: "EMAIL", address: "Out@X.com" });
    expect(rows.map((r) => [r.address, r.purpose, r.status])).toEqual([["out@x.com", "TRANSACTIONAL", "OPTED_OUT"], ["out@x.com", "MARKETING", "OPTED_OUT"]]);
    expect(await send(tpl.email, "EMAIL", "out@x.com")).toMatchObject({ status: "BLOCKED", error: "OPTED_OUT" });
  });
});

describe("POST /communications", () => {
  it("requires an Idempotency-Key, replays retries, and rejects marketing templates", async () => {
    await signInAs(a.ownerId);
    const body = { channel: "EMAIL", to: "e@x.com", templateId: tpl.email, variables: { name: "Asha" } };
    expect((await call(communicationsRoute.POST, { method: "POST", body })).status).toBe(400);
    const key = randomUUID();
    const first = await call(communicationsRoute.POST, { method: "POST", body, headers: { "idempotency-key": key } });
    expect(first.status).toBe(202);
    const second = await call(communicationsRoute.POST, { method: "POST", body, headers: { "idempotency-key": key } });
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.json.data.id).toBe(first.json.data.id);
    expect(await prisma.communicationLog.count({ where: { organizationId: a.org.id, toAddress: "e@x.com" } })).toBe(1);

    const promo = await call(communicationsRoute.POST, { method: "POST", body: { channel: "WHATSAPP", to: "919000000002", templateId: tpl.waPromo, variables: { name: "A" } }, headers: { "idempotency-key": randomUUID() } });
    expect(promo.status).toBe(422);

    await signInAs(viewer);
    expect((await call(communicationsRoute.POST, { method: "POST", body, headers: { "idempotency-key": randomUUID() } })).status).toBe(403);
  });

  it("hides other tenants' messages and templates (404)", async () => {
    const log = await prisma.communicationLog.findFirstOrThrow({ where: { organizationId: a.org.id } });
    await signInAs(b.ownerId);
    expect((await call(communicationRoute.GET, { params: { id: log.id } })).status).toBe(404);
    expect((await call(templateRoute.GET, { params: { id: tpl.email } })).status).toBe(404);
    expect((await call(templateRoute.PATCH, { method: "PATCH", params: { id: tpl.email }, body: { isActive: false } })).status).toBe(404);
    const other = await call(communicationsRoute.POST, { method: "POST", body: { channel: "EMAIL", to: "e@x.com", templateId: tpl.email }, headers: { "idempotency-key": randomUUID() } });
    expect(other.status).toBe(422);
  });
});
