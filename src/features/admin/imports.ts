import Papa from "papaparse";
import { z, ZodError } from "zod";
import { Prisma, RecordStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError, isAppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { createContact, createCustomer, findDuplicateCustomers } from "@/features/customers/service";
import { createVendor } from "@/features/purchasing/vendors";
import { createProduct } from "@/features/catalog/service";

/**
 * CSV imports for master data. Columns are fixed per entity (see `importTemplate`).
 * - dry run: validates every row (formats, references, duplicates) and writes nothing
 * - commit: creates each row through the same service function the UI uses, so
 *   permissions, validation and audit rows are identical. One transaction per row:
 *   a failing row is reported and never rolls back the rows before or after it.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
const MAX_STORED_FAILURES = 1000;

type Row = Record<string, string>;
type Input = Record<string, unknown>;

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const str = (max: number) => z.string().max(max).optional();
const req = (max: number) => z.string().min(1).max(max);
const email = z.string().toLowerCase().email().optional();
const gstin = z.string().toUpperCase().regex(GSTIN, "Enter a valid 15-character GSTIN").optional();
const stateCode = z.string().regex(/^[0-9]{2}$/, "State code is two digits").optional();
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max).optional();
const decimal = z.string().regex(/^\d+(\.\d+)?$/, "Enter a non-negative number").optional();
const bool = z
  .string()
  .toLowerCase()
  .refine((v) => ["true", "false", "yes", "no", "1", "0"].includes(v), "Use yes or no")
  .transform((v) => ["true", "yes", "1"].includes(v))
  .optional();

type EntityDef = {
  permission: string;
  schema: z.ZodObject<z.ZodRawShape>;
  example: Row;
  /** Resolve names/codes to ids; throws AppError for a row error. */
  resolve?: (ctx: AccessContext, row: Input) => Promise<Input>;
  /** Reason when an existing record (or earlier row) already matches. */
  duplicate: (ctx: AccessContext, row: Input, seen: Set<string>) => Promise<string | null>;
  create: (ctx: AccessContext, input: Input) => Promise<{ id: string }>;
};

/** Marks in-file duplicates; returns the first key already seen. */
function seenBefore(seen: Set<string>, keys: unknown[]) {
  const present = keys.filter((k): k is string => Boolean(k));
  const hit = present.find((k) => seen.has(k));
  present.forEach((k) => seen.add(k));
  return hit ?? null;
}

const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : undefined);

