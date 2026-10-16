import { createHash, randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { resolveEntity } from "@/lib/entities";
import { putObject, removeObject, signedObjectUrl } from "@/lib/storage/objects";

/** Private bucket; create it in Supabase (see supabase/migrations). */
export const DOCUMENTS_BUCKET = "documents";
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((byte, i) => b[at + i] === byte);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const isText = (b: Buffer) => {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

/**
 * Allowed types and the content check each must pass (magic bytes), so a renamed
 * executable or HTML file cannot be stored under a harmless declared type.
 * OOXML files are zips; their part names ("word/", "xl/") are stored uncompressed.
 */
const SNIFFERS: Record<string, (b: Buffer) => boolean> = {
  "application/pdf": (b) => startsWith(b, ascii("%PDF-")),
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/webp": (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  "image/gif": (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  "text/plain": isText,
  "text/csv": isText,
  "application/msword": (b) => startsWith(b, OLE2),
  "application/vnd.ms-excel": (b) => startsWith(b, OLE2),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (b) => startsWith(b, ZIP) && b.includes("word/"),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (b) => startsWith(b, ZIP) && b.includes("xl/"),
};
export const DOCUMENT_MIME_TYPES = new Set(Object.keys(SNIFFERS));

export function validateDocumentFile(file: { type: string; size: number }, bytes?: Buffer) {
  if (!DOCUMENT_MIME_TYPES.has(file.type)) {
    throw new AppError("INVALID_FILE", "Unsupported file type", 422);
  }
  if (file.size === 0 || file.size > DOCUMENT_MAX_BYTES) {
    throw new AppError("INVALID_FILE", "File must be between 1 byte and 20MB", 422);
  }
  if (bytes && !SNIFFERS[file.type](bytes)) {
    throw new AppError("INVALID_FILE", `File content does not match its declared type (${file.type})`, 422);
  }
}

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Doc = Prisma.DocumentGetPayload<object>;
type Actor = { organizationId: string; userId: string };
const groupOf = (d: Pick<Doc, "id" | "versionGroupId">) => d.versionGroupId ?? d.id;

/** multipart/form-data body → its `file` field (routes). */
export async function formFile(req: Request) {
  const form = await req.formData().catch(() => {
    throw new AppError("VALIDATION_ERROR", "Expected multipart/form-data", 422);
  });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION_ERROR", "file is required", 422);
  return { form, file };
}

async function readFile(file: File) {
  const bytes = Buffer.from(await file.arrayBuffer());
  validateDocumentFile({ type: file.type, size: bytes.length }, bytes);
  return bytes;
}

function storagePathFor(orgId: string, entityType: string, entityId: string, id: string, fileName: string) {
  const safeName = fileName.replace(/[^\w.-]+/g, "_").slice(-120) || "file";
  return `${orgId}/${entityType}/${entityId}/${id}-${safeName}`;
}

/** Puts the object, runs `write`, and removes the object again if the write fails. */
async function withStoredObject<T>(path: string, bytes: Buffer, mimeType: string, write: () => Promise<T>) {
  await putObject(DOCUMENTS_BUCKET, path, bytes, mimeType);
  try {
    return await write();
  } catch (error) {
    await removeObject(DOCUMENTS_BUCKET, path).catch(() => {});
    throw error;
  }
}

export async function uploadDocument(
  ctx: AccessContext,
  input: { entityType: string; entityId: string; file: File },
) {
  assertCan(ctx, "document.create");
  const { companyId } = await resolveEntity(ctx, input.entityType, input.entityId);
  const bytes = await readFile(input.file);

  const id = randomUUID();
  const storagePath = storagePathFor(ctx.organizationId, input.entityType, input.entityId, id, input.file.name);
  return withStoredObject(storagePath, bytes, input.file.type, () =>
    prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          companyId,
          entityType: input.entityType,
          entityId: input.entityId,
          fileName: input.file.name.slice(0, 255),
          mimeType: input.file.type,
          sizeBytes: bytes.length,
          storagePath,
          uploadedById: ctx.userId,
          versionGroupId: id,
          version: 1,
          checksum: sha256(bytes),
        },
      });
      await audit(tx, ctx, { action: "document.uploaded", entity: "document", entityId: id, companyId, next: document });
      return document;
    }),
  );
}

