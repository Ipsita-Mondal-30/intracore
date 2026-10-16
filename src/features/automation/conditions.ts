import { z } from "zod";
import { Prisma } from "@prisma/client";
import { entityFields, type FieldDef } from "@/features/automation/catalog";

/**
 * Workflow conditions: [{ field, op, value }], all of which must hold. A pure interpreter —
 * values are compared as data (never evaluated), decimals with Prisma.Decimal.
 *
 * Operators: eq, neq, in, not_in, exists, changed (all types); gt, gte, lt, lte (number,
 * decimal, date); contains (string, case-insensitive). `exists` and `changed` take an
 * optional boolean (default true). Comparing a field the snapshot does not carry (or null)
 * is false for every operator except `exists: false` / `changed: false`.
 */

export const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "exists", "changed"] as const;
export type Operator = (typeof OPERATORS)[number];
export type Condition = { field: string; op: Operator; value?: unknown };

const ORDERED: Operator[] = ["gt", "gte", "lt", "lte"];

/** Operators allowed for a field type (for validation and the builder UI). */
export function operatorsFor(field: FieldDef): Operator[] {
  return OPERATORS.filter((op) => {
    if (ORDERED.includes(op)) return field.type === "number" || field.type === "decimal" || field.type === "date";
    if (op === "contains") return field.type === "string";
    return true;
  });
}

const DECIMAL = /^-?\d{1,18}(\.\d{1,8})?$/;
const scalar: Record<FieldDef["type"], z.ZodTypeAny> = {
  string: z.string().max(500),
  number: z.number().finite(),
  decimal: z.union([z.string().trim(), z.number().finite().transform(String)]).refine((v) => DECIMAL.test(v), "Must be a decimal number"),
  boolean: z.boolean(),
  date: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Must be an ISO date"),
};

function valueSchema(field: FieldDef, op: Operator): z.ZodTypeAny {
  if (op === "exists" || op === "changed") return z.boolean().default(true);
  const one = field.options && op !== "contains" ? z.enum(field.options as [string, ...string[]]) : scalar[field.type];
  return op === "in" || op === "not_in" ? z.array(one).min(1).max(50) : one;
}

const conditionShape = z.object({ field: z.string().min(1).max(60), op: z.enum(OPERATORS), value: z.unknown().optional() });

/** Zod schema for an entity's condition list (field allowlist, op per type, typed value). */
export function conditionsSchema(entity: string) {
  return z.array(conditionShape).max(20).transform((list, zctx) => {
    const fields = entityFields(entity) ?? {};
    return list.map((c, i) => {
      const def = Object.hasOwn(fields, c.field) ? fields[c.field] : undefined;
      if (!def) {
        zctx.addIssue({ code: "custom", path: [i, "field"], message: `Unknown field "${c.field}" for ${entity}` });
        return c as Condition;
      }
      if (!operatorsFor(def).includes(c.op)) {
        zctx.addIssue({ code: "custom", path: [i, "op"], message: `Operator ${c.op} is not supported for ${def.type} fields` });
        return c as Condition;
      }
      const parsed = valueSchema(def, c.op).safeParse(c.value);
      if (!parsed.success) {
        zctx.addIssue({ code: "custom", path: [i, "value"], message: parsed.error.issues[0]?.message ?? "Invalid value" });
        return c as Condition;
      }
      return { field: c.field, op: c.op, value: parsed.data } as Condition;
    });
  });
}

export type Snapshot = { previous?: Record<string, unknown> | null; next: Record<string, unknown> };
export type ConditionResult = Condition & { actual: unknown; result: boolean };

const present = (v: unknown) => v !== undefined && v !== null;

function compare(type: FieldDef["type"], a: unknown, b: unknown): number {
  if (type === "decimal") return new Prisma.Decimal(String(a)).cmp(new Prisma.Decimal(String(b)));
  if (type === "number") return Math.sign(Number(a) - Number(b));
  if (type === "date") return Math.sign(Date.parse(String(a)) - Date.parse(String(b)));
  return String(a) === String(b) ? 0 : 1; // string/boolean: equality only
}

const equal = (type: FieldDef["type"], a: unknown, b: unknown) => (type === "boolean" ? a === b : compare(type, a, b) === 0);

function evaluateOne(def: FieldDef, c: Condition, snap: Snapshot): boolean {
  const actual = snap.next[c.field];
  switch (c.op) {
    case "exists": return present(actual) === (c.value ?? true);
    case "changed": {
      const changed = Object.hasOwn(snap.next, c.field) && JSON.stringify(actual ?? null) !== JSON.stringify(snap.previous?.[c.field] ?? null);
      return changed === (c.value ?? true);
    }
  }
  if (!present(actual)) return false;
  switch (c.op) {
    case "eq": return equal(def.type, actual, c.value);
    case "neq": return !equal(def.type, actual, c.value);
    case "in": return (c.value as unknown[]).some((v) => equal(def.type, actual, v));
    case "not_in": return !(c.value as unknown[]).some((v) => equal(def.type, actual, v));
    case "contains": return String(actual).toLowerCase().includes(String(c.value).toLowerCase());
    case "gt": return compare(def.type, actual, c.value) > 0;
    case "gte": return compare(def.type, actual, c.value) >= 0;
    case "lt": return compare(def.type, actual, c.value) < 0;
    case "lte": return compare(def.type, actual, c.value) <= 0;
  }
  return false;
}

/** Evaluates every condition; a malformed stored value (e.g. a non-numeric decimal) is false. */
export function evaluateConditions(entity: string, conditions: Condition[], snap: Snapshot) {
  const fields = entityFields(entity) ?? {};
  const results: ConditionResult[] = conditions.map((c) => {
    const def = Object.hasOwn(fields, c.field) ? fields[c.field] : undefined;
    let result = false;
    try {
      result = !!def && evaluateOne(def, c, snap);
    } catch {
      result = false;
    }
    return { ...c, actual: snap.next[c.field] ?? null, result };
  });
  return { matched: results.every((r) => r.result), results };
}

const TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** {{field}} names used in a template that are not allowlisted for the entity. */
export function unknownTemplateFields(entity: string, text: string) {
  const fields = entityFields(entity) ?? {};
  return [...text.matchAll(TOKEN)].map((m) => m[1]).filter((f) => !Object.hasOwn(fields, f));
}

/** Substitutes {{field}} with the snapshot value (plain text replace; objects render empty). */
export function renderTemplate(entity: string, text: string, values: Record<string, unknown>) {
  const fields = entityFields(entity) ?? {};
  return text.replace(TOKEN, (_, f: string) => {
    const v = Object.hasOwn(fields, f) ? values[f] : undefined;
    return v === null || v === undefined || typeof v === "object" ? "" : String(v);
  });
}
