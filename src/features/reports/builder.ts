import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import {
  AGG_TYPES,
  AGGREGATES,
  OPS_BY_TYPE,
  REPORT_ENTITIES,
  isGroupable,
  type AggregateFn,
  type EntityDef,
  type FieldDef,
} from "@/features/reports/catalog";

/**
 * Custom report builder. A definition names an entity, columns, filters, grouping,
 * aggregates and sort from the catalog allowlist; anything unknown is a 422. SQL is built
 * only from catalog constants (Prisma.raw) plus bound parameters (Prisma.sql) for every
 * user value; output columns get generated aliases (c0, c1 …), never user text. Tenant,
 * company/branch and module visibility filters are always ANDed in. Queries run in a
 * transaction with `SET LOCAL statement_timeout` and a row limit. No SQL is accepted from users.
 */

export const PREVIEW_MAX_ROWS = 1000;
export const EXPORT_MAX_ROWS = 50_000;
export const PREVIEW_TIMEOUT_MS = 5_000;
export const EXPORT_TIMEOUT_MS = 20_000;

const key = z.string().trim().min(1).max(80);
const definitionShape = {
  entity: key,
  columns: z.array(key).max(40).default([]),
  filters: z.array(z.object({ field: key, op: z.string().max(20), value: z.unknown().optional() }).strict()).max(20).default([]),
  groupBy: z.array(key).max(3, "At most 3 group-by fields").default([]),
  aggregates: z.array(z.object({ fn: z.enum(AGGREGATES), field: key.optional() }).strict()).max(10).default([]),
  sort: z.array(z.object({ field: key, dir: z.enum(["asc", "desc"]).default("asc") }).strict()).max(5).default([]),
};

export const definitionSchema = (maxRows = PREVIEW_MAX_ROWS) =>
  z.object({ ...definitionShape, limit: z.coerce.number().int().min(1).max(maxRows).default(Math.min(200, maxRows)) }).strict();
export type ReportDefinition = z.infer<ReturnType<typeof definitionSchema>>;

const bad = (path: string, message: string) => new AppError("VALIDATION_ERROR", message, 422, [{ path, message }]);

function entityOf(name: string): EntityDef {
  if (!Object.hasOwn(REPORT_ENTITIES, name)) throw bad("entity", `Unknown report entity "${name}"`);
  return REPORT_ENTITIES[name];
}

function fieldOf(entity: EntityDef, name: string, path: string): FieldDef {
  if (!Object.hasOwn(entity.fields, name)) throw bad(path, `Unknown field "${name}"`);
  return entity.fields[name];
}

/** Parse + validate a definition against the catalog (422 on anything unknown). */
export function parseDefinition(input: unknown, maxRows = PREVIEW_MAX_ROWS): ReportDefinition {
  const def = definitionSchema(maxRows).parse(input);
  const entity = entityOf(def.entity);
  def.columns.forEach((c, i) => fieldOf(entity, c, `columns.${i}`));
  def.groupBy.forEach((g, i) => {
    if (!isGroupable(fieldOf(entity, g, `groupBy.${i}`))) throw bad(`groupBy.${i}`, `Field "${g}" cannot be grouped`);
  });
  def.aggregates.forEach((a, i) => {
    if (a.field === undefined) {
      if (a.fn !== "count") throw bad(`aggregates.${i}`, `${a.fn} needs a field`);
      return;
    }
    const f = fieldOf(entity, a.field, `aggregates.${i}.field`);
    if (!AGG_TYPES[a.fn].includes(f.type)) throw bad(`aggregates.${i}`, `${a.fn} is not allowed on ${a.field}`);
  });
  const grouped = def.groupBy.length > 0 || def.aggregates.length > 0;
  if (grouped) {
    const extra = def.columns.find((c) => !def.groupBy.includes(c));
    if (extra) throw bad("columns", `Column "${extra}" must be in groupBy when grouping or aggregating`);
  }
  def.filters.forEach((f, i) => {
    const field = fieldOf(entity, f.field, `filters.${i}.field`);
    if (!OPS_BY_TYPE[field.type].includes(f.op)) throw bad(`filters.${i}.op`, `Operator "${f.op}" is not allowed on ${f.field}`);
  });
  const outputs = outputKeys(def);
  def.sort.forEach((s, i) => {
    if (!outputs.includes(s.field)) throw bad(`sort.${i}.field`, `Sort field "${s.field}" is not an output column`);
  });
  return def;
}

