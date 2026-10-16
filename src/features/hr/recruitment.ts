import { z } from "zod";
import { ApplicationStage, EmploymentType, JobOpeningStatus, MemberStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";

/**
 * Recruitment: job openings (company-scoped), candidates (organization-wide, unique by
 * email), applications moving through an explicit stage table, interviews with member
 * interviewers, and feedback written only by those interviewers.
 */

const S = JobOpeningStatus;
const A = ApplicationStage;

const companyIds = (ctx: AccessContext) => [...ctx.companies.keys()];

function assertCompany(ctx: AccessContext, companyId: string) {
  if (!ctx.companies.has(companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
}

// ─── Job openings ────────────────────────────────────────────────────────────

const openingSchema = z.object({
  companyId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  departmentId: z.string().min(1).nullish(),
  designationId: z.string().min(1).nullish(),
  location: z.string().trim().max(120).nullish(),
  employmentType: z.nativeEnum(EmploymentType).default(EmploymentType.FULL_TIME),
  openings: z.coerce.number().int().min(1).max(1000).default(1),
  description: z.string().trim().max(5000).nullish(),
});

/** action → statuses it may start from → resulting status */
const OPENING_TRANSITIONS = {
  open: { from: [S.DRAFT, S.ON_HOLD], to: S.OPEN },
  hold: { from: [S.OPEN], to: S.ON_HOLD },
  close: { from: [S.DRAFT, S.OPEN, S.ON_HOLD], to: S.CLOSED },
} as const;
export type OpeningAction = keyof typeof OPENING_TRANSITIONS;
export const OPENING_ACTIONS = Object.keys(OPENING_TRANSITIONS) as OpeningAction[];

async function validateOpeningRefs(tx: Prisma.TransactionClient, ctx: AccessContext, companyId: string, d: { departmentId?: string | null; designationId?: string | null }) {
  if (d.departmentId && !(await tx.department.findFirst({ where: { id: d.departmentId, companyId } }))) {
    throw new AppError("INVALID_REFERENCE", "Department not found in this company", 422);
  }
  if (d.designationId && !(await tx.designation.findFirst({ where: { id: d.designationId, organizationId: ctx.organizationId } }))) {
    throw new AppError("INVALID_REFERENCE", "Designation not found", 422);
  }
}

async function lockOpening(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "job_openings" WHERE "id" = ${id} FOR UPDATE`;
  const opening = await tx.jobOpening.findFirst({ where: { id, organizationId: ctx.organizationId, companyId: { in: companyIds(ctx) } } });
  if (!opening) throw new AppError("NOT_FOUND", "Job opening not found", 404);
  return opening;
}

export async function createJobOpening(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "recruitment.manage");
  const data = openingSchema.parse(input);
  assertCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    await validateOpeningRefs(tx, ctx, data.companyId, data);
    const opening = await tx.jobOpening.create({ data: { ...data, organizationId: ctx.organizationId, createdById: ctx.userId } });
    await audit(tx, ctx, { action: "job_opening.created", entity: "job_opening", entityId: opening.id, companyId: opening.companyId, next: opening });
    return opening;
  });
}

export async function updateJobOpening(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "recruitment.manage");
  const data = openingSchema.omit({ companyId: true }).partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const opening = await lockOpening(tx, ctx, id);
    if (opening.status === S.CLOSED) throw new AppError("INVALID_STATE", "A closed opening cannot be edited", 422);
    await validateOpeningRefs(tx, ctx, opening.companyId, data);
    const updated = await tx.jobOpening.update({ where: { id }, data });
    await audit(tx, ctx, { action: "job_opening.updated", entity: "job_opening", entityId: id, companyId: opening.companyId, ...changes(opening, updated) });
    return updated;
  });
}

export async function transitionJobOpening(ctx: AccessContext, id: string, action: OpeningAction) {
  const rule = OPENING_TRANSITIONS[action];
  if (!rule) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, "recruitment.manage");
  return prisma.$transaction(async (tx) => {
    const opening = await lockOpening(tx, ctx, id);
    if (!(rule.from as readonly JobOpeningStatus[]).includes(opening.status)) {
      throw new AppError("INVALID_STATE", `Cannot ${action} an opening that is ${opening.status}`, 422);
    }
    const updated = await tx.jobOpening.update({ where: { id }, data: { status: rule.to } });
    await audit(tx, ctx, { action: `job_opening.${action}`, entity: "job_opening", entityId: id, companyId: opening.companyId, previous: { status: opening.status }, next: { status: updated.status } });
    return updated;
  });
}

export async function listJobOpenings(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "recruitment.view");
  const q = listQuerySchema.extend({ status: z.nativeEnum(S).optional(), companyId: z.string().optional() }).parse(query);
  const where: Prisma.JobOpeningWhereInput = {
    organizationId: ctx.organizationId,
    companyId: { in: companyIds(ctx).filter((c) => !q.companyId || c === q.companyId) },
    status: q.status,
    ...searchWhere(q.q, ["title", "location"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.jobOpening.findMany({ where, include: { department: { select: { name: true } }, _count: { select: { applications: true } } }, ...listArgs(q, ["createdAt", "title", "status"], "createdAt") }),
      prisma.jobOpening.count({ where }),
    ]),
  );
}

export async function getJobOpening(ctx: AccessContext, id: string) {
  assertCan(ctx, "recruitment.view");
  const opening = await prisma.jobOpening.findFirst({
    where: { id, organizationId: ctx.organizationId, companyId: { in: companyIds(ctx) } },
    include: {
      department: { select: { name: true } },
      designation: { select: { name: true } },
      applications: { include: { candidate: true, _count: { select: { interviews: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!opening) throw new AppError("NOT_FOUND", "Job opening not found", 404);
  return opening;
}

// ─── Candidates ──────────────────────────────────────────────────────────────

const candidateSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(200).nullish(),
  phone: z.string().trim().max(40).nullish(),
  source: z.string().trim().max(80).nullish(),
  notes: z.string().trim().max(5000).nullish(),
});

async function assertNoDuplicate(tx: Prisma.TransactionClient, ctx: AccessContext, email: string | null | undefined, exceptId?: string) {
  if (!email) return;
  const dup = await tx.candidate.findFirst({ where: { organizationId: ctx.organizationId, email: { equals: email, mode: "insensitive" }, id: exceptId ? { not: exceptId } : undefined } });
  if (dup) throw new AppError("DUPLICATE", "A candidate with this email already exists", 409, { id: dup.id, fullName: dup.fullName });
}

export async function createCandidate(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "recruitment.manage");
  const data = candidateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await assertNoDuplicate(tx, ctx, data.email);
    const candidate = await tx.candidate.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "candidate.created", entity: "candidate", entityId: candidate.id, next: candidate });
    return candidate;
  });
}

export async function updateCandidate(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "recruitment.manage");
  const data = candidateSchema.partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.candidate.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!candidate) throw new AppError("NOT_FOUND", "Candidate not found", 404);
    await assertNoDuplicate(tx, ctx, data.email, id);
    const updated = await tx.candidate.update({ where: { id }, data });
    await audit(tx, ctx, { action: "candidate.updated", entity: "candidate", entityId: id, ...changes(candidate, updated) });
    return updated;
  });
}

export async function listCandidates(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "recruitment.view");
  const q = listQuerySchema.parse(query);
  const where: Prisma.CandidateWhereInput = { organizationId: ctx.organizationId, ...searchWhere(q.q, ["fullName", "email", "phone"]) };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.candidate.findMany({ where, include: { _count: { select: { applications: true } } }, ...listArgs(q, ["createdAt", "fullName"], "createdAt") }),
      prisma.candidate.count({ where }),
    ]),
  );
}

export async function getCandidate(ctx: AccessContext, id: string) {
  assertCan(ctx, "recruitment.view");
  const candidate = await prisma.candidate.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { applications: { where: { jobOpening: { companyId: { in: companyIds(ctx) } } }, include: { jobOpening: { select: { id: true, title: true, status: true } } } } },
  });
  if (!candidate) throw new AppError("NOT_FOUND", "Candidate not found", 404);
  return candidate;
}

// ─── Applications ────────────────────────────────────────────────────────────

/** Allowed next stages. HIRED, REJECTED and WITHDRAWN are terminal. */
export const STAGE_TRANSITIONS: Record<ApplicationStage, ApplicationStage[]> = {
  APPLIED: [A.SCREENING, A.INTERVIEW, A.REJECTED, A.WITHDRAWN],
  SCREENING: [A.INTERVIEW, A.OFFER, A.REJECTED, A.WITHDRAWN],
  INTERVIEW: [A.OFFER, A.REJECTED, A.WITHDRAWN],
  OFFER: [A.HIRED, A.REJECTED, A.WITHDRAWN],
  HIRED: [],
  REJECTED: [],
  WITHDRAWN: [],
};
const TERMINAL: ApplicationStage[] = [A.HIRED, A.REJECTED, A.WITHDRAWN];

const applicationWhere = (ctx: AccessContext): Prisma.ApplicationWhereInput => ({
  organizationId: ctx.organizationId,
  jobOpening: { companyId: { in: companyIds(ctx) } },
});

const applicationInclude = {
  candidate: true,
  jobOpening: { select: { id: true, title: true, status: true, companyId: true } },
  interviews: { include: { feedback: true }, orderBy: { scheduledAt: "asc" } },
} satisfies Prisma.ApplicationInclude;

export async function createApplication(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "recruitment.manage");
  const data = z.object({ jobOpeningId: z.string().min(1), candidateId: z.string().min(1) }).parse(input);
  return prisma.$transaction(async (tx) => {
    const opening = await lockOpening(tx, ctx, data.jobOpeningId);
    if (opening.status !== S.OPEN) throw new AppError("INVALID_STATE", "Applications are accepted only for open positions", 422);
    const candidate = await tx.candidate.findFirst({ where: { id: data.candidateId, organizationId: ctx.organizationId } });
    if (!candidate) throw new AppError("NOT_FOUND", "Candidate not found", 404);
    const app = await tx.application.create({ data: { ...data, organizationId: ctx.organizationId }, include: applicationInclude });
    await audit(tx, ctx, { action: "application.created", entity: "application", entityId: app.id, companyId: opening.companyId, next: { jobOpeningId: app.jobOpeningId, candidateId: app.candidateId } });
    return app;
  });
}

const moveSchema = z.object({
  stage: z.nativeEnum(A),
  reason: z.string().trim().max(1000).optional(),
  hiredEmployeeId: z.string().min(1).nullish(),
});

export async function moveApplication(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "recruitment.manage");
  const data = moveSchema.parse(input);
  if (data.stage === A.REJECTED && !data.reason) throw new AppError("VALIDATION_ERROR", "A rejection reason is required", 422);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "applications" WHERE "id" = ${id} FOR UPDATE`;
    const app = await tx.application.findFirst({ where: { id, ...applicationWhere(ctx) }, include: { jobOpening: true } });
    if (!app) throw new AppError("NOT_FOUND", "Application not found", 404);
    if (!STAGE_TRANSITIONS[app.stage].includes(data.stage)) {
      throw new AppError("INVALID_STATE", `Cannot move an application from ${app.stage} to ${data.stage}`, 422);
    }
    if (data.hiredEmployeeId) {
      if (data.stage !== A.HIRED) throw new AppError("VALIDATION_ERROR", "An employee can be linked only when hiring", 422);
      const employee = await tx.employee.findFirst({ where: { id: data.hiredEmployeeId, companyId: app.jobOpening.companyId } });
      if (!employee) throw new AppError("INVALID_REFERENCE", "Employee not found in this company", 422);
    }
    const updated = await tx.application.update({
      where: { id },
      data: {
        stage: data.stage,
        stageChangedAt: new Date(),
        rejectionReason: data.stage === A.REJECTED ? data.reason : null,
        hiredEmployeeId: data.stage === A.HIRED ? (data.hiredEmployeeId ?? null) : null,
      },
      include: applicationInclude,
    });
    await audit(tx, ctx, { action: "application.stage", entity: "application", entityId: id, companyId: app.jobOpening.companyId, previous: { stage: app.stage }, next: { stage: data.stage, reason: data.reason } });
    return updated;
  });
}

export async function listApplications(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "recruitment.view");
  const q = listQuerySchema.extend({ jobOpeningId: z.string().optional(), candidateId: z.string().optional(), stage: z.nativeEnum(A).optional() }).parse(query);
  const where: Prisma.ApplicationWhereInput = { ...applicationWhere(ctx), jobOpeningId: q.jobOpeningId, candidateId: q.candidateId, stage: q.stage };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.application.findMany({ where, include: { candidate: true, jobOpening: { select: { id: true, title: true } } }, ...listArgs(q, ["createdAt", "stageChangedAt"], "createdAt") }),
      prisma.application.count({ where }),
    ]),
  );
}