/** Locks the version group (its first version's row) so version numbers stay gapless. */
async function lockGroup(tx: Prisma.TransactionClient, groupId: string) {
  await tx.$queryRaw`SELECT "id" FROM "documents" WHERE "id" = ${groupId} FOR UPDATE`;
}

/**
 * Appends a version to `base`'s group: the next number under the group lock, the
 * previous latest version superseded. Used by uploads and by signed files from a provider.
 */
export async function insertVersion(
  tx: Prisma.TransactionClient,
  actor: Actor,
  base: Doc,
  file: { id: string; fileName: string; mimeType: string; bytes: Buffer; storagePath: string; signatureStatus?: string },
) {
  const groupId = groupOf(base);
  await lockGroup(tx, groupId);
  const inGroup = { organizationId: actor.organizationId, OR: [{ id: groupId }, { versionGroupId: groupId }] };
  const last = await tx.document.aggregate({ where: inGroup, _max: { version: true } });
  // Rows uploaded before versioning have no group id yet.
  await tx.document.updateMany({ where: { id: groupId, versionGroupId: null }, data: { versionGroupId: groupId } });
  await tx.document.updateMany({
    where: { ...inGroup, supersededAt: null, deletedAt: null },
    data: { supersededAt: new Date() },
  });
  const document = await tx.document.create({
    data: {
      id: file.id,
      organizationId: actor.organizationId,
      companyId: base.companyId,
      entityType: base.entityType,
      entityId: base.entityId,
      fileName: file.fileName.slice(0, 255),
      mimeType: file.mimeType,
      sizeBytes: file.bytes.length,
      storagePath: file.storagePath,
      uploadedById: actor.userId,
      versionGroupId: groupId,
      version: (last._max.version ?? 0) + 1,
      checksum: sha256(file.bytes),
      signatureStatus: file.signatureStatus ?? "NONE",
    },
  });
  await audit(tx, actor, {
    action: "document.version_added",
    entity: "document",
    entityId: document.id,
    companyId: base.companyId,
    next: { versionGroupId: groupId, version: document.version, checksum: document.checksum },
  });
  return document;
}

/** Stores bytes as a new version of `base` (also used for provider-signed files). */
export async function storeVersion(
  actor: Actor,
  base: Doc,
  file: { fileName: string; mimeType: string; bytes: Buffer; signatureStatus?: string },
  extra?: (tx: Prisma.TransactionClient, document: Doc) => Promise<void>,
) {
  const id = randomUUID();
  const storagePath = storagePathFor(actor.organizationId, base.entityType, base.entityId, id, file.fileName);
  return withStoredObject(storagePath, file.bytes, file.mimeType, () =>
    prisma.$transaction(async (tx) => {
      const document = await insertVersion(tx, actor, base, { ...file, id, storagePath });
      await extra?.(tx, document);
      return document;
    }),
  );
}

export async function uploadDocumentVersion(ctx: AccessContext, id: string, file: File) {
  assertCan(ctx, "document.create");
  const base = await requireDocument(ctx, id);
  const bytes = await readFile(file);
  return storeVersion(ctx, base, { fileName: file.name, mimeType: file.type, bytes });
}