const aggKey = (a: { fn: AggregateFn; field?: string }) => (a.field ? `${a.fn}_${a.field}` : a.fn);

function outputKeys(def: ReportDefinition) {
  const grouped = def.groupBy.length > 0 || def.aggregates.length > 0;
  if (grouped) return [...def.groupBy, ...def.aggregates.map(aggKey)];
  return def.columns.length ? def.columns : REPORT_ENTITIES[def.entity].defaultColumns;
}

// ─── Values (always bound parameters) ────────────────────────────────────────

const NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function bindValue(field: FieldDef, value: unknown, path: string): Prisma.Sql {
  switch (field.type) {
    case "number":
    case "money": {
      const s = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
      if (typeof s !== "string" || !NUMBER.test(s.trim())) throw bad(path, "Needs a number");
      return Prisma.sql`${s.trim()}::numeric`;
    }
    case "date":
      if (typeof value !== "string" || !YMD.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw bad(path, "Needs a date (yyyy-mm-dd)");
      return Prisma.sql`${value}::date`;
    case "enum":
      if (typeof value !== "string" || !field.values!.includes(value)) throw bad(path, `Must be one of ${field.values!.join(", ")}`);
      return Prisma.sql`${value}`;
    case "string":
      if (typeof value !== "string" || value.length === 0 || value.length > 200) throw bad(path, "Needs a text value (1–200 characters)");
      return Prisma.sql`${value}`;
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function filterSql(entity: EntityDef, f: ReportDefinition["filters"][number], i: number): Prisma.Sql {
  const field = entity.fields[f.field];
  const col = Prisma.raw(field.sql);
  const path = `filters.${i}.value`;
  const one = () => bindValue(field, f.value, path);
  const list = (min: number, max: number) => {
    if (!Array.isArray(f.value) || f.value.length < min || f.value.length > max) throw bad(path, `Needs a list of ${min}–${max} values`);
    return f.value.map((v, j) => bindValue(field, v, `${path}.${j}`));
  };
  switch (f.op) {
    case "eq": return Prisma.sql`${col} = ${one()}`;
    case "neq": return Prisma.sql`${col} IS DISTINCT FROM ${one()}`;
    case "gt": return Prisma.sql`${col} > ${one()}`;
    case "gte": return Prisma.sql`${col} >= ${one()}`;
    case "lt": return Prisma.sql`${col} < ${one()}`;
    case "lte": return Prisma.sql`${col} <= ${one()}`;
    case "in": return Prisma.sql`${col} IN (${Prisma.join(list(1, 100))})`;
    case "between": {
      const [lo, hi] = list(2, 2);
      return Prisma.sql`${col} BETWEEN ${lo} AND ${hi}`;
    }
    case "contains": {
      if (typeof f.value !== "string" || !f.value || f.value.length > 200) throw bad(path, "Needs a text value (1–200 characters)");
      return Prisma.sql`${col} ILIKE ${`%${escapeLike(f.value)}%`}`;
    }
    case "is_null": {
      if (f.value !== undefined && typeof f.value !== "boolean") throw bad(path, "Needs true or false");
      return f.value === false ? Prisma.sql`${col} IS NOT NULL` : Prisma.sql`${col} IS NULL`;
    }
  }
  throw bad(`filters.${i}.op`, `Unknown operator "${f.op}"`);
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

type Output = { key: string; label: string; type: string; sql: Prisma.Sql };

function aggSql(entity: EntityDef, a: { fn: AggregateFn; field?: string }): Output {
  if (!a.field) return { key: "count", label: "Count", type: "number", sql: Prisma.sql`COUNT(*)::int` };
  const f = entity.fields[a.field];
  const col = Prisma.raw(f.sql);
  const sql = {
    count: Prisma.sql`COUNT(${col})::int`,
    sum: Prisma.sql`SUM(${col})`,
    avg: Prisma.sql`ROUND(AVG(${col}), 2)`,
    min: Prisma.sql`MIN(${col})`,
    max: Prisma.sql`MAX(${col})`,
  }[a.fn];
  return { key: aggKey(a), label: `${a.fn.toUpperCase()} ${f.label}`, type: a.fn === "count" ? "number" : f.type, sql };
}

/** Builds the parameterized query. Exposed for tests (inspect `.sql` / `.values`). */
export function buildReportQuery(ctx: AccessContext, def: ReportDefinition, limit = def.limit) {
  const entity = entityOf(def.entity);
  const grouped = def.groupBy.length > 0 || def.aggregates.length > 0;
  const outputs: Output[] = grouped
    ? [
        ...def.groupBy.map((g) => ({ key: g, label: entity.fields[g].label, type: entity.fields[g].type, sql: Prisma.raw(entity.fields[g].sql) })),
        ...def.aggregates.map((a) => aggSql(entity, a)),
      ]
    : outputKeys(def).map((c) => ({ key: c, label: entity.fields[c].label, type: entity.fields[c].type, sql: Prisma.raw(entity.fields[c].sql) }));

  const select = Prisma.join(outputs.map((o, i) => Prisma.sql`${o.sql} AS ${Prisma.raw(`"c${i}"`)}`));
  const where = Prisma.join([entity.scope(ctx, [...ctx.companies.keys()]), ...def.filters.map((f, i) => filterSql(entity, f, i))], " AND ");
  const position = (k: string) => outputs.findIndex((o) => o.key === k) + 1;
  const order = [
    ...def.sort.map((s) => Prisma.raw(`${position(s.field)} ${s.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`)),
    ...(grouped ? def.groupBy.map((_, i) => Prisma.raw(`${i + 1}`)) : [Prisma.raw(entity.tieBreak)]),
  ];
  const groupBy = def.groupBy.length ? Prisma.sql` GROUP BY ${Prisma.raw(def.groupBy.map((_, i) => i + 1).join(", "))}` : Prisma.empty;
  const orderBy = order.length ? Prisma.sql` ORDER BY ${Prisma.join(order)}` : Prisma.empty;
  // One extra row tells us whether the result was truncated.
  const sql = Prisma.sql`SELECT ${select} FROM ${Prisma.raw(entity.from)} WHERE ${where}${groupBy}${orderBy} LIMIT ${limit + 1}`;
  return { sql, outputs, entity };
}

function toCell(type: string, v: unknown) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return type === "date" ? v.toISOString().slice(0, 10) : v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Prisma.Decimal) return type === "money" ? v.toFixed(2) : v.toString();
  return v;
}

export type RunOptions = {
  maxRows?: number;
  timeoutMs?: number;
  /** Internal test hook, run inside the limited transaction before the query. Never wired to user input. */
  beforeQuery?: (tx: Prisma.TransactionClient) => Promise<unknown>;
};

/** Runs an already-parsed definition. Requires the entity's own permission. */
export async function executeReport(ctx: AccessContext, def: ReportDefinition, opts: RunOptions = {}) {
  const entity = entityOf(def.entity);
  assertCan(ctx, entity.permission);
  const limit = Math.min(def.limit, opts.maxRows ?? PREVIEW_MAX_ROWS);
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? PREVIEW_TIMEOUT_MS));
  const { sql, outputs } = buildReportQuery(ctx, def, limit);
  let raw: Record<string, unknown>[];
  try {
    raw = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(Prisma.raw(`SET LOCAL statement_timeout = ${timeoutMs}`));
        if (opts.beforeQuery) await opts.beforeQuery(tx);
        return tx.$queryRaw<Record<string, unknown>[]>(sql);
      },
      { timeout: timeoutMs + 5_000, maxWait: 5_000 },
    );
  } catch (error) {
    if (isTimeout(error)) throw new AppError("QUERY_TIMEOUT", `The report took longer than ${timeoutMs / 1000}s. Add filters or reduce grouping.`, 422);
    throw error;
  }
  const truncated = raw.length > limit;
  const rows = raw.slice(0, limit).map((r) => Object.fromEntries(outputs.map((o, i) => [o.key, toCell(o.type, r[`c${i}`])])));
  return {
    entity: def.entity,
    columns: outputs.map(({ key: k, label, type }) => ({ key: k, label, type })),
    rows,
    rowCount: rows.length,
    limit,
    truncated,
  };
}

function isTimeout(error: unknown) {
  const text = error instanceof Error ? `${error.message} ${JSON.stringify((error as { meta?: unknown }).meta ?? {})}` : String(error);
  return text.includes("57014") || /statement timeout/i.test(text);
}

/** POST /reports/run: report.build + the entity's permission. */
export async function runReport(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "report.build");
  return executeReport(ctx, parseDefinition(input));
}
