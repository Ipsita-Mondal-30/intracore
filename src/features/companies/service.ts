import { z } from "zod";
import { MemberStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { companySettings, companySettingsSchema } from "@/lib/settings";
import { DOCUMENT_PREFIXES } from "@/lib/numbering";
import { seedDefaultWarehouse } from "@/features/inventory/warehouses";

const optional = (schema: z.ZodString) =>
  schema.optional().nullable().or(z.literal("").transform(() => null));

const code = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9_-]+$/, "Code may only contain letters, digits, - and _")
  .transform((s) => s.toUpperCase());
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN");
const pan = z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "Enter a valid PAN");
const stateCode = z.string().trim().regex(/^[0-9]{2}$/, "State code is two digits, e.g. 29");

/** GSTIN embeds the state code (chars 1-2) and PAN (chars 3-12); reject mismatches. */
function checkGstin(
  value: { gstin?: string | null; pan?: string | null; stateCode?: string | null },
  ctx: z.RefinementCtx,
) {
  if (!value.gstin) return;
  if (value.stateCode && value.gstin.slice(0, 2) !== value.stateCode) {
    ctx.addIssue({ code: "custom", path: ["gstin"], message: "GSTIN does not match the state code" });
  }
  if (value.pan && value.gstin.slice(2, 12) !== value.pan) {
    ctx.addIssue({ code: "custom", path: ["gstin"], message: "GSTIN does not match the PAN" });
  }
}

const companyFields = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  legalName: optional(z.string().trim().max(200)),
  pan: optional(pan),
  gstin: optional(gstin),
  stateCode: optional(stateCode),
  baseCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  address: optional(z.string().trim().max(500)),
});

const createCompanySchema = companyFields.superRefine(checkGstin);
const updateCompanySchema = companyFields
  .partial()
  .extend({
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    settings: companySettingsSchema.deepPartial().optional(),
  })
  .superRefine(checkGstin);

const branchFields = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  gstin: optional(gstin),
  stateCode: optional(stateCode),
  address: optional(z.string().trim().max(500)),
  isActive: z.boolean().optional(),
});

/** Company the member may administer in full (scope "all"); 404 otherwise. */
function assertFullCompanyAccess(ctx: AccessContext, companyId: string) {
  if (ctx.companies.get(companyId) !== "all") {
    throw new AppError("NOT_FOUND", "Company not found", 404);
  }
}

export async function listCompanies(ctx: AccessContext) {
  assertCan(ctx, "company.view");
  const companies = await prisma.company.findMany({
    where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } },
    include: { branches: { orderBy: { code: "asc" } } },
    orderBy: [{ isDefault: "desc" }, { code: "asc" }],
  });
  return companies.map((company) => {
    const scope = ctx.companies.get(company.id)!;
    return {
      ...company,
      settings: companySettings(company.settings),
      branches: company.branches.filter((b) => scope === "all" || scope.has(b.id)),
    };
  });
}

export async function getCompany(ctx: AccessContext, id: string) {
  const company = (await listCompanies(ctx)).find((c) => c.id === id);
  if (!company) throw new AppError("NOT_FOUND", "Company not found", 404);
  return company;
}

export async function createCompany(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "company.create");
  const data = createCompanySchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: { ...data, organizationId: ctx.organizationId },
    });
    await tx.branch.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: company.id,
        code: "HO",
        name: "Head Office",
        gstin: company.gstin,
        stateCode: company.stateCode,
        address: company.address,
      },
    });
    await seedDefaultWarehouse(tx, company);
    if (!ctx.isOwner) {
      // The creator administers what they create; owners already see every company.
      await tx.memberScope.create({
        data: { organizationId: ctx.organizationId, memberId: ctx.membershipId, companyId: company.id },
      });
    }
    await audit(tx, ctx, {
      action: "company.created",
      entity: "company",
      entityId: company.id,
      companyId: company.id,
      next: company,
    });
    return company;
  });
}

