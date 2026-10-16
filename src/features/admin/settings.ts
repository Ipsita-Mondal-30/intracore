import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { companySettings, companySettingsSchema, orgSettings, orgSettingsSchema } from "@/lib/settings";
import { getMissingEnvVars } from "@/lib/config/env";
import { isEmailConfigured } from "@/lib/email/client";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function mergeDeep(base: Json, patch: Json): Json {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) ? mergeDeep(isObject(base[key]) ? base[key] : {}, value) : value;
  }
  return out;
}

function flatten(value: Json, prefix = "", out: Json = {}) {
  for (const [key, v] of Object.entries(value)) {
    if (isObject(v)) flatten(v, `${prefix}${key}.`, out);
    else out[`${prefix}${key}`] = v;
  }
  return out;
}

/** Changed leaves only, keyed by dotted path: { previous: {"quotation.x": 1}, next: {"quotation.x": 2} }. */
export function settingsDiff(before: Json, after: Json) {
  const a = flatten(before);
  const b = flatten(after);
  const previous: Json = {};
  const next: Json = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      previous[key] = a[key];
      next[key] = b[key];
    }
  }
  return { previous, next, changed: Object.keys(next).length > 0 };
}

/**
 * Settings patches are merged as raw JSON and the merged result is validated with the full
 * schema (so nested defaults never overwrite stored values). Unknown keys are a 422.
 */
function assertKnownKeys(patch: unknown, defaults: Json): asserts patch is Json {
  if (!isObject(patch)) throw new AppError("VALIDATION_ERROR", "Settings must be a JSON object", 422);
  const known = flatten(defaults);
  const unknown = Object.keys(flatten(patch)).filter((key) => !(key in known));
  if (unknown.length) {
    throw new AppError("VALIDATION_ERROR", `Unknown setting: ${unknown.join(", ")}`, 422,
      unknown.map((path) => ({ path, message: "Unknown setting" })));
  }
}

// ─── Organization (system configuration) ─────────────────────────────────────

export async function getOrgSettings(ctx: AccessContext) {
  assertCan(ctx, "system.configure");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } });
  return orgSettings(org.settings);
}

/** Partial update of the typed org settings (duplicate rules, loyalty); arrays replace. */
export async function updateOrgSettings(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "system.configure");
  assertKnownKeys(input, orgSettingsSchema.parse({}));
  const patch = input;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${ctx.organizationId} FOR UPDATE`;
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } });
    const before = orgSettings(org.settings);
    const after = orgSettingsSchema.parse(mergeDeep(before, patch));
    const diff = settingsDiff(before, after);
    if (!diff.changed) return after;
    // Keep any keys other modules store next to the typed ones.
    await tx.organization.update({
      where: { id: ctx.organizationId },
      data: { settings: { ...(isObject(org.settings) ? org.settings : {}), ...after } as Prisma.InputJsonValue },
    });
    await audit(tx, ctx, {
      action: "org.settings_updated",
      entity: "organization",
      entityId: ctx.organizationId,
      previous: diff.previous,
      next: diff.next,
    });
    return after;
  });
}

// ─── Company settings ────────────────────────────────────────────────────────

function assertFullCompanyAccess(ctx: AccessContext, companyId: string) {
  if (ctx.companies.get(companyId) !== "all") throw new AppError("NOT_FOUND", "Company not found", 404);
}

export async function getCompanySettings(ctx: AccessContext, companyId: string) {
  assertCan(ctx, "company.administer");
  assertFullCompanyAccess(ctx, companyId);
  const company = await prisma.company.findFirst({
    where: { id: companyId, organizationId: ctx.organizationId },
    select: { settings: true },
  });
  if (!company) throw new AppError("NOT_FOUND", "Company not found", 404);
  return companySettings(company.settings);
}

/**
 * Partial update of a company's typed settings. The `finance` section belongs to finance
 * setup (enabling finance creates fiscal years and accounts), so it is refused here.
 */
export async function updateCompanySettings(ctx: AccessContext, companyId: string, input: unknown) {
  assertCan(ctx, "company.administer");
  assertFullCompanyAccess(ctx, companyId);
  if (isObject(input) && "finance" in input) {
    throw new AppError("FINANCE_MANAGED", "Finance settings are managed by finance setup (Finance → Setup)", 422);
  }
  assertKnownKeys(input, companySettingsSchema.parse({}));
  const patch = input;

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM companies WHERE id = ${companyId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const company = await tx.company.findFirst({ where: { id: companyId, organizationId: ctx.organizationId }, select: { settings: true } });
    if (!company) throw new AppError("NOT_FOUND", "Company not found", 404);
    const before = companySettings(company.settings);
    const after = companySettingsSchema.parse(mergeDeep(before, patch));
    const diff = settingsDiff(before, after);
    if (!diff.changed) return after;
    await tx.company.update({ where: { id: companyId }, data: { settings: after as Prisma.InputJsonValue } });
    await audit(tx, ctx, {
      action: "company.settings_updated",
      entity: "company",
      entityId: companyId,
      companyId,
      previous: diff.previous,
      next: diff.next,
    });
    return after;
  });
}

// ─── Environment status ──────────────────────────────────────────────────────

const set = (name: string) => Boolean(process.env[name]?.trim());

/** Which platform features are configured. Booleans only: never values, lengths or hints. */
export async function getEnvironmentStatus(ctx: AccessContext) {
  assertCan(ctx, "system.configure");
  const integrations = await prisma.integration.findMany({
    where: { organizationId: ctx.organizationId },
    select: { provider: true, status: true },
  });
  return {
    requiredEnvComplete: getMissingEnvVars().length === 0,
    database: set("DATABASE_URL"),
    supabaseAuth: set("NEXT_PUBLIC_SUPABASE_URL") && set("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseServiceRole: set("SUPABASE_SERVICE_ROLE_KEY"),
    encryptionKey: (process.env.ENCRYPTION_KEY?.trim().length ?? 0) >= 16,
    cronSecret: set("CRON_SECRET"),
    email: isEmailConfigured(),
    siteUrl: set("NEXT_PUBLIC_SITE_URL"),
    integrations: Object.fromEntries(integrations.map((i) => [i.provider, i.status === "CONNECTED"])),
  };
}
