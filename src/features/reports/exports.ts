import { z } from "zod";
import { Prisma, type BackgroundJob } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError, isAppError } from "@/lib/errors";
import { assertCan, buildAccessContext, can, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { enqueue } from "@/lib/queue";
import { sanitizeError } from "@/lib/sanitize";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { putObject, removeObject, signedObjectUrl } from "@/lib/storage/objects";
import { DOCUMENTS_BUCKET } from "@/features/documents/service";
import { REPORT_ENTITIES } from "@/features/reports/catalog";
import { EXPORT_MAX_ROWS, EXPORT_TIMEOUT_MS, executeReport, parseDefinition } from "@/features/reports/builder";
import { getSavedReport } from "@/features/reports/saved";

/**
 * CSV exports of report-builder definitions, generated in the background queue.
 * - Request: `data.export` + the entity's own permission (the same rule as reading it in the UI).
 * - Generation re-checks the requester's *current* membership, permissions and company scope;
 *   anything revoked in between marks the export FAILED (no file is written).
 * - Files live in the private documents bucket at exports/<org>/<id>.csv for 7 days and are
 *   handed out only as short-lived signed URLs to the requester (who must still hold the
 *   permissions). Re-running a finished export is a no-op.
 */

export const EXPORT_TTL_DAYS = 7;
const SIGNED_URL_SECONDS = 60;

const requestSchema = z
  .object({ savedReportId: z.string().min(1).max(64).optional(), definition: z.unknown().optional() })
  .strict()
  .refine((r) => (r.savedReportId === undefined) !== (r.definition === undefined), { message: "Give either savedReportId or definition", path: ["definition"] });

const exportDefinition = (input: unknown) => ({ ...parseDefinition(input, EXPORT_MAX_ROWS), limit: EXPORT_MAX_ROWS });

const publicFields = { id: true, entity: true, format: true, status: true, rowCount: true, error: true, requestedById: true, completedAt: true, expiresAt: true, createdAt: true, params: true } as const;

export async function requestExport(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "data.export");
  const data = requestSchema.parse(input);
  const saved = data.savedReportId ? await getSavedReport(ctx, data.savedReportId) : null;
  const definition = exportDefinition(saved ? saved.definition : data.definition);
  assertCan(ctx, REPORT_ENTITIES[definition.entity].permission);
  return prisma.$transaction(async (tx) => {
    const row = await tx.dataExport.create({
      data: {
        organizationId: ctx.organizationId,
        entity: definition.entity,
        params: { definition, savedReportId: saved?.id ?? null, name: saved?.name ?? null } as Prisma.InputJsonValue,
        requestedById: ctx.userId,
      },
      select: publicFields,
    });
    await enqueue(tx, { type: "export.generate", key: `export.generate:${row.id}`, organizationId: ctx.organizationId, payload: { exportId: row.id } });
    await audit(tx, ctx, { action: "data_export.requested", entity: "data_export", entityId: row.id, next: { entity: row.entity, savedReportId: saved?.id ?? null } });
    return row;
  });
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** Text cells that a spreadsheet would treat as a formula are prefixed with an apostrophe. */
export function csvCell(value: unknown, text: boolean) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: { key: string; label: string; type: string }[], rows: Record<string, unknown>[]) {
  const text = columns.map((c) => c.type === "string" || c.type === "enum");
  const lines = [columns.map((c) => csvCell(c.label, true)).join(",")];
  for (const row of rows) lines.push(columns.map((c, i) => csvCell(row[c.key], text[i])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

// ─── Generation (queue handler "export.generate") ───────────────────────────

async function fail(id: string, reason: string) {
  await prisma.dataExport.updateMany({ where: { id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", error: reason.slice(0, 500), completedAt: new Date() } });
  return { exportId: id, status: "FAILED", reason };
}

export async function generateExport(payload: { exportId: string }, job?: BackgroundJob): Promise<unknown> {
  const row = await prisma.dataExport.findUnique({ where: { id: payload.exportId } });
  if (!row) return { exportId: payload.exportId, skipped: "missing" };
  if (row.status !== "PENDING" && row.status !== "RUNNING") return { exportId: row.id, skipped: row.status };
  const claimed = await prisma.dataExport.updateMany({ where: { id: row.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "RUNNING" } });
  if (claimed.count === 0) return { exportId: row.id, skipped: "claimed" };

  let ctx: AccessContext;
  try {
    ctx = await buildAccessContext(row.requestedById, row.organizationId);
  } catch (error) {
    if (isAppError(error)) return fail(row.id, "The requester no longer has access to this organization");
    throw error;
  }
  const params = (row.params ?? {}) as { definition?: unknown };
  let definition: ReturnType<typeof exportDefinition>;
  try {
    definition = exportDefinition(params.definition);
  } catch {
    return fail(row.id, "The report definition is no longer valid");
  }
  const entityPermission = REPORT_ENTITIES[definition.entity].permission;
  for (const permission of ["data.export", entityPermission]) {
    if (!can(ctx, permission)) return fail(row.id, `Permission revoked: ${permission}`);
  }

  try {
    const result = await executeReport(ctx, definition, { maxRows: EXPORT_MAX_ROWS, timeoutMs: EXPORT_TIMEOUT_MS });
    const storagePath = `exports/${row.organizationId}/${row.id}.csv`;
    await putObject(DOCUMENTS_BUCKET, storagePath, Buffer.from(toCsv(result.columns, result.rows), "utf8"), "text/csv");
    const completedAt = new Date();
    await prisma.dataExport.update({
      where: { id: row.id },
      data: {
        status: "COMPLETED",
        rowCount: result.rowCount,
        storagePath,
        error: result.truncated ? `Truncated at ${EXPORT_MAX_ROWS} rows` : null,
        completedAt,
        expiresAt: new Date(completedAt.getTime() + EXPORT_TTL_DAYS * 86_400_000),
      },
    });
    return { exportId: row.id, status: "COMPLETED", rowCount: result.rowCount };
  } catch (error) {
    // Report-level problems (timeout, validation, permission) won't fix themselves on retry.
    if (isAppError(error) && error.status < 500) return fail(row.id, error.message);
    if (!job || job.attempts >= job.maxAttempts) await fail(row.id, sanitizeError(error));
    throw error;
  }
}

// ─── Reading and download ────────────────────────────────────────────────────

export async function listMyExports(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "data.export");
  const q = listQuerySchema.parse(query);
  const where = { organizationId: ctx.organizationId, requestedById: ctx.userId };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.dataExport.findMany({ where, select: publicFields, ...listArgs(q, ["createdAt"], "createdAt") }),
      prisma.dataExport.count({ where }),
    ]),
  );
}

async function myExport(ctx: AccessContext, id: string) {
  assertCan(ctx, "data.export");
  const row = await prisma.dataExport.findFirst({ where: { id, organizationId: ctx.organizationId, requestedById: ctx.userId } });
  if (!row) throw new AppError("NOT_FOUND", "Export not found", 404);
  return row;
}

export async function getExport(ctx: AccessContext, id: string) {
  const { storagePath: _, organizationId: __, ...row } = await myExport(ctx, id);
  return row;
}

/** Short-lived signed URL for the requester's own completed, unexpired export. */
export async function getExportDownload(ctx: AccessContext, id: string) {
  const row = await myExport(ctx, id);
  const entity = REPORT_ENTITIES[row.entity];
  if (!entity) throw new AppError("NOT_FOUND", "Export not found", 404);
  assertCan(ctx, entity.permission);
  if (row.status === "COMPLETED" && row.expiresAt && row.expiresAt < new Date()) {
    await prisma.dataExport.updateMany({ where: { id, status: "COMPLETED" }, data: { status: "EXPIRED" } });
    throw new AppError("EXPIRED", "This export has expired; request it again", 410);
  }
  if (row.status !== "COMPLETED" || !row.storagePath) throw new AppError("INVALID_STATE", `Export is ${row.status.toLowerCase()}`, 422);
  const signed = await signedObjectUrl(DOCUMENTS_BUCKET, row.storagePath, SIGNED_URL_SECONDS);
  await audit(prisma, ctx, { action: "data_export.downloaded", entity: "data_export", entityId: row.id });
  return { id: row.id, url: signed.signedUrl, expiresAt: signed.expiresAt, fileName: `${row.entity}-${row.createdAt.toISOString().slice(0, 10)}.csv` };
}

/** Job: delete expired export files. Claims each row (COMPLETED → EXPIRED) before removing its file. */
export async function purgeExpiredExports(now = new Date()) {
  const due = await prisma.dataExport.findMany({
    where: { status: "COMPLETED", expiresAt: { lt: now } },
    select: { id: true, storagePath: true },
    take: 500,
  });
  let purged = 0;
  for (const row of due) {
    const claimed = await prisma.dataExport.updateMany({ where: { id: row.id, status: "COMPLETED" }, data: { status: "EXPIRED" } });
    if (claimed.count === 0) continue;
    if (row.storagePath) await removeObject(DOCUMENTS_BUCKET, row.storagePath);
    purged++;
  }
  return { purged };
}
