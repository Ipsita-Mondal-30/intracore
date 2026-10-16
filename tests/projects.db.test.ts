import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { createProject, getProject, listProjects, removeProjectMember, setProjectMember, transitionProject, updateProject } from "@/features/projects/projects";
import { createTask, setTaskStatus, updateTask, listTasks } from "@/features/projects/tasks";
import { createTimeEntry, deleteTimeEntry, updateTimeEntry } from "@/features/projects/time";
import { projectReport } from "@/features/projects/reports";
import { resolveEntity } from "@/lib/entities";
import * as projectsRoute from "@/app/api/v1/projects/route";
import * as projectRoute from "@/app/api/v1/projects/[id]/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

let a: OrgFixture;
let b: OrgFixture;
let pm: AccessContext; // project_manager role: sees every project in scope
let dev: AccessContext; // viewer org role + project MEMBER
let outsider: AccessContext; // viewer org role, not a member
let devId: string;
let outsiderId: string;
let projectId: string;

const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  a = await createOrg("Projects A");
  b = await createOrg("Projects B");
  const m = await a.addMember("project_manager");
  devId = (await a.addMember("viewer")).userId;
  outsiderId = (await a.addMember("viewer")).userId;
  pm = await a.ctx(m.userId);
  dev = await a.ctx(devId);
  outsider = await a.ctx(outsiderId);
  const project = await createProject(pm, { companyId: a.company.id, code: "P-1", name: "Website", budget: "10000", hourlyRate: "500", billable: true });
  projectId = project.id;
  await setProjectMember(pm, projectId, { userId: devId, role: "MEMBER" });
});
afterAll(cleanupFixtures);