export async function updateCompany(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "company.update");
  assertFullCompanyAccess(ctx, id);
  const { settings, ...data } = updateCompanySchema.parse(input);
  if (settings) assertCan(ctx, "company.administer");

  return prisma.$transaction(async (tx) => {
    const before = await tx.company.findFirstOrThrow({
      where: { id, organizationId: ctx.organizationId },
    });
    const merged = settings
      ? companySettingsSchema.parse(mergeDeep(companySettings(before.settings), settings))
      : undefined;
    const patch = { ...data, ...(merged ? { settings: merged } : {}) };
    const diff = changes(before as Record<string, unknown>, patch);
    if (!diff.changed) return before;

    const company = await tx.company.update({
      where: { id },
      data: patch as Prisma.CompanyUncheckedUpdateInput,
    });
    await audit(tx, ctx, {
      action: "company.updated",
      entity: "company",
      entityId: id,
      companyId: id,
      previous: diff.previous,
      next: diff.next,
    });
    return company;
  });
}

type Json = Record<string, unknown>;

function mergeDeep(base: Json, patch: Json): Json {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeDeep((base[key] as Json) ?? {}, value as Json)
        : value;
  }
  return out;
}

export async function createBranch(ctx: AccessContext, companyId: string, input: unknown) {
  assertCan(ctx, "company.update");
  assertFullCompanyAccess(ctx, companyId);
  const data = branchFields.parse(input);

  return prisma.$transaction(async (tx) => {
    const branch = await tx.branch.create({
      data: { ...data, organizationId: ctx.organizationId, companyId },
    });
    await audit(tx, ctx, {
      action: "branch.created",
      entity: "branch",
      entityId: branch.id,
      companyId,
      next: branch,
    });
    return branch;
  });
}

export async function updateBranch(ctx: AccessContext, branchId: string, input: unknown) {
  assertCan(ctx, "company.update");
  const data = branchFields.partial().parse(input);

  return prisma.$transaction(async (tx) => {
    const before = await tx.branch.findFirst({
      where: { id: branchId, organizationId: ctx.organizationId },
    });
    if (!before) throw new AppError("NOT_FOUND", "Branch not found", 404);
    assertFullCompanyAccess(ctx, before.companyId);

    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const branch = await tx.branch.update({ where: { id: branchId }, data });
    await audit(tx, ctx, {
      action: "branch.updated",
      entity: "branch",
      entityId: branchId,
      companyId: before.companyId,
      previous: diff.previous,
      next: diff.next,
    });
    return branch;
  });
}

// ─── Member scopes ───────────────────────────────────────────────────────────

const scopesSchema = z.object({
  scopes: z
    .array(z.object({ companyId: z.string().min(1), branchId: z.string().min(1).nullish() }))
    .max(200),
});

async function requireMember(ctx: AccessContext, memberId: string) {
  const member = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId: ctx.organizationId },
  });
  if (!member) throw new AppError("NOT_FOUND", "Member not found", 404);
  return member;
}

export async function listMemberScopes(ctx: AccessContext, memberId: string) {
  assertCan(ctx, "company.administer");
  await requireMember(ctx, memberId);
  return prisma.memberScope.findMany({
    where: { organizationId: ctx.organizationId, memberId, companyId: { in: [...ctx.companies.keys()] } },
    select: { id: true, companyId: true, branchId: true },
  });
}

/**
 * Replace a member's scopes within the companies the caller fully administers.
 * Scopes in companies the caller cannot see are left untouched, and nobody can
 * grant access to a company they do not hold themselves.
 */