const ENTITIES: Record<string, EntityDef> = {
  customer: {
    permission: "customer.create",
    schema: z.object({
      name: req(200),
      code: str(32),
      legalName: str(200),
      type: z.enum(["BUSINESS", "INDIVIDUAL"]).optional(),
      email,
      phone: str(40),
      website: str(200),
      gstin,
      pan: str(10),
      stateCode,
      billingAddress: str(500),
      shippingAddress: str(500),
      paymentTermsDays: int(0, 365),
      creditLimit: decimal,
      notes: str(4000),
    }),
    example: { name: "Acme Traders", code: "C-001", type: "BUSINESS", email: "accounts@acme.example", phone: "+91 98450 00000", gstin: "29ABCDE1234F1Z5", stateCode: "29", paymentTermsDays: "30" },
    async duplicate(ctx, row, seen) {
      const inFile = seenBefore(seen, [row.code && `code:${lower(row.code)}`, row.gstin && `gstin:${row.gstin}`, row.email && `email:${row.email}`]);
      if (inFile) return `Same ${inFile.split(":")[0]} as an earlier row`;
      if (row.code && (await prisma.customer.findFirst({ where: { organizationId: ctx.organizationId, code: row.code as string }, select: { id: true } }))) {
        return "A customer with this code exists";
      }
      const matches = await findDuplicateCustomers(ctx.organizationId, row as never);
      return matches.length ? `Matches existing customer ${matches[0].name} (${matches[0].matchedOn.join(", ")})` : null;
    },
    create: (ctx, input) => createCustomer(ctx, input),
  },

  contact: {
    permission: "contact.create",
    schema: z.object({
      firstName: req(80),
      lastName: str(80),
      email,
      phone: str(40),
      jobTitle: str(120),
      customer: str(200),
      isPrimary: bool,
      notes: str(4000),
    }),
    example: { firstName: "Asha", lastName: "Rao", email: "asha@acme.example", phone: "+91 98450 00001", jobTitle: "Purchase head", customer: "C-001", isPrimary: "yes" },
    async resolve(ctx, { customer, ...row }) {
      if (!customer) return row;
      // Customer by code first, then by exact name (case-insensitive).
      const match =
        (await prisma.customer.findFirst({ where: { organizationId: ctx.organizationId, code: customer as string }, select: { id: true } })) ??
        (await prisma.customer.findFirst({
          where: { organizationId: ctx.organizationId, name: { equals: customer as string, mode: "insensitive" }, status: { not: RecordStatus.ARCHIVED } },
          select: { id: true },
        }));
      if (!match) throw new AppError("INVALID_REFERENCE", `Customer "${customer}" not found`, 422);
      return { ...row, customerId: match.id };
    },
    async duplicate(ctx, row, seen) {
      // Contacts have no configurable duplicate rule: the same email is treated as the same person.
      if (!row.email) return null;
      if (seenBefore(seen, [`email:${row.email}`])) return "Same email as an earlier row";
      const existing = await prisma.contact.findFirst({
        where: { organizationId: ctx.organizationId, email: { equals: row.email as string, mode: "insensitive" }, status: { not: RecordStatus.ARCHIVED } },
        select: { id: true },
      });
      return existing ? "A contact with this email exists" : null;
    },
    create: (ctx, input) => createContact(ctx, input),
  },

  vendor: {
    permission: "vendor.create",
    schema: z.object({
      name: req(200),
      code: str(32),
      legalName: str(200),
      email,
      phone: str(40),
      gstin,
      pan: str(10),
      stateCode,
      address: str(500),
      paymentTermsDays: int(0, 365),
      notes: str(4000),
    }),
    example: { name: "Bharat Steel", code: "V-001", email: "sales@bharatsteel.example", gstin: "27ABCDE1234F1Z5", stateCode: "27", paymentTermsDays: "45" },
    async duplicate(ctx, row, seen) {
      // Vendors are unique by code and GSTIN.
      const inFile = seenBefore(seen, [row.code && `code:${lower(row.code)}`, row.gstin && `gstin:${row.gstin}`]);
      if (inFile) return `Same ${inFile.split(":")[0]} as an earlier row`;
      const or: Prisma.VendorWhereInput[] = [];
      if (row.code) or.push({ code: row.code as string });
      if (row.gstin) or.push({ gstin: row.gstin as string });
      if (!or.length) return null;
      const existing = await prisma.vendor.findFirst({ where: { organizationId: ctx.organizationId, OR: or }, select: { name: true } });
      return existing ? `Matches existing vendor ${existing.name} (code or GSTIN)` : null;
    },
    create: (ctx, input) => createVendor(ctx, input),
  },

  product: {
    permission: "product.create",
    schema: z.object({
      sku: req(64),
      name: req(200),
      uom: req(20),
      type: z.enum(["GOODS", "SERVICE"]).optional(),
      category: str(200),
      taxRate: str(100),
      hsnCode: str(16),
      barcode: str(64),
      description: str(2000),
      salesPrice: decimal,
      purchasePrice: decimal,
      trackInventory: bool,
      reorderLevel: decimal,
      reorderQty: decimal,
    }),
    example: { sku: "SKU-001", name: "Steel bracket", uom: "NOS", type: "GOODS", taxRate: "GST 18%", hsnCode: "7326", salesPrice: "120.00", purchasePrice: "80.00", trackInventory: "yes" },
    async resolve(ctx, { uom, category, taxRate, ...row }) {
      const organizationId = ctx.organizationId;
      const [u, c, t] = await Promise.all([
        prisma.uom.findFirst({ where: { organizationId, code: { equals: uom as string, mode: "insensitive" } }, select: { id: true } }),
        category ? prisma.productCategory.findFirst({ where: { organizationId, name: { equals: category as string, mode: "insensitive" } }, select: { id: true } }) : null,
        taxRate ? prisma.taxRate.findFirst({ where: { organizationId, name: { equals: taxRate as string, mode: "insensitive" } }, select: { id: true } }) : null,
      ]);
      if (!u) throw new AppError("INVALID_REFERENCE", `Unit "${uom}" not found`, 422);
      if (category && !c) throw new AppError("INVALID_REFERENCE", `Category "${category}" not found`, 422);
      if (taxRate && !t) throw new AppError("INVALID_REFERENCE", `Tax rate "${taxRate}" not found`, 422);
      return { ...row, uomId: u.id, categoryId: c?.id, taxRateId: t?.id };
    },
    async duplicate(ctx, row, seen) {
      const inFile = seenBefore(seen, [`sku:${lower(row.sku)}`, row.barcode && `barcode:${row.barcode}`]);
      if (inFile) return `Same ${inFile.split(":")[0]} as an earlier row`;
      const or: Prisma.ProductWhereInput[] = [{ sku: row.sku as string }];
      if (row.barcode) or.push({ barcode: row.barcode as string });
      const existing = await prisma.product.findFirst({ where: { organizationId: ctx.organizationId, OR: or }, select: { sku: true } });
      return existing ? `Product ${existing.sku} already exists (SKU or barcode)` : null;
    },
    create: (ctx, input) => createProduct(ctx, input),
  },
};

