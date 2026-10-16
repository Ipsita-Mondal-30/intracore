import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { decrypt } from "@/lib/crypto/encryption";
import { sanitizeError } from "@/lib/sanitize";
import { readDocumentBytes, requireDocument, SIMULATED_NOTICE, storeVersion } from "@/features/documents/service";

/**
 * E-signatures go through a provider adapter. A request's status changes ONLY from the
 * provider: a verified webhook or a status poll (`refreshSignatureRequest`). No API lets
 * a user mark a request SIGNED; an approval checkbox or an uploaded signature image is
 * never treated as an electronic signature. See docs/ESIGNATURE.md.
 */
export type ProviderStatus = "SENT" | "VIEWED" | "SIGNED" | "DECLINED" | "EXPIRED" | "VOIDED" | "FAILED";
export type Signer = { name: string; email: string; order: number };
export type ProviderSecrets = { webhookSecret?: string; apiKey?: string; [key: string]: unknown };

export interface ESignProvider {
  key: string;
  /** true for test/dev providers: their completions are never legal signatures */
  simulated: boolean;
  createEnvelope(
    input: {
      requestId: string;
      document: { fileName: string; mimeType: string; checksum: string | null; getBytes: () => Promise<Buffer> };
      signers: Signer[];
    },
    secrets: ProviderSecrets,
  ): Promise<{ providerRequestId: string }>;
  getStatus(providerRequestId: string, secrets: ProviderSecrets): Promise<{ status: ProviderStatus; evidence?: unknown }>;
  voidEnvelope?(providerRequestId: string, secrets: ProviderSecrets): Promise<void>;
  verifyWebhook(rawBody: string, headers: Headers, secret: string): boolean;
  parseWebhook(body: unknown): { eventId: string; providerRequestId: string; status: ProviderStatus; evidence?: unknown };
  /** The provider's signed/sealed PDF, stored as a new document version. */
  downloadSigned?(providerRequestId: string, secrets: ProviderSecrets): Promise<Buffer | null>;
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** `x-esign-timestamp: <unix ms>`, `x-esign-signature: sha256=<hex HMAC of "${timestamp}.${rawBody}">` */
export function verifyHmacWebhook(rawBody: string, headers: Headers, secret: string, now = Date.now()) {
  const timestamp = headers.get("x-esign-timestamp") ?? "";
  const signature = headers.get("x-esign-signature") ?? "";
  if (!secret || !/^\d+$/.test(timestamp) || !signature.startsWith("sha256=")) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const actual = Buffer.from(signature.slice("sha256=".length), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const STATUSES = ["SENT", "VIEWED", "SIGNED", "DECLINED", "EXPIRED", "VOIDED", "FAILED"] as const;
const mockEvent = z.object({
  eventId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  status: z.enum(STATUSES),
  evidence: z.record(z.unknown()).optional(),
});

/**
 * Development/test provider. Active only when the org has an enabled (CONNECTED)
 * Integration with provider "esign_mock". It sends nothing to anyone; completions arrive
 * as webhooks you sign yourself and are always flagged simulated.
 */
export const mockESignProvider: ESignProvider = {
  key: "esign_mock",
  simulated: true,
  async createEnvelope() {
    return { providerRequestId: `mock_${randomUUID()}` };
  },
  async getStatus() {
    return { status: "SENT" }; // the mock has no remote state; only webhooks move it
  },
  async voidEnvelope() {},
  verifyWebhook: (rawBody, headers, secret) => verifyHmacWebhook(rawBody, headers, secret),
  parseWebhook(body) {
    const e = mockEvent.parse(body);
    return { eventId: e.eventId, providerRequestId: e.requestId, status: e.status, evidence: e.evidence };
  },
};

/** Registered adapters by Integration.provider. Add a real provider here (docs/ESIGNATURE.md). */
export const ESIGN_PROVIDERS: Record<string, ESignProvider> = {
  [mockESignProvider.key]: mockESignProvider,
};

function parseSecrets(encrypted: string | null): ProviderSecrets {
  if (!encrypted) return {};
  return JSON.parse(decrypt(encrypted)) as ProviderSecrets;
}

async function providerFor(organizationId: string, key?: string) {
  const integration = await prisma.integration.findFirst({
    where: { organizationId, status: "CONNECTED", provider: key ?? { in: Object.keys(ESIGN_PROVIDERS) } },
    orderBy: { createdAt: "asc" },
  });
  const provider = integration && ESIGN_PROVIDERS[integration.provider];
  if (!provider) {
    throw new AppError("NOT_CONFIGURED", "No e-signature provider is configured for this organization", 409);
  }
  return { provider, secrets: parseSecrets(integration.secrets) };
}

/** Webhook lookup: the integration's webhook secret, or null when it is not usable. */
export async function webhookSecretFor(organizationId: string, key: string) {
  const integration = await prisma.integration.findUnique({
    where: { organizationId_provider: { organizationId, provider: key } },
  });
  if (!integration || integration.status !== "CONNECTED") return null;
  try {
    return parseSecrets(integration.secrets).webhookSecret ?? null;
  } catch {
    return null;
  }
}

// ─── Signature requests ───────────────────────────────────────────────────────

const OPEN = ["DRAFT", "SENT", "VIEWED"];
const TERMINAL = ["SIGNED", "DECLINED", "EXPIRED", "VOIDED", "FAILED"];
/** Provider-driven transitions; anything else (replays, out-of-order events) is ignored. */
const TRANSITIONS: Record<string, ProviderStatus[]> = {
  SENT: ["VIEWED", "SIGNED", "DECLINED", "EXPIRED", "VOIDED", "FAILED"],
  VIEWED: ["SIGNED", "DECLINED", "EXPIRED", "VOIDED", "FAILED"],
};
const DOCUMENT_STATUS: Record<string, string> = {
  SENT: "PENDING",
  VIEWED: "PENDING",
  SIGNED: "SIGNED",
  DECLINED: "DECLINED",
  EXPIRED: "EXPIRED",
  VOIDED: "VOIDED",
  FAILED: "NONE",
};

const createSchema = z.object({
  documentId: z.string().min(1).max(64),
  signers: z
    .array(z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email().max(254) }))
    .min(1)
    .max(10)
    .refine((s) => new Set(s.map((x) => x.email)).size === s.length, "Each signer needs a distinct email"),
});

type Req = Prisma.SignatureRequestGetPayload<object>;
const present = (r: Req) => ({ ...r, notice: r.simulated ? SIMULATED_NOTICE : null });
const system = (r: Pick<Req, "organizationId" | "createdById">) =>
  // Provider events have no signed-in user; attribute them to the requester (or nobody).
  ({ organizationId: r.organizationId, userId: r.createdById as string });

async function requireRequest(ctx: AccessContext, id: string) {
  const request = await prisma.signatureRequest.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!request) throw new AppError("NOT_FOUND", "Signature request not found", 404);
  const document = await requireDocument(ctx, request.documentId).catch(() => {
    throw new AppError("NOT_FOUND", "Signature request not found", 404);
  });
  return { request, document };
}