export async function getApplication(ctx: AccessContext, id: string) {
  assertCan(ctx, "recruitment.view");
  const app = await prisma.application.findFirst({ where: { id, ...applicationWhere(ctx) }, include: applicationInclude });
  if (!app) throw new AppError("NOT_FOUND", "Application not found", 404);
  return app;
}

// ─── Interviews and feedback ─────────────────────────────────────────────────

const interviewers = (csv: string) => csv.split(",").filter(Boolean);

const interviewSchema = z.object({
  applicationId: z.string().min(1),
  scheduledAt: z.coerce.date(),
  durationMin: z.coerce.number().int().min(15).max(480).default(60),
  mode: z.enum(["ONSITE", "VIDEO", "PHONE"]).default("VIDEO"),
  interviewerIds: z.array(z.string().uuid()).min(1, "Choose at least one interviewer").max(10),
});

const interviewInclude = {
  feedback: true,
  application: { include: { candidate: { select: { id: true, fullName: true } }, jobOpening: { select: { id: true, title: true, companyId: true } } } },
} satisfies Prisma.InterviewInclude;

/** recruitment.view holders see interviews in their companies; interviewers see their own. */
function interviewWhere(ctx: AccessContext): Prisma.InterviewWhereInput {
  const mine = { organizationId: ctx.organizationId, interviewerIds: { contains: ctx.userId } };
  return can(ctx, "recruitment.view")
    ? { OR: [{ organizationId: ctx.organizationId, application: { jobOpening: { companyId: { in: companyIds(ctx) } } } }, mine] }
    : mine;
}

