import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { createSlaPolicy, createTicketCategory, escalateOverdueTickets } from "@/features/service/sla";
import { addTicketMessage, createTicket, getTicket, listTicketMessages, listTickets, transitionTicket, updateTicket } from "@/features/service/tickets";
import { serviceReport } from "@/features/service/ticket-reports";
import * as ticketsRoute from "@/app/api/v1/tickets/route";
import * as ticketActionRoute from "@/app/api/v1/tickets/[id]/[action]/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

let a: OrgFixture;
let b: OrgFixture;
let mgr: AccessContext; // service_manager
let tech: AccessContext; // technician: sees assigned tickets only
let techId: string;
let escalateTo: string;
let customerId: string;

const MIN = 60_000;

beforeAll(async () => {
  a = await createOrg("Tickets A");
  b = await createOrg("Tickets B");
  const m = await a.addMember("service_manager");
  techId = (await a.addMember("technician")).userId;
  escalateTo = (await a.addMember("service_manager")).userId;
  mgr = await a.ctx(m.userId);
  tech = await a.ctx(techId);
  customerId = (await prisma.customer.create({ data: { organizationId: a.org.id, name: "Acme", createdById: a.ownerId } })).id;
  await createSlaPolicy(mgr, { name: "High", priority: "HIGH", firstResponseMinutes: 60, resolutionMinutes: 240, escalateToUserId: escalateTo });
  await createSlaPolicy(mgr, { name: "Low", priority: "LOW", firstResponseMinutes: 480, resolutionMinutes: 2880 });
});
afterAll(cleanupFixtures);

const newTicket = (extra: Record<string, unknown> = {}) => createTicket(mgr, { companyId: a.company.id, subject: "Printer jam", priority: "HIGH", ...extra });