async function lockRequest(tx: Prisma.TransactionClient, id: string) {
  const [row] = await tx.$queryRaw<Req[]>`SELECT * FROM "signature_requests" WHERE "id" = ${id} FOR UPDATE`;
  if (!row) throw new AppError("NOT_FOUND", "Signature request not found", 404);
  return row;
}

export async function createSignatureRequest(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "signature.request");
  const data = createSchema.parse(input);
  const document = await requireDocument(ctx, data.documentId);
  if (document.mimeType !== "application/pdf") {
    throw new AppError("INVALID_FILE", "Only PDF documents can be sent for signature", 422);
  }
  if (document.supersededAt) {
    throw new AppError("INVALID_STATE", "Only the latest version of a document can be sent for signature", 422);
  }
  const { provider } = await providerFor(ctx.organizationId);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "documents" WHERE "id" = ${document.id} FOR UPDATE`;
    const open = await tx.signatureRequest.count({ where: { documentId: document.id, status: { in: OPEN } } });
    if (open > 0) throw new AppError("CONFLICT", "This document already has an open signature request", 409);
    const request = await tx.signatureRequest.create({
      data: {
        organizationId: ctx.organizationId,
        documentId: document.id,
        provider: provider.key,
        simulated: provider.simulated,
        signers: data.signers.map((s, i) => ({ ...s, order: i + 1 })),
        createdById: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "signature_request.created", entity: "signature_request", entityId: request.id, companyId: document.companyId, next: request });
    return present(request);
  });
}

export async function listSignatureRequests(ctx: AccessContext, query: Record<string, string>) {
  assertCan(ctx, "signature.view");
  const documentId = z.string().min(1).parse(query.documentId);
  await requireDocument(ctx, documentId);
  const rows = await prisma.signatureRequest.findMany({
    where: { organizationId: ctx.organizationId, documentId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(present);
}

export async function getSignatureRequest(ctx: AccessContext, id: string) {
  assertCan(ctx, "signature.view");
  return present((await requireRequest(ctx, id)).request);
}

/** DRAFT → SENT through the provider. Claimed first, so a double click sends once. */
export async function sendSignatureRequest(ctx: AccessContext, id: string) {
  assertCan(ctx, "signature.request");
  const { request, document } = await requireRequest(ctx, id);
  const { provider, secrets } = await providerFor(ctx.organizationId, request.provider);
  const claimed = await prisma.signatureRequest.updateMany({
    where: { id, status: "DRAFT" },
    data: { status: "SENT", sentAt: new Date() },
  });
  if (claimed.count === 0) throw new AppError("INVALID_STATE", `Cannot send a ${request.status} request`, 422);

  let providerRequestId: string;
  try {
    ({ providerRequestId } = await provider.createEnvelope(
      {
        requestId: id,
        document: { fileName: document.fileName, mimeType: document.mimeType, checksum: document.checksum, getBytes: () => readDocumentBytes(document) },
        signers: request.signers as Signer[],
      },
      secrets,
    ));
  } catch (error) {
    const message = sanitizeError(error);
    await prisma.signatureRequest.update({ where: { id }, data: { status: "FAILED", error: message } });
    throw new AppError("PROVIDER_ERROR", `The e-signature provider rejected the request: ${message}`, 502);
  }
  return prisma.$transaction(async (tx) => {
    const sent = await tx.signatureRequest.update({ where: { id }, data: { providerRequestId } });
    await tx.document.update({ where: { id: document.id }, data: { signatureStatus: "PENDING" } });
    await audit(tx, ctx, { action: "signature_request.sent", entity: "signature_request", entityId: id, companyId: document.companyId, next: { providerRequestId } });
    return present(sent);
  });
}

/** Cancels a draft, or voids an envelope at the provider. */
export async function voidSignatureRequest(ctx: AccessContext, id: string) {
  assertCan(ctx, "signature.request");
  const { request, document } = await requireRequest(ctx, id);
  if (!OPEN.includes(request.status)) throw new AppError("INVALID_STATE", `Cannot void a ${request.status} request`, 422);
  if (request.providerRequestId) {
    const { provider, secrets } = await providerFor(ctx.organizationId, request.provider);
    await provider.voidEnvelope?.(request.providerRequestId, secrets);
  }
  return prisma.$transaction(async (tx) => {
    const row = await lockRequest(tx, id);
    if (!OPEN.includes(row.status)) throw new AppError("INVALID_STATE", `Cannot void a ${row.status} request`, 422);
    const voided = await tx.signatureRequest.update({ where: { id }, data: { status: "VOIDED", completedAt: new Date() } });
    if (row.status !== "DRAFT") await tx.document.update({ where: { id: document.id }, data: { signatureStatus: "VOIDED" } });
    await audit(tx, ctx, { action: "signature_request.voided", entity: "signature_request", entityId: id, companyId: document.companyId, previous: { status: row.status } });
    return present(voided);
  });
}

/** Polls the provider for the current status (for providers or setups without webhooks). */
export async function refreshSignatureRequest(ctx: AccessContext, id: string) {
  assertCan(ctx, "signature.request");
  const { request } = await requireRequest(ctx, id);
  if (!request.providerRequestId || TERMINAL.includes(request.status)) return present(request);
  const { provider, secrets } = await providerFor(ctx.organizationId, request.provider);
  const update = await provider.getStatus(request.providerRequestId, secrets);
  await applyProviderStatus(request, provider, secrets, update);
  return present(await prisma.signatureRequest.findUniqueOrThrow({ where: { id } }));
}

/**
 * The only path that changes a sent request's status. Idempotent: a replayed or
 * out-of-order event is ignored. On SIGNED the provider's evidence is stored and, if the
 * provider returns a signed file, it becomes the document's next version.
 */
export async function applyProviderStatus(
  request: Req,
  provider: ESignProvider,
  secrets: ProviderSecrets,
  update: { status: ProviderStatus; evidence?: unknown },
): Promise<"APPLIED" | "IGNORED"> {
  if (!TRANSITIONS[request.status]?.includes(update.status)) return "IGNORED";

  // Fetch the signed file before the transaction (network), then attach it inside.
  const signedBytes =
    update.status === "SIGNED" && provider.downloadSigned && request.providerRequestId && !request.signedDocumentId
      ? await provider.downloadSigned(request.providerRequestId, secrets)
      : null;

  const apply = async (tx: Prisma.TransactionClient, signedDocumentId?: string) => {
    const row = await lockRequest(tx, request.id);
    if (!TRANSITIONS[row.status]?.includes(update.status)) return false;
    const terminal = TERMINAL.includes(update.status);
    await tx.signatureRequest.update({
      where: { id: row.id },
      data: {
        status: update.status,
        ...(update.evidence !== undefined ? { evidence: update.evidence as Prisma.InputJsonValue } : {}),
        ...(terminal ? { completedAt: new Date() } : {}),
        ...(signedDocumentId ? { signedDocumentId } : {}),
      },
    });
    await tx.document.update({ where: { id: row.documentId }, data: { signatureStatus: DOCUMENT_STATUS[update.status] } });
    const document = await tx.document.findUniqueOrThrow({ where: { id: row.documentId }, select: { companyId: true } });
    await audit(tx, system(row), {
      action: `signature_request.${update.status.toLowerCase()}`,
      entity: "signature_request",
      entityId: row.id,
      companyId: document.companyId,
      previous: { status: row.status },
      next: { status: update.status, provider: provider.key, simulated: row.simulated },
    });
    return true;
  };

  if (!signedBytes) {
    return (await prisma.$transaction((tx) => apply(tx))) ? "APPLIED" : "IGNORED";
  }

  const base = await prisma.document.findUniqueOrThrow({ where: { id: request.documentId } });
  let applied = false;
  const rollback = new Error("already applied");
  await storeVersion(
    { organizationId: request.organizationId, userId: request.createdById ?? base.uploadedById },
    base,
    { fileName: base.fileName.replace(/(\.pdf)?$/i, "-signed.pdf"), mimeType: "application/pdf", bytes: signedBytes, signatureStatus: "SIGNED" },
    async (tx, document) => {
      applied = await apply(tx, document.id);
      if (!applied) throw rollback; // a concurrent event won: drop this version and its object
    },
  ).catch((error) => {
    if (error !== rollback) throw error;
  });
  return applied ? "APPLIED" : "IGNORED";
}

/**
 * Verified-webhook entry point (route: /api/webhooks/esign/[provider]). Returns null when
 * the delivery is not authentic (unknown provider, unknown request, bad signature), so the
 * caller answers with one indistinguishable 401.
 */
export async function handleESignWebhook(providerKey: string, rawBody: string, headers: Headers) {
  const provider = Object.prototype.hasOwnProperty.call(ESIGN_PROVIDERS, providerKey) ? ESIGN_PROVIDERS[providerKey] : undefined;
  if (!provider) return null;
  let event: ReturnType<ESignProvider["parseWebhook"]>;
  try {
    event = provider.parseWebhook(JSON.parse(rawBody));
  } catch {
    return null;
  }
  const request = await prisma.signatureRequest.findUnique({
    where: { provider_providerRequestId: { provider: provider.key, providerRequestId: event.providerRequestId } },
  });
  if (!request) return null;
  const secret = await webhookSecretFor(request.organizationId, provider.key);
  if (!secret || !provider.verifyWebhook(rawBody, headers, secret)) return null;

  // Dedupe on the provider's event id: a redelivery is acknowledged without reprocessing.
  const created = await prisma.webhookEvent.createMany({
    data: [{ organizationId: request.organizationId, provider: provider.key, externalId: event.eventId, payload: JSON.parse(rawBody) as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
  const where = { provider_externalId: { provider: provider.key, externalId: event.eventId } };
  const stored = await prisma.webhookEvent.findUniqueOrThrow({ where });
  if (created.count === 0 && stored.status !== "FAILED") return { duplicate: true, status: stored.status };

  try {
    const secrets = parseSecrets(
      (await prisma.integration.findUniqueOrThrow({
        where: { organizationId_provider: { organizationId: request.organizationId, provider: provider.key } },
      })).secrets,
    );
    const result = await applyProviderStatus(request, provider, secrets, event);
    const status = result === "APPLIED" ? "PROCESSED" : "IGNORED";
    await prisma.webhookEvent.update({ where, data: { status, processedAt: new Date(), attempts: { increment: 1 }, error: null } });
    return { duplicate: false, status };
  } catch (error) {
    await prisma.webhookEvent.update({ where, data: { status: "FAILED", attempts: { increment: 1 }, error: sanitizeError(error) } });
    throw error;
  }
}