describe("project access", () => {
  it("creator is OWNER; members see the project, non-members get 404", async () => {
    const p = await getProject(pm, projectId);
    expect(p.members.find((x) => x.userId === pm.userId)?.role).toBe("OWNER");
    expect((await getProject(dev, projectId)).myRole).toBe("MEMBER");
    await expect(getProject(outsider, projectId)).rejects.toMatchObject({ status: 404 });
    expect((await listProjects(outsider, {})).total).toBe(0);
    expect((await listProjects(dev, {})).items.map((x) => x.id)).toEqual([projectId]);
  });

  it("member roles gate edits: MEMBER cannot edit the project (403), VIEWER cannot create tasks", async () => {
    await expect(updateProject(dev, projectId, { name: "Hacked" })).rejects.toMatchObject({ status: 403 });
    await setProjectMember(pm, projectId, { userId: outsiderId, role: "VIEWER" });
    await expect(createTask(outsider, { projectId, title: "Nope" })).rejects.toMatchObject({ status: 403 });
    await removeProjectMember(pm, projectId, { userId: outsiderId });
    await expect(getProject(outsider, projectId)).rejects.toMatchObject({ status: 404 });
  });

  it("hides a project's attachments from non-members (entity resolver)", async () => {
    await expect(resolveEntity(dev, "project", projectId)).resolves.toMatchObject({ companyId: a.company.id });
    await expect(resolveEntity(outsider, "project", projectId)).rejects.toMatchObject({ status: 404 });
  });

  it("is tenant-isolated (404) and needs project.create (403)", async () => {
    const other = await b.ctx(b.ownerId);
    await expect(getProject(other, projectId)).rejects.toMatchObject({ status: 404 });
    await expect(createProject(dev, { companyId: a.company.id, code: "X", name: "X" })).rejects.toMatchObject({ status: 403 });
  });

  it("validates input (422) and transitions (422)", async () => {
    await expect(createProject(pm, { companyId: a.company.id, code: "", name: "X" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(createProject(pm, { companyId: a.company.id, code: "P-2", name: "X", startDate: "2026-05-02", endDate: "2026-05-01" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(transitionProject(pm, projectId, "complete")).rejects.toMatchObject({ status: 422, code: "INVALID_STATE" });
    await transitionProject(pm, projectId, "activate");
  });
});

describe("tasks", () => {
  it("rejects subtask cycles and cross-project parents", async () => {
    const t1 = await createTask(dev, { projectId, title: "Design" });
    const t2 = await createTask(dev, { projectId, title: "Wireframes", parentId: t1.id });
    const t3 = await createTask(dev, { projectId, title: "Home page", parentId: t2.id });
    await expect(updateTask(dev, t1.id, { parentId: t3.id })).rejects.toMatchObject({ status: 422, code: "INVALID_PARENT" });
    await expect(updateTask(dev, t1.id, { parentId: t1.id })).rejects.toMatchObject({ status: 422 });
    const other = await createProject(pm, { companyId: a.company.id, code: "P-3", name: "Other" });
    const foreign = await createTask(pm, { projectId: other.id, title: "Foreign" });
    await expect(updateTask(dev, t1.id, { parentId: foreign.id })).rejects.toMatchObject({ status: 422, code: "INVALID_REFERENCE" });
    // the outsider cannot reach tasks of a project they are not on
    await expect(updateTask(outsider, t1.id, { title: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("requires assignees to be project members", async () => {
    await expect(createTask(dev, { projectId, title: "Assigned", assigneeId: outsiderId })).rejects.toMatchObject({ status: 422 });
    const t = await createTask(dev, { projectId, title: "Assigned", assigneeId: devId });
    expect(t.assigneeId).toBe(devId);
    expect((await listTasks(dev, { mine: "true" })).items.some((x) => x.id === t.id)).toBe(true);
  });

  it("enforces the status machine and subtask completion", async () => {
    const parent = await createTask(dev, { projectId, title: "Parent" });
    const child = await createTask(dev, { projectId, title: "Child", parentId: parent.id });
    await expect(setTaskStatus(dev, parent.id, { status: "DONE" })).rejects.toMatchObject({ status: 422 });
    await setTaskStatus(dev, child.id, { status: "DONE" });
    const done = await setTaskStatus(dev, parent.id, { status: "DONE" });
    expect(done.completedAt).not.toBeNull();
    await expect(setTaskStatus(dev, parent.id, { status: "BLOCKED" })).rejects.toMatchObject({ status: 422, code: "INVALID_STATE" });
  });
});

describe("time entries", () => {
  it("logs own time with billable default, rejects <=0, future dates and >24h per day", async () => {
    const e = await createTimeEntry(dev, { projectId, date: today, hours: "8" });
    expect(e.billable).toBe(true);
    expect(e.userId).toBe(devId);
    await expect(createTimeEntry(dev, { projectId, date: today, hours: "0" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(createTimeEntry(dev, { projectId, date: today, hours: "-1" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(createTimeEntry(dev, { projectId, date: today, hours: "25" })).rejects.toMatchObject({ name: "ZodError" });
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await expect(createTimeEntry(dev, { projectId, date: tomorrow, hours: "1" })).rejects.toMatchObject({ status: 422 });
    await createTimeEntry(dev, { projectId, date: today, hours: "15.5", billable: false });
    await expect(createTimeEntry(dev, { projectId, date: today, hours: "1" })).rejects.toMatchObject({ status: 422, code: "DAILY_LIMIT" });
    await expect(updateTimeEntry(dev, e.id, { hours: "9" })).rejects.toMatchObject({ code: "DAILY_LIMIT" });
    await updateTimeEntry(dev, e.id, { hours: "8.5" }); // 8.5 + 15.5 = 24 exactly
    expect(await prisma.timeEntry.count({ where: { projectId } })).toBe(2);
  });

  it("only members log time; only the author edits", async () => {
    await expect(createTimeEntry(outsider, { projectId, date: today, hours: "1" })).rejects.toMatchObject({ status: 404 });
    const entry = await prisma.timeEntry.findFirstOrThrow({ where: { projectId, userId: devId } });
    await expect(updateTimeEntry(pm, entry.id, { hours: "1" })).rejects.toMatchObject({ status: 403 });
    // pm created the project, so is an OWNER member and may delete others' entries
    const pmEntry = await createTimeEntry(pm, { projectId, date: today, hours: "2" });
    await expect(deleteTimeEntry(dev, pmEntry.id)).rejects.toMatchObject({ status: 403 });
    await deleteTimeEntry(pm, pmEntry.id);
  });
});

describe("progress and budget report", () => {
  it("computes progress as done / non-cancelled tasks and budget vs actual", async () => {
    const p = await createProject(pm, { companyId: a.company.id, code: "P-R", name: "Report", budget: "1000", hourlyRate: "100" });
    await setProjectMember(pm, p.id, { userId: devId, role: "MEMBER" });
    const tasks = await Promise.all(["a", "b", "c", "d", "e"].map((title) => createTask(dev, { projectId: p.id, title })));
    await setTaskStatus(dev, tasks[0].id, { status: "DONE" });
    await setTaskStatus(dev, tasks[1].id, { status: "DONE" });
    await setTaskStatus(dev, tasks[2].id, { status: "CANCELLED" });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await createTimeEntry(dev, { projectId: p.id, taskId: tasks[0].id, date: yesterday, hours: "3", billable: true });
    await createTimeEntry(dev, { projectId: p.id, date: yesterday, hours: "1.5" });

    const r = await projectReport(dev, p.id);
    expect(r.progress).toEqual({ total: 4, done: 2, percent: 50 });
    expect(r.hours.logged).toBe("4.5");
    expect(r.hours.billable).toBe("3");
    expect(r.budget.actualCost).toBe("450");
    expect(r.budget.billableAmount).toBe("300");
    expect(r.budget.remaining).toBe("550");
    expect(r.budget.usedPercent).toBe(45);
    expect((await listProjects(pm, { q: "P-R" })).items[0].progress.percent).toBe(50);
  });
});

describe("routes", () => {
  it("creates idempotently and answers 403/404/422", async () => {
    await signInAs(pm.userId);
    const send = () => call(projectsRoute.POST, { method: "POST", body: { companyId: a.company.id, code: "P-API", name: "API" }, headers: { "idempotency-key": "proj-1" } });
    const first = await send();
    const retry = await send();
    expect(first.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.json.data.id).toBe(first.json.data.id);
    expect(await prisma.project.count({ where: { organizationId: a.org.id, code: "P-API" } })).toBe(1);

    expect((await call(projectsRoute.POST, { method: "POST", body: { companyId: a.company.id, name: "" } })).status).toBe(422);

    await signInAs(outsiderId);
    expect((await call(projectRoute.GET, { params: { id: projectId } })).status).toBe(404);
    expect((await call(projectsRoute.POST, { method: "POST", body: { companyId: a.company.id, code: "Z", name: "Z" } })).status).toBe(403);

    await signInAs(b.ownerId);
    expect((await call(projectRoute.GET, { params: { id: projectId } })).status).toBe(404);
  });
});