export async function scheduleInterview(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "recruitment.manage");
  const data = interviewSchema.parse(input);
  const ids = [...new Set(data.interviewerIds)];
  return prisma.$transaction(async (tx) => {
    const app = await tx.application.findFirst({ where: { id: data.applicationId, ...applicationWhere(ctx) }, include: { jobOpening: true } });
    if (!app) throw new AppError("NOT_FOUND", "Application not found", 404);
    if (TERMINAL.includes(app.stage)) throw new AppError("INVALID_STATE", `Cannot schedule an interview for a ${app.stage} application`, 422);
    const members = await tx.organizationMember.count({ where: { organizationId: ctx.organizationId, userId: { in: ids }, status: MemberStatus.ACTIVE } });
    if (members !== ids.length) throw new AppError("INVALID_REFERENCE", "Every interviewer must be an active member of this organization", 422);
    const interview = await tx.interview.create({
      data: { organizationId: ctx.organizationId, applicationId: app.id, scheduledAt: data.scheduledAt, durationMin: data.durationMin, mode: data.mode, interviewerIds: ids.join(",") },
      include: interviewInclude,
    });
    await audit(tx, ctx, { action: "interview.scheduled", entity: "interview", entityId: interview.id, companyId: app.jobOpening.companyId, next: { applicationId: app.id, scheduledAt: data.scheduledAt, interviewerIds: ids } });
    return interview;
  });
}

