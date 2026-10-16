-- Schema objects that deployed databases already have (via `prisma db push`) but no
-- migration created. Guarded so it is a no-op where they exist.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'RESCHEDULED';

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lostComment" TEXT;

CREATE INDEX IF NOT EXISTS "leads_organizationId_archivedAt_idx" ON "leads"("organizationId", "archivedAt");
CREATE INDEX IF NOT EXISTS "leads_organizationId_archivedAt_status_idx" ON "leads"("organizationId", "archivedAt", "status");
