import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import type { AccessContext } from "@/lib/access";
import { dec, Decimal } from "@/lib/money";

/**
 * Shared plumbing for analytics, MIS and the report builder:
 * - period parsing (yyyy-mm-dd, inclusive, UTC days);
 * - company scope as Prisma `where` fragments and as parameterized SQL;
 * - per-currency money folding (amounts are never added across currencies).
 */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-mm-dd").refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Invalid date");

export const periodSchema = z
  .object({ from: ymd.optional(), to: ymd.optional(), companyId: z.string().min(1).max(64).optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must be on or before to", path: ["from"] });

export const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => ymdOf(new Date(day(s).getTime() + n * 86_400_000));

export type Scope = {
  ctx: AccessContext;
  /** Companies in the caller's scope, narrowed to `companyId` when given */
  companyIds: string[];
  from: string;
  to: string;
  /** UTC instants bounding the period for timestamp columns: [fromTs, toExclusive) */
  fromTs: Date;
  toExclusive: Date;
  now: Date;
  today: string;
  companies: { id: string; code: string; name: string; currency: string }[];
  currencyOf: Map<string, string>;
};

/** Default period: first day of the current month (UTC) to today. */
export async function resolveScope(ctx: AccessContext, query: unknown, now = new Date()): Promise<Scope> {
  const q = periodSchema.parse(query);
  if (q.companyId && !ctx.companies.has(q.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  const today = ymdOf(now);
  const to = q.to ?? today;
  const from = q.from ?? `${to.slice(0, 7)}-01`;
  const companyIds = q.companyId ? [q.companyId] : [...ctx.companies.keys()];
  const companies = (
    await prisma.company.findMany({
      where: { organizationId: ctx.organizationId, id: { in: companyIds } },
      select: { id: true, code: true, name: true, baseCurrency: true },
      orderBy: { code: "asc" },
    })
  ).map((c) => ({ id: c.id, code: c.code, name: c.name, currency: c.baseCurrency }));
  return {
    ctx,
    companyIds: companies.map((c) => c.id),
    from,
    to,
    fromTs: day(from),
    toExclusive: day(addDays(to, 1)),
    now,
    today,
    companies,
    currencyOf: new Map(companies.map((c) => [c.id, c.currency])),
  };
}

// ─── Prisma where fragments ──────────────────────────────────────────────────

/** Company + branch scope (tables with a branchId), narrowed to the selected companies. */
export function branchScope(s: Scope) {
  const OR = s.companyIds.map((companyId) => {
    const scope = s.ctx.companies.get(companyId);
    return scope === "all" ? { companyId } : { companyId, branchId: { in: [...(scope ?? [])] } };
  });
  return { organizationId: s.ctx.organizationId, OR };
}

/** Company scope for tables without a branch (same rule as their module lists). */
export const companyScope = (s: Scope) => ({ organizationId: s.ctx.organizationId, companyId: { in: s.companyIds } });

/** Prisma filter for a @db.Date column inside the period. */
export const dateRange = (s: Scope) => ({ gte: day(s.from), lte: day(s.to) });
/** Prisma filter for a timestamp column inside the period. */
export const tsRange = (s: Scope) => ({ gte: s.fromTs, lt: s.toExclusive });

// ─── Parameterized SQL fragments ─────────────────────────────────────────────

/** Compare a JS Date with a timestamp(3) column, which Prisma stores as UTC wall-clock time. */
export const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * `<alias>."organizationId" = $org AND (<company/branch scope>)`. `alias` is always a constant
 * from our own code, never user input. Without `branch`, tables are scoped by company only.
 */
export function sqlScope(ctx: AccessContext, companyIds: string[], alias: string, branch: boolean): Prisma.Sql {
  const a = Prisma.raw(alias);
  const parts = companyIds.flatMap((id) => {
    const scope = ctx.companies.get(id);
    if (!scope) return [];
    if (scope === "all" || !branch) return [Prisma.sql`${a}."companyId" = ${id}`];
    if (scope.size === 0) return [];
    return [Prisma.sql`(${a}."companyId" = ${id} AND ${a}."branchId" IN (${Prisma.join([...scope])}))`];
  });
  if (!parts.length) return Prisma.sql`FALSE`;
  return Prisma.sql`${a}."organizationId" = ${ctx.organizationId} AND (${Prisma.join(parts, " OR ")})`;
}

// ─── Money ───────────────────────────────────────────────────────────────────

export type Money = Record<string, string>;

/** Folds per-company amounts into per-currency totals (every selected currency present, 2 dp). */
export function perCurrency(s: Pick<Scope, "currencyOf">, rows: { companyId: string; amount: Prisma.Decimal.Value | null | undefined }[]): Money {
  const out = new Map<string, Decimal>([...new Set(s.currencyOf.values())].map((c) => [c, dec(0)]));
  for (const r of rows) {
    const currency = s.currencyOf.get(r.companyId);
    if (!currency) continue;
    out.set(currency, out.get(currency)!.add(dec(r.amount)));
  }
  return Object.fromEntries([...out].map(([c, v]) => [c, v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)]));
}

export const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
