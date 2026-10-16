import { randomUUID } from "crypto";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { resolveEntity } from "@/lib/entities";
import { putObject, removeObject, signedObjectUrl } from "@/lib/storage/objects";

/** Private bucket; create it in Supabase (see supabase/migrations). */
export const DOCUMENTS_BUCKET = "documents";
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function validateDocumentFile(file: { type: string; size: number }) {
  if (!DOCUMENT_MIME_TYPES.has(file.type)) {
    throw new AppError("INVALID_FILE", "Unsupported file type", 422);
  }
  if (file.size === 0 || file.size > DOCUMENT_MAX_BYTES) {
    throw new AppError("INVALID_FILE", "File must be between 1 byte and 20MB", 422);
  }
}

export async function uploadDocument(
  ctx: AccessContext,
  input: { entityType: string; entityId: string; file: File },
) {
  assertCan(ctx, "document.create");
  const { companyId } = await resolveEntity(ctx, input.entityType, input.entityId);
  validateDocumentFile(input.file);

  const id = randomUUID();
  const safeName = input.file.name.replace(/[^\w.-]+/g, "_").slice(-120) || "file";
  const storagePath = `${ctx.organizationId}/${input.entityType}/${input.entityId}/${id}-${safeName}`;
  await putObject(DOCUMENTS_BUCKET, storagePath, Buffer.from(await input.file.arrayBuffer()), input.file.type);

  try {
    return await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          companyId,
          entityType: input.entityType,
          entityId: input.entityId,
          fileName: input.file.name.slice(0, 255),
          mimeType: input.file.type,
          sizeBytes: input.file.size,
          storagePath,
          uploadedById: ctx.userId,
        },
      });
      await audit(tx, ctx, { action: "document.uploaded", entity: "document", entityId: id, companyId, next: document });
      return document;
    });
  } catch (error) {
    await removeObject(DOCUMENTS_BUCKET, storagePath).catch(() => {});
    throw error;
  }
}

export async function listDocuments(ctx: AccessContext, entityType: string, entityId: string) {
  assertCan(ctx, "document.view");
  await resolveEntity(ctx, entityType, entityId);
  return prisma.document.findMany({
    where: { organizationId: ctx.organizationId, entityType, entityId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

async function requireDocument(ctx: AccessContext, id: string) {
  const document = await prisma.document.findFirst({
    where: { id, organizationId: ctx.organizationId, deletedAt: null },
  });
  if (!document) throw new AppError("NOT_FOUND", "Document not found", 404);
  // Access to a document follows access to the record it is attached to.
  await resolveEntity(ctx, document.entityType, document.entityId);
  return document;
}

export async function getDocumentDownload(ctx: AccessContext, id: string) {
  assertCan(ctx, "document.view");
  const document = await requireDocument(ctx, id);
  return { document, ...(await signedObjectUrl(DOCUMENTS_BUCKET, document.storagePath, 300)) };
}

export async function deleteDocument(ctx: AccessContext, id: string) {
  assertCan(ctx, "document.delete");
  const document = await requireDocument(ctx, id);
  await prisma.$transaction(async (tx) => {
    await tx.document.update({ where: { id }, data: { deletedAt: new Date() } });
    await audit(tx, ctx, {
      action: "document.deleted",
      entity: "document",
      entityId: id,
      companyId: document.companyId,
      previous: document,
    });
  });
  await removeObject(DOCUMENTS_BUCKET, document.storagePath).catch((error) =>
    console.error("[documents] orphaned object", document.storagePath, error),
  );
  return { id };
}