describe("SLA", () => {
  it("computes due dates from the priority's policy and recomputes on priority change", async () => {
    const t = await newTicket({ customerId });
    expect(t.number).toMatch(/^TKT-\d{5}$/);
    expect(t.status).toBe("NEW");
    expect(t.firstResponseDueAt!.getTime() - t.createdAt.getTime()).toBe(60 * MIN);
    expect(t.resolutionDueAt!.getTime() - t.createdAt.getTime()).toBe(240 * MIN);
    const low = await updateTicket(mgr, t.id, { priority: "LOW" });
    expect(low.resolutionDueAt!.getTime() - t.createdAt.getTime()).toBe(2880 * MIN);
    const none = await updateTicket(mgr, t.id, { priority: "URGENT" }); // no URGENT policy
    expect(none.slaPolicyId).toBeNull();
    expect(none.resolutionDueAt).toBeNull();
  });

  it("validates policies (422) and needs service.administer (403)", async () => {
    await expect(createSlaPolicy(mgr, { name: "Bad", priority: "LOW", firstResponseMinutes: 100, resolutionMinutes: 50 })).rejects.toMatchObject({ name: "ZodError" });
    await expect(createSlaPolicy(tech, { name: "X", priority: "LOW", firstResponseMinutes: 1, resolutionMinutes: 2 })).rejects.toMatchObject({ status: 403 });
    await expect(createTicketCategory(tech, { name: "Hardware" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("escalation job", () => {
  it("escalates breached tickets once per level, idempotently; skips not-due and resolved", async () => {
    const breached = await newTicket({ assigneeId: techId });
    const notDue = await newTicket();
    const resolved = await newTicket();
    await transitionTicket(mgr, resolved.id, "resolve", { resolutionCode: "FIXED" });

    // Backdate the targets instead of moving the clock, so other tenants' tickets are untouched.
    const ago = (m: number) => new Date(Date.now() - m * MIN);
    await prisma.ticket.update({ where: { id: breached.id }, data: { firstResponseDueAt: ago(30), resolutionDueAt: new Date(Date.now() + 150 * MIN) } });

    await escalateOverdueTickets();
    await Promise.all([escalateOverdueTickets(), escalateOverdueTickets()]); // reruns are no-ops
    const forThese = (ids: string[]) => prisma.ticket.findMany({ where: { id: { in: ids } } });
    const rows = new Map((await forThese([breached.id, notDue.id, resolved.id])).map((t) => [t.id, t]));
    expect(rows.get(breached.id)!.escalationLevel).toBe(1);
    expect(rows.get(notDue.id)!.escalationLevel).toBe(0);
    expect(rows.get(resolved.id)!.escalationLevel).toBe(0);

    const notes = () => prisma.notification.count({ where: { organizationId: a.org.id, type: "TICKET_ESCALATED", data: { path: ["ticketId"], equals: breached.id } } });
    expect(await notes()).toBe(2); // assignee + escalation user

    // Resolution breach escalates to level 2, once.
    await prisma.ticket.update({ where: { id: breached.id }, data: { resolutionDueAt: ago(1) } });
    await escalateOverdueTickets();
    await escalateOverdueTickets();
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: breached.id } })).escalationLevel).toBe(2);
    expect(await notes()).toBe(4);
    expect(await prisma.ticketMessage.count({ where: { ticketId: breached.id, authorType: "SYSTEM" } })).toBe(2);
  });
});

describe("messages, resolution, feedback", () => {
  it("separates internal notes from public replies and stamps the first response", async () => {
    const t = await newTicket();
    await addTicketMessage(mgr, t.id, { body: "Check toner", visibility: "INTERNAL" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstRespondedAt).toBeNull();
    const reply = await addTicketMessage(mgr, t.id, { body: "We're on it", visibility: "PUBLIC" });
    await addTicketMessage(mgr, t.id, { body: "Second reply", visibility: "PUBLIC" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstRespondedAt).toEqual(reply.createdAt);
    const publicOnly = await listTicketMessages(mgr, t.id, { visibility: "PUBLIC" });
    expect(publicOnly.map((m) => m.body)).toEqual(["We're on it", "Second reply"]);
    expect((await getTicket(mgr, t.id)).messages.find((m) => m.body === "Check toner")?.visibility).toBe("INTERNAL");
    await expect(addTicketMessage(mgr, t.id, { body: "x", authorType: "CUSTOMER", visibility: "INTERNAL" })).rejects.toMatchObject({ status: 422 });
  });

  it("requires a resolution code, allows feedback only after resolve, rejects invalid transitions", async () => {
    const t = await newTicket();
    await expect(transitionTicket(mgr, t.id, "feedback", { rating: 5 })).rejects.toMatchObject({ status: 422, code: "INVALID_STATE" });
    await expect(transitionTicket(mgr, t.id, "resolve", {})).rejects.toMatchObject({ name: "ZodError" });
    await expect(transitionTicket(mgr, t.id, "resolve", { resolutionCode: "MAGIC" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(transitionTicket(mgr, t.id, "close", {})).rejects.toMatchObject({ status: 422, code: "INVALID_STATE" });
    const r = await transitionTicket(mgr, t.id, "resolve", { resolutionCode: "FIXED", resolutionNotes: "Cleared jam" });
    expect(r.resolvedAt).not.toBeNull();
    await expect(transitionTicket(mgr, t.id, "feedback", { rating: 6 })).rejects.toMatchObject({ name: "ZodError" });
    expect((await transitionTicket(mgr, t.id, "feedback", { rating: 4, comment: "Quick" })).feedbackRating).toBe(4);
    await transitionTicket(mgr, t.id, "close", {});
    const reopened = await transitionTicket(mgr, t.id, "reopen", {});
    expect(reopened.status).toBe("OPEN");
    expect(reopened.resolutionCode).toBeNull();
  });
});

describe("access", () => {
  it("technicians see only assigned tickets, cannot assign (403); other tenants get 404", async () => {
    const mine = await newTicket({ assigneeId: techId });
    expect(mine.status).toBe("OPEN");
    const other = await newTicket();
    expect((await listTickets(tech, {})).items.every((t) => t.assigneeId === techId)).toBe(true);
    await expect(getTicket(tech, other.id)).rejects.toMatchObject({ status: 404 });
    await expect(transitionTicket(tech, mine.id, "assign", { assigneeId: null })).rejects.toMatchObject({ status: 403 });
    expect((await transitionTicket(tech, mine.id, "start", {})).status).toBe("IN_PROGRESS");
    await expect(getTicket(await b.ctx(b.ownerId), mine.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects foreign references (422)", async () => {
    const foreignCustomer = await prisma.customer.create({ data: { organizationId: b.org.id, name: "Other", createdById: b.ownerId } });
    await expect(newTicket({ customerId: foreignCustomer.id })).rejects.toMatchObject({ status: 422 });
    const noScope = (await a.addMember("technician", [])).userId; // no company scope
    await expect(newTicket({ assigneeId: noScope })).rejects.toMatchObject({ status: 422 });
    await expect(newTicket({ subject: "" })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("reports backlog, breach rate and technician workload", async () => {
    const r = await serviceReport(mgr, {});
    expect(r.open.total).toBeGreaterThan(0);
    expect(r.resolved.count).toBeGreaterThan(0);
    expect(r.technicians.find((x) => x.userId === techId)?.open).toBeGreaterThan(0);
  });
});

describe("routes", () => {
  it("creates idempotently; 403 without ticket.create; 404 unknown action", async () => {
    await signInAs(mgr.userId);
    const body = { companyId: a.company.id, subject: "Via API", priority: "LOW" };
    const send = () => call(ticketsRoute.POST, { method: "POST", body, headers: { "idempotency-key": "tkt-1" } });
    const first = await send();
    const retry = await send();
    expect(first.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await prisma.ticket.count({ where: { organizationId: a.org.id, subject: "Via API" } })).toBe(1);
    expect((await call(ticketActionRoute.POST, { method: "POST", params: { id: first.json.data.id, action: "explode" }, body: {} })).status).toBe(404);
    expect((await call(ticketActionRoute.POST, { method: "POST", params: { id: first.json.data.id, action: "close" }, body: {} })).status).toBe(422);

    await signInAs(techId);
    expect((await call(ticketsRoute.POST, { method: "POST", body })).status).toBe(403);
    await signInAs(b.ownerId);
    expect((await call(ticketActionRoute.GET, { params: { id: first.json.data.id, action: "messages" } })).status).toBe(404);
  });
});