export const IMPORT_ENTITIES = Object.keys(ENTITIES);

function entityDef(entity: unknown) {
  const def = typeof entity === "string" ? ENTITIES[entity] : undefined;
  if (!def) throw new AppError("VALIDATION_ERROR", `entity must be one of: ${IMPORT_ENTITIES.join(", ")}`, 422);
  return def;
}

function assertImporter(ctx: AccessContext, def: EntityDef) {
  assertCan(ctx, "data.import");
  assertCan(ctx, def.permission);
}

/** Template CSV: the fixed header row plus one example row. */
export function importTemplate(ctx: AccessContext, entity: unknown) {
  const def = entityDef(entity);
  assertImporter(ctx, def);
  const columns = Object.keys(def.schema.shape);
  return {
    filename: `${entity}-import-template.csv`,
    columns,
    required: columns.filter((c) => !def.schema.shape[c].isOptional()),
    csv: Papa.unparse({ fields: columns, data: [columns.map((c) => def.example[c] ?? "")] }),
  };
}

const runSchema = z.object({
  entity: z.string(),
  csv: z.string().min(1, "The file is empty"),
  filename: z.string().trim().max(200).optional(),
  dryRun: z.boolean().default(true),
});

export type ImportFailure = { row: number; kind: "error" | "duplicate"; reason: string; data: Row };

function rowError(error: unknown) {
  if (error instanceof ZodError) return error.issues.map((i) => `${i.path.join(".") || "row"}: ${i.message}`).join("; ");
  if (isAppError(error)) return error.message;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") return "A referenced record does not exist";
  return "Unexpected error";
}

const isDuplicateError = (error: unknown) =>
  (isAppError(error) && error.code === "DUPLICATE") ||
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002");

/**
 * Validate (dryRun, the default) or import a CSV. Rows are numbered as in a spreadsheet
 * (header = row 1). A commit records an ImportJob; a dry run writes nothing.
 */
