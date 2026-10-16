import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";

/**
 * Restore drill against the LOCAL test database only:
 * backup.sh → verify-backup.sh (restore into intracore_restore_check, compare every table's
 * row count with the dump's snapshot) → restore.sh over a damaged copy → fixture row is back.
 */
const ROOT = path.resolve(__dirname, "..");
const SOURCE = process.env.DATABASE_URL!;
const PG_DUMP = process.env.PG_DUMP ?? ["/opt/homebrew/bin/pg_dump", "/usr/bin/pg_dump"].find(existsSync);
const PSQL = process.env.PSQL ?? ["/opt/homebrew/opt/postgresql@17/bin/psql", "/opt/homebrew/bin/psql", "/usr/bin/psql"].find(existsSync);
const PG_RESTORE = process.env.PG_RESTORE ?? ["/opt/homebrew/bin/pg_restore", "/usr/bin/pg_restore"].find(existsSync);
const tools = Boolean(PG_DUMP && PSQL && PG_RESTORE);
if (!tools) console.warn("[backup-restore] skipped: pg_dump/psql/pg_restore not found (set PG_DUMP, PSQL, PG_RESTORE)");

const SCRATCH_DB = "intracore_restore_check";
const SCRATCH = SOURCE.replace(/\/[^/?]+(\?.*)?$/, `/${SCRATCH_DB}`);
const ADMIN = SOURCE.replace(/\/[^/?]+(\?.*)?$/, "/postgres");
const env = { ...process.env, DATABASE_URL: SOURCE, PG_DUMP, PSQL, PG_RESTORE, VERIFY_ADMIN_URL: ADMIN, VERIFY_DB: SCRATCH_DB } as NodeJS.ProcessEnv;
const run = (script: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync("bash", [path.join(ROOT, "scripts", script), ...args], { env: { ...env, ...extra }, encoding: "utf8" });
const psql = (url: string, sql: string) => execFileSync(PSQL!, [url, "-qtAX", "-c", sql], { encoding: "utf8" }).trim();

let a: OrgFixture;
let dir: string;
let dump: string;
let runId: string;

describe.skipIf(!tools)("backup and restore drill", () => {
  beforeAll(async () => {
    expect(SOURCE).toMatch(/@(localhost|127\.0\.0\.1):/);
    a = await createOrg("Backup Drill");
    dir = mkdtempSync(path.join(tmpdir(), "intracore-backup-"));
  });
  afterAll(async () => {
    spawnSync(PSQL!, [ADMIN, "-qtAX", "-c", `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`]);
    if (runId) await prisma.backupRun.deleteMany({ where: { id: runId } });
    rmSync(dir, { recursive: true, force: true });
    await cleanupFixtures();
  });

  it("backup.sh dumps, checksums, snapshots row counts and records a BackupRun", async () => {
    const res = run("backup.sh", [], { BACKUP_DIR: dir });
    console.info(res.stdout.trim());
    expect(res.status, res.stderr).toBe(0);
    dump = /BACKUP_FILE=(.+)/.exec(res.stdout)![1];
    runId = /BACKUP_RUN_ID=(.+)/.exec(res.stdout)![1];

    const backup = await prisma.backupRun.findUniqueOrThrow({ where: { id: runId } });
    const sha = createHash("sha256").update(readFileSync(dump)).digest("hex");
    expect(backup).toMatchObject({ kind: "PG_DUMP", status: "SUCCEEDED", location: dump, checksum: sha });
    expect(backup.sizeBytes).toBe(BigInt(statSync(dump).size));
    expect(readFileSync(`${dump}.counts`, "utf8")).toMatch(/^organizations \d+$/m);
  });

  it("refuses unsafe sources and destinations", () => {
    expect(run("backup.sh", ["postgresql://u@db.example.com:5432/x"], { BACKUP_DIR: dir }).stderr).toContain("refusing non-local source");
    expect(run("backup.sh", [], { BACKUP_DIR: path.join(ROOT, "src", "tmp-backups") }).stderr).toContain("inside src/");
    rmSync(path.join(ROOT, "src", "tmp-backups"), { recursive: true, force: true });
    expect(run("verify-backup.sh", [dump], { VERIFY_ADMIN_URL: "postgresql://u@db.example.com:5432/postgres" }).stderr).toContain("must be local");
  });

  it("verify-backup.sh restores into a scratch database and every row count matches", async () => {
    const res = run("verify-backup.sh", [dump], { KEEP_RESTORE_DB: "1" });
    console.info(res.stdout.trim());
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("row counts match");

    expect(readFileSync(`${dump}.restored-counts`, "utf8")).toBe(readFileSync(`${dump}.counts`, "utf8"));
    expect(psql(SCRATCH, `SELECT name FROM organizations WHERE id = '${a.org.id}'`)).toBe("Backup Drill");
    expect(psql(SCRATCH, `SELECT count(*) FROM organization_members WHERE "organizationId" = '${a.org.id}'`)).toBe("1");

    const backup = await prisma.backupRun.findUniqueOrThrow({ where: { id: runId } });
    expect(backup.verifiedAt).not.toBeNull();
    expect(backup.verifyNotes).toContain("row counts match");
  });

  it("restore.sh refuses the production URL without the flag, then restores lost data", () => {
    // Stand-in "production" env file pointing at the scratch database: a guard bug can only hit scratch.
    const fakeEnv = path.join(dir, "prod.env");
    writeFileSync(fakeEnv, `DATABASE_URL="${SCRATCH}?pgbouncer=true"\n`);
    const refused = run("restore.sh", [dump, SCRATCH], { PROD_ENV_FILE: fakeEnv });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("refusing");
    expect(run("restore.sh", [dump, "postgresql://u@db.example.com:5432/x"], { PROD_ENV_FILE: fakeEnv }).stderr).toContain("non-local");

    // Simulate data loss in the restored copy, then restore over it.
    psql(SCRATCH, `SET session_replication_role = replica; DELETE FROM organizations WHERE id = '${a.org.id}'`);
    expect(psql(SCRATCH, `SELECT count(*) FROM organizations WHERE id = '${a.org.id}'`)).toBe("0");
    const restored = run("restore.sh", [dump, SCRATCH, "--i-understand-this-overwrites-production"], { PROD_ENV_FILE: fakeEnv });
    console.info(restored.stdout.trim());
    expect(restored.status, restored.stderr).toBe(0);
    expect(psql(SCRATCH, `SELECT name FROM organizations WHERE id = '${a.org.id}'`)).toBe("Backup Drill");
  });
});
