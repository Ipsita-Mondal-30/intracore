import { z } from "zod";
import type { CommunicationType, Integration, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { decrypt, encrypt } from "@/lib/crypto/encryption";
import { sanitizeError } from "@/lib/sanitize";
import { getProvider, type ProviderSettings } from "@/features/communication/providers";
import { fieldsSchema, PROVIDERS, providerDef, type ProviderDef } from "./registry";

/**
 * Integration configuration. Secrets are AES-GCM encrypted into Integration.secrets and are
 * never returned: callers only see `secretsConfigured: { field: true|false }`. Non-secret
 * settings live in Integration.metadata. Status: DISCONNECTED (off), CONNECTED (on),
 * ERROR (on, but the last health check failed — deliveries are still attempted).
 * One enabled provider per channel: enabling one disables the others for that channel.
 */
type Db = PrismaClient | Prisma.TransactionClient;
const ENABLED = ["CONNECTED", "ERROR"] as const;

export function readSecrets(row: Pick<Integration, "secrets"> | null): Record<string, string> {
  if (!row?.secrets) return {};
  try {
    return JSON.parse(decrypt(row.secrets)) as Record<string, string>;
  } catch {
    return {}; // unreadable (e.g. rotated ENCRYPTION_KEY): treated as not configured
  }
}

const readConfig = (row: Pick<Integration, "metadata"> | null) => ((row?.metadata ?? {}) as Record<string, string>);

export function providerSettings(row: Integration): ProviderSettings {
  return { secrets: readSecrets(row), config: readConfig(row) };
}

/** The org's enabled integration for a channel, or null (→ NOT_CONFIGURED). */
export async function activeIntegration(db: Db, organizationId: string, channel: CommunicationType) {
  const keys = Object.values(PROVIDERS).filter((p) => p.channel === channel).map((p) => p.key);
  return db.integration.findFirst({
    where: { organizationId, provider: { in: keys }, status: { in: [...ENABLED] } },
    orderBy: { updatedAt: "desc" },
  });
}

function present(def: ProviderDef, row: Integration | null) {
  const secrets = readSecrets(row);
  const config = readConfig(row);
  return {
    id: row?.id ?? null,
    provider: def.key,
    label: def.label,
    channel: def.channel,
    mock: Boolean(def.mock),
    status: row?.status ?? "DISCONNECTED",
    enabled: Boolean(row && (ENABLED as readonly string[]).includes(row.status)),
    config: Object.fromEntries(def.config.map((f) => [f.key, config[f.key] ?? null])),
    secretsConfigured: Object.fromEntries(def.secrets.map((f) => [f.key, Boolean(secrets[f.key])])),
    lastCheckedAt: row?.lastCheckedAt ?? null,
    lastError: row?.lastError ?? null,
    updatedAt: row?.updatedAt ?? null,
    webhookPath: def.key === "whatsapp_cloud" && row ? `/api/webhooks/whatsapp/${row.id}` : null,
    fields: { secrets: def.secrets, config: def.config },
  };
}
export type IntegrationView = ReturnType<typeof present>;

function getDef(key: string) {
  const def = providerDef(key);
  if (!def) throw new AppError("NOT_FOUND", "Unknown integration provider", 404);
  return def;
}

const findRow = (db: Db, ctx: AccessContext, provider: string) =>
  db.integration.findUnique({ where: { organizationId_provider: { organizationId: ctx.organizationId, provider } } });

export async function listIntegrations(ctx: AccessContext) {
  assertCan(ctx, "integration.view");
  const rows = await prisma.integration.findMany({ where: { organizationId: ctx.organizationId, provider: { in: Object.keys(PROVIDERS) } } });
  return Object.values(PROVIDERS).map((def) => present(def, rows.find((r) => r.provider === def.key) ?? null));
}

export async function getIntegration(ctx: AccessContext, provider: string) {
  assertCan(ctx, "integration.view");
  const def = getDef(provider);
  return present(def, await findRow(prisma, ctx, provider));
}

/** PUT config (replaced) and secrets (merged: omitted or blank secret fields keep their stored value). */
export async function configureIntegration(ctx: AccessContext, provider: string, input: unknown) {
  assertCan(ctx, "integration.manage");
  const def = getDef(provider);
  const data = z
    .object({ config: fieldsSchema(def.config).default({}), secrets: fieldsSchema(def.secrets, true).default({}) })
    .strict()
    .parse(input ?? {});
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "integrations" WHERE "organizationId" = ${ctx.organizationId} AND "provider" = ${provider} FOR UPDATE`;
    const row = await findRow(tx, ctx, provider);
    const provided = Object.fromEntries(Object.entries(data.secrets).filter(([, v]) => v));
    const secrets = fieldsSchema(def.secrets).parse({ ...readSecrets(row), ...provided });
    const config = Object.fromEntries(Object.entries(data.config).filter(([, v]) => v));
    const fields = { secrets: Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null, metadata: config };
    const saved = row
      ? await tx.integration.update({ where: { id: row.id }, data: fields })
      : await tx.integration.create({ data: { organizationId: ctx.organizationId, provider, status: "DISCONNECTED", ...fields } });
    // Secret values are never audited, only which fields changed.
    await audit(tx, ctx, {
      action: "integration.configured",
      entity: "integration",
      entityId: saved.id,
      previous: row ? { config: readConfig(row) } : undefined,
      next: { config, secretsUpdated: Object.keys(provided) },
    });
    return present(def, saved);
  });
}

function assertConfigured(def: ProviderDef, row: Integration | null) {
  const secrets = fieldsSchema(def.secrets).safeParse(readSecrets(row));
  const config = fieldsSchema(def.config).safeParse(readConfig(row));
  if (!secrets.success || !config.success) {
    throw new AppError("NOT_CONFIGURED", `${def.label} is missing required settings`, 422);
  }
}

export async function setIntegrationEnabled(ctx: AccessContext, provider: string, enabled: boolean) {
  assertCan(ctx, enabled ? "integration.connect" : "integration.disconnect");
  const def = getDef(provider);
  return prisma.$transaction(async (tx) => {
    let row = await findRow(tx, ctx, provider);
    if (!enabled && !row) throw new AppError("NOT_FOUND", "Integration is not configured", 404);
    if (enabled) {
      assertConfigured(def, row);
      const others = def.channel ? Object.values(PROVIDERS).filter((p) => p.channel === def.channel && p.key !== provider).map((p) => p.key) : [];
      await tx.integration.updateMany({
        where: { organizationId: ctx.organizationId, provider: { in: others }, status: { in: [...ENABLED] } },
        data: { status: "DISCONNECTED" },
      });
      row ??= await tx.integration.create({ data: { organizationId: ctx.organizationId, provider, metadata: {} } });
    }
    const saved = await tx.integration.update({ where: { id: row!.id }, data: { status: enabled ? "CONNECTED" : "DISCONNECTED" } });
    await audit(tx, ctx, {
      action: enabled ? "integration.enabled" : "integration.disabled",
      entity: "integration",
      entityId: saved.id,
      previous: { status: row!.status },
      next: { status: saved.status },
    });
    return present(def, saved);
  });
}

/** Calls the provider (10 s timeout) and records lastCheckedAt / sanitized lastError / status. */
export async function checkIntegration(ctx: AccessContext, provider: string) {
  assertCan(ctx, "integration.manage");
  const def = getDef(provider);
  const row = await findRow(prisma, ctx, provider);
  if (!row) throw new AppError("NOT_FOUND", "Integration is not configured", 404);
  let error: string | null = null;
  try {
    // Non-messaging providers (e.g. e-signature) have no health check of their own.
    await getProvider(provider)?.healthCheck(providerSettings(row));
  } catch (e) {
    error = sanitizeError(e);
  }
  const enabled = (ENABLED as readonly string[]).includes(row.status);
  const saved = await prisma.integration.update({
    where: { id: row.id },
    data: { lastCheckedAt: new Date(), lastError: error, status: enabled ? (error ? "ERROR" : "CONNECTED") : row.status },
  });
  return { ok: !error, error, integration: present(def, saved) };
}