export async function listInterviews(ctx: AccessContext, query: unknown) {
  const q = listQuerySchema.extend({ applicationId: z.string().optional(), mine: z.enum(["true", "false"]).optional() }).parse(query);
  const where: Prisma.InterviewWhereInput = {
    AND: [interviewWhere(ctx), { applicationId: q.applicationId }, q.mine === "true" ? { interviewerIds: { contains: ctx.userId } } : {}],
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.interview.findMany({ where, include: interviewInclude, ...listArgs(q, ["scheduledAt", "createdAt"], "scheduledAt") }),
      prisma.interview.count({ where }),
    ]),
  );
}

export async function getInterview(ctx: AccessContext, id: string) {
  const interview = await prisma.interview.findFirst({ where: { AND: [{ id }, interviewWhere(ctx)] }, include: interviewInclude });
  if (!interview) throw new AppError("NOT_FOUND", "Interview not found", 404);
  return interview;
}

const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  recommendation: z.enum(["STRONG_YES", "YES", "NO", "STRONG_NO"]),
  comments: z.string().trim().max(5000).optional(),
});

export const INTERVIEW_ACTIONS = ["complete", "cancel", "feedback"] as const;
export type InterviewAction = (typeof INTERVIEW_ACTIONS)[number];

/** complete/cancel: SCHEDULED only (recruitment.manage). feedback: listed interviewers, once each. */
export async function interviewAction(ctx: AccessContext, id: string, action: InterviewAction, input: unknown) {
  if (!INTERVIEW_ACTIONS.includes(action)) throw new AppError("NOT_FOUND", "Unknown action", 404);
  const feedback = action === "feedback" ? feedbackSchema.parse(input ?? {}) : null;
  if (!feedback) assertCan(ctx, "recruitment.manage");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "interviews" WHERE "id" = ${id} FOR UPDATE`;
    const interview = await tx.interview.findFirst({ where: { AND: [{ id }, interviewWhere(ctx)] }, include: interviewInclude });
    if (!interview) throw new AppError("NOT_FOUND", "Interview not found", 404);
    const companyId = interview.application.jobOpening.companyId;
    if (feedback) {
      if (!interviewers(interview.interviewerIds).includes(ctx.userId)) throw new AppError("FORBIDDEN", "Only an interviewer on this interview can give feedback", 403);
      if (interview.status === "CANCELLED") throw new AppError("INVALID_STATE", "The interview was cancelled", 422);
      if (interview.feedback.some((f) => f.interviewerId === ctx.userId)) throw new AppError("DUPLICATE", "You already gave feedback for this interview", 409);
      const row = await tx.interviewFeedback.create({ data: { ...feedback, organizationId: ctx.organizationId, interviewId: id, interviewerId: ctx.userId } });
      await audit(tx, ctx, { action: "interview.feedback", entity: "interview", entityId: id, companyId, next: row });
      return row;
    }
    if (interview.status !== "SCHEDULED") throw new AppError("INVALID_STATE", `Cannot ${action} an interview that is ${interview.status}`, 422);
    const status = action === "complete" ? "COMPLETED" : "CANCELLED";
    const updated = await tx.interview.update({ where: { id }, data: { status }, include: interviewInclude });
    await audit(tx, ctx, { action: `interview.${action}`, entity: "interview", entityId: id, companyId, previous: { status: interview.status }, next: { status } });
    return updated;
  });
}