export async function setMemberScopes(ctx: AccessContext, memberId: string, input: unknown) {
  assertCan(ctx, "company.administer");
  const { scopes } = scopesSchema.parse(input);
  const member = await requireMember(ctx, memberId);
  if (member.status !== MemberStatus.ACTIVE) {
    throw new AppError("INVALID_STATE", "Member is not active", 422);
  }
  for (const scope of scopes) assertFullCompanyAccess(ctx, scope.companyId);

  const managed = [...ctx.companies].filter(([, s]) => s === "all").map(([id]) => id);
  const unique = new Map(scopes.map((s) => [`${s.companyId}:${s.branchId ?? ""}`, s]));

  return prisma.$transaction(async (tx) => {
    const previous = await tx.memberScope.findMany({
      where: { memberId, companyId: { in: managed } },
      select: { companyId: true, branchId: true },
    });
    await tx.memberScope.deleteMany({ where: { memberId, companyId: { in: managed } } });
    await tx.memberScope.createMany({
      data: [...unique.values()].map((s) => ({
        organizationId: ctx.organizationId,
        memberId,
        companyId: s.companyId,
        branchId: s.branchId ?? null,
      })),
    });
    await audit(tx, ctx, {
      action: "member.scopes_updated",
      entity: "organization_member",
      entityId: memberId,
      previous,
      next: [...unique.values()],
    });
    return tx.memberScope.findMany({
      where: { memberId, companyId: { in: managed } },
      select: { id: true, companyId: true, branchId: true },
    });
  });
}

// ─── Document numbering ──────────────────────────────────────────────────────

const sequenceSchema = z.object({
  prefix: z.string().trim().min(1).max(20).optional(),
  padding: z.number().int().min(1).max(10).optional(),
  nextNumber: z.number().int().min(1).optional(),
});

export async function listNumberSequences(ctx: AccessContext, companyId: string) {
  assertCan(ctx, "company.view");
  assertFullCompanyAccess(ctx, companyId);
  const rows = await prisma.numberSequence.findMany({ where: { companyId } });
  return Object.entries(DOCUMENT_PREFIXES).map(([documentType, prefix]) => {
    const row = rows.find((r) => r.documentType === documentType);
    return { documentType, prefix: row?.prefix ?? prefix, padding: row?.padding ?? 5, nextNumber: row?.nextNumber ?? 1 };
  });
}

export async function updateNumberSequence(
  ctx: AccessContext,
  companyId: string,
  documentType: string,
  input: unknown,
) {
  assertCan(ctx, "company.administer");
  assertFullCompanyAccess(ctx, companyId);
  if (!DOCUMENT_PREFIXES[documentType]) {
    throw new AppError("NOT_FOUND", "Unknown document type", 404);
  }
  const data = sequenceSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const before = await tx.numberSequence.findUnique({
      where: { companyId_documentType: { companyId, documentType } },
    });
    // Moving the counter backwards would reissue numbers that already exist.
    if (data.nextNumber !== undefined && data.nextNumber < (before?.nextNumber ?? 1)) {
      throw new AppError("VALIDATION_ERROR", "nextNumber can only move forward", 422);
    }
    const row = await tx.numberSequence.upsert({
      where: { companyId_documentType: { companyId, documentType } },
      create: {
        organizationId: ctx.organizationId,
        companyId,
        documentType,
        prefix: data.prefix ?? DOCUMENT_PREFIXES[documentType],
        padding: data.padding ?? 5,
        nextNumber: data.nextNumber ?? 1,
      },
      update: data,
    });
    await audit(tx, ctx, {
      action: "number_sequence.updated",
      entity: "number_sequence",
      entityId: row.id,
      companyId,
      previous: before,
      next: row,
    });
    return row;
  });
}

/** Default company + head-office branch for a new organization (inside its transaction). */
export async function seedDefaultCompany(
  tx: Prisma.TransactionClient,
  organization: { id: string; name: string; currency: string },
) {
  const company = await tx.company.create({
    data: {
      organizationId: organization.id,
      code: "MAIN",
      name: organization.name,
      baseCurrency: organization.currency,
      isDefault: true,
    },
  });
  await tx.branch.create({
    data: { organizationId: organization.id, companyId: company.id, code: "HO", name: "Head Office" },
  });
  await seedDefaultWarehouse(tx, company);
  return company;
}