/** Latest version of each document on a record (all versions with `allVersions`). */
export async function listDocuments(
  ctx: AccessContext,
  entityType: string,
  entityId: string,
  options: { allVersions?: boolean } = {},
) {
  assertCan(ctx, "document.view");
  await resolveEntity(ctx, entityType, entityId);
  return prisma.document.findMany({
    where: {
      organizationId: ctx.organizationId,
      entityType,
      entityId,
      deletedAt: null,
      ...(options.allVersions ? {} : { supersededAt: null }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}

export async function requireDocument(ctx: AccessContext, id: string) {
  const document = await prisma.document.findFirst({
    where: { id, organizationId: ctx.organizationId, deletedAt: null },
  });
  if (!document) throw new AppError("NOT_FOUND", "Document not found", 404);
  // Access to a document follows access to the record it is attached to.
  await resolveEntity(ctx, document.entityType, document.entityId);
  return document;
}

export async function listDocumentVersions(ctx: AccessContext, id: string) {
  assertCan(ctx, "document.view");
  const document = await requireDocument(ctx, id);
  const groupId = groupOf(document);
  const items = await prisma.document.findMany({
    where: { organizationId: ctx.organizationId, deletedAt: null, OR: [{ id: groupId }, { versionGroupId: groupId }] },
    orderBy: { version: "desc" },
    include: {
      signatureRequests: {
        select: { id: true, status: true, provider: true, simulated: true, sentAt: true, completedAt: true, signedDocumentId: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  return {
    items: items.map((d) => ({
      ...d,
      signatureRequests: d.signatureRequests.map((r) => ({
        ...r,
        notice: r.simulated ? SIMULATED_NOTICE : null,
      })),
    })),
    can: {
      createVersion: can(ctx, "document.create"),
      requestSignature: can(ctx, "signature.request"),
      delete: can(ctx, "document.delete"),
    },
  };
}

export const SIMULATED_NOTICE = "Simulated – not a legal signature";

export async function getDocumentDownload(ctx: AccessContext, id: string) {
  assertCan(ctx, "document.view");
  const document = await requireDocument(ctx, id);
  return { document, ...(await signedObjectUrl(DOCUMENTS_BUCKET, document.storagePath, 300)) };
}

/** Deletes the whole logical document (every version). Blocked once signed or while out for signature. */
export async function deleteDocument(ctx: AccessContext, id: string) {
  assertCan(ctx, "document.delete");
  const document = await requireDocument(ctx, id);
  const groupId = groupOf(document);
  const versions = await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const inGroup = { organizationId: ctx.organizationId, deletedAt: null, OR: [{ id: groupId }, { versionGroupId: groupId }] };
    const requests = await tx.signatureRequest.findMany({
      where: { status: { in: ["SENT", "VIEWED", "SIGNED"] }, document: inGroup },
      select: { status: true },
    });
    if (requests.some((r) => r.status === "SIGNED")) {
      throw new AppError("SIGNED_DOCUMENT", "A signed document cannot be deleted", 422);
    }
    if (requests.length > 0) {
      throw new AppError("SIGNATURE_PENDING", "Void the open signature request before deleting", 422);
    }
    const rows = await tx.document.findMany({ where: inGroup });
    await tx.document.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { deletedAt: new Date() } });
    await audit(tx, ctx, {
      action: "document.deleted",
      entity: "document",
      entityId: id,
      companyId: document.companyId,
      previous: { ...document, versions: rows.length },
    });
    return rows;
  });
  for (const row of versions) {
    await removeObject(DOCUMENTS_BUCKET, row.storagePath).catch((error) =>
      console.error("[documents] orphaned object", row.storagePath, error),
    );
  }
  return { id };
}

/**
 * Bytes of a stored document, for sending to an e-signature provider.
 * ponytail: goes through a short-lived signed URL because src/lib/storage/objects.ts has no
 * getObject; switch to a direct download helper when one is added there.
 */
export async function readDocumentBytes(document: Pick<Doc, "storagePath">) {
  const { signedUrl } = await signedObjectUrl(DOCUMENTS_BUCKET, document.storagePath, 60);
  const res = await fetch(signedUrl);
  if (!res.ok) throw new AppError("DOWNLOAD_FAILED", `Could not read the stored file (${res.status})`, 502);
  return Buffer.from(await res.arrayBuffer());
}
