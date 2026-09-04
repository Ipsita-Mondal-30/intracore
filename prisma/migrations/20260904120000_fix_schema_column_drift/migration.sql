-- Fix column casing / missing columns that break lead list queries on some environments.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'reengagedAt'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'reEngagedAt'
  ) THEN
    EXECUTE 'ALTER TABLE "leads" RENAME COLUMN "reengagedAt" TO "reEngagedAt"';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'leads_organizationId_reengagedAt_idx'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'leads_organizationId_reEngagedAt_idx'
  ) THEN
    EXECUTE 'ALTER INDEX "leads_organizationId_reengagedAt_idx" RENAME TO "leads_organizationId_reEngagedAt_idx"';
  END IF;
END $$;

ALTER TABLE "lead_follow_ups" ADD COLUMN IF NOT EXISTS "remindedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "lead_follow_ups_status_dueAt_remindedAt_idx"
  ON "lead_follow_ups"("status", "dueAt", "remindedAt");

ALTER TABLE "lead_call_records" ADD COLUMN IF NOT EXISTS "didNumber" TEXT;
ALTER TABLE "lead_call_records" ADD COLUMN IF NOT EXISTS "recordingPath" TEXT;
ALTER TABLE "lead_call_records" ADD COLUMN IF NOT EXISTS "recordingFileName" TEXT;
ALTER TABLE "lead_call_records" ADD COLUMN IF NOT EXISTS "recordingMimeType" TEXT;
ALTER TABLE "lead_call_records" ADD COLUMN IF NOT EXISTS "recordingSizeBytes" INTEGER;
ALTER TABLE "lead_call_records" ADD COLUMN IF NOT EXISTS "recordingDurationSec" INTEGER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lead_call_records' AND column_name = 'did'
  ) THEN
    EXECUTE 'UPDATE "lead_call_records" SET "didNumber" = "did" WHERE "didNumber" IS NULL AND "did" IS NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lead_call_records' AND column_name = 'recordingUrl'
  ) THEN
    EXECUTE 'UPDATE "lead_call_records" SET "recordingPath" = "recordingUrl" WHERE "recordingPath" IS NULL AND "recordingUrl" IS NOT NULL';
  END IF;
END $$;
