import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { assertCan, type AccessContext } from "@/lib/access";
import { listQuerySchema, listArgs, paginate } from "@/lib/api/list";

/**
 * Platform backup runs recorded by scripts/backup.sh and scripts/verify-backup.sh.
 * BackupRun is platform-level (one database for all tenants), so it carries no org.
 */
export async function listBackupRuns(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "backup.view");
  const q = listQuerySchema.extend({ status: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]).optional() }).parse(query);
  const where = { status: q.status };
  const page = await paginate(q, () =>
    Promise.all([prisma.backupRun.findMany({ where, ...listArgs(q, ["startedAt"], "startedAt") }), prisma.backupRun.count({ where })]),
  );
  // BigInt is not JSON; sizes go out as strings like every other exact number.
  return { ...page, items: page.items.map((run) => ({ ...run, sizeBytes: run.sizeBytes?.toString() ?? null })) };
}

/** Headline status: latest successful and latest verified backup. */
export async function backupStatus(ctx: AccessContext) {
  assertCan(ctx, "backup.view");
  const [lastSucceeded, lastVerified, lastFailed] = await Promise.all([
    prisma.backupRun.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } }),
    prisma.backupRun.findFirst({ where: { verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" } }),
    prisma.backupRun.findFirst({ where: { status: "FAILED" }, orderBy: { startedAt: "desc" } }),
  ]);
  const plain = <T extends { sizeBytes: bigint | null } | null>(run: T) => (run ? { ...run, sizeBytes: run.sizeBytes?.toString() ?? null } : null);
  return { lastSucceeded: plain(lastSucceeded), lastVerified: plain(lastVerified), lastFailed: plain(lastFailed) };
}