export async function runImport(ctx: AccessContext, input: unknown) {
  const data = runSchema.parse(input);
  const def = entityDef(data.entity);
  assertImporter(ctx, def);

  if (Buffer.byteLength(data.csv, "utf8") > MAX_IMPORT_BYTES) {
    throw new AppError("FILE_TOO_LARGE", "The file is larger than 5 MB", 422);
  }
  const parsed = Papa.parse<Row>(data.csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  const columns = Object.keys(def.schema.shape);
  const headers = parsed.meta.fields ?? [];
  const unknown = headers.filter((h) => !columns.includes(h));
  const missing = columns.filter((c) => !def.schema.shape[c].isOptional() && !headers.includes(c));
  if (unknown.length || missing.length) {
    throw new AppError("INVALID_COLUMNS", "The header row does not match the template", 422, [
      ...unknown.map((c) => ({ path: c, message: "Unknown column" })),
      ...missing.map((c) => ({ path: c, message: "Required column missing" })),
    ]);
  }
  if (parsed.data.length > MAX_IMPORT_ROWS) {
    throw new AppError("TOO_MANY_ROWS", `At most ${MAX_IMPORT_ROWS} rows per file`, 422);
  }

  const failures: ImportFailure[] = [];
  const seen = new Set<string>();
  let imported = 0;
  for (const [index, raw] of parsed.data.entries()) {
    const rowNumber = index + 2;
    const fail = (kind: ImportFailure["kind"], reason: string) => failures.push({ row: rowNumber, kind, reason, data: raw });
    try {
      // Blank cells are "not provided".
      const cells = Object.fromEntries(
        Object.entries(raw).filter(([k, v]) => columns.includes(k) && typeof v === "string" && v.trim() !== "").map(([k, v]) => [k, v.trim()]),
      );
      const row = def.schema.parse(cells) as Input;
      const reason = await def.duplicate(ctx, row, seen);
      if (reason) {
        fail("duplicate", reason);
        continue;
      }
      const serviceInput = def.resolve ? await def.resolve(ctx, row) : row;
      if (!data.dryRun) await def.create(ctx, serviceInput);
      imported++;
    } catch (error) {
      if (error instanceof AppError && error.status === 403) throw error;
      if (isDuplicateError(error)) fail("duplicate", isAppError(error) ? error.message : "A record with these values already exists");
      else fail("error", rowError(error));
    }
  }

  const summary = {
    entity: data.entity,
    dryRun: data.dryRun,
    totalRows: parsed.data.length,
    imported,
    duplicates: failures.filter((f) => f.kind === "duplicate").length,
    errors: failures.filter((f) => f.kind === "error").length,
    failedRows: failures,
  };
  if (data.dryRun) return { jobId: null, ...summary };

  const job = await prisma.importJob.create({
    data: {
      organizationId: ctx.organizationId,
      entity: data.entity,
      createdById: ctx.userId,
      status: summary.errors ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
      filename: data.filename ?? null,
      totalRows: summary.totalRows,
      imported,
      duplicates: summary.duplicates,
      errors: summary.errors,
      failedRows: failures.slice(0, MAX_STORED_FAILURES) as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });
  return { jobId: job.id, ...summary };
}

const listSchema = listQuerySchema.extend({ entity: z.string().optional() });

/** Admin import jobs (the legacy lead importer's jobs are listed under leads). */
export async function listImportJobs(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "data.import");
  const q = listSchema.parse(query);
  const where: Prisma.ImportJobWhereInput = {
    organizationId: ctx.organizationId,
    entity: q.entity && IMPORT_ENTITIES.includes(q.entity) ? q.entity : { in: IMPORT_ENTITIES },
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.importJob.findMany({
        where,
        include: { createdBy: { select: { id: true, name: true, email: true } } },
        ...listArgs(q, ["createdAt"]),
      }),
      prisma.importJob.count({ where }),
    ]),
  );
}

export async function getImportJob(ctx: AccessContext, id: string) {
  assertCan(ctx, "data.import");
  const job = await prisma.importJob.findFirst({
    where: { id, organizationId: ctx.organizationId, entity: { in: IMPORT_ENTITIES } },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  });
  if (!job) throw new AppError("NOT_FOUND", "Import job not found", 404);
  return job;
}
