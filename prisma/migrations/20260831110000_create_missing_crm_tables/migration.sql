-- These tables existed in deployed databases (created via `prisma db push`) but no
-- migration created them, so a fresh database could not be built from history.
-- Every statement is guarded, so this is a no-op where the tables already exist.

DO $$ BEGIN
  CREATE TYPE "LeadViewCategory" AS ENUM ('HOME', 'ADMISSION', 'FLAGGED', 'REPORTS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'SELECT', 'DATE', 'BOOLEAN', 'TEXTAREA');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "IntegrationStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'ERROR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CommunicationType" AS ENUM ('WHATSAPP', 'EMAIL', 'SMS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CommunicationDirection" AS ENUM ('INBOUND', 'OUTBOUND');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "lead_views" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "category" "LeadViewCategory" NOT NULL DEFAULT 'HOME',
    "filters" JSONB NOT NULL DEFAULT '{}',
    "sort" TEXT NOT NULL DEFAULT 'createdAt',
    "sortDir" TEXT NOT NULL DEFAULT 'desc',
    "columns" JSONB NOT NULL DEFAULT '[]',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "requiredPermission" TEXT,
    "href" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_views_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_custom_field_definitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL DEFAULT 'TEXT',
    "options" JSONB,
    "section" TEXT NOT NULL DEFAULT 'profile',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_custom_field_definitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_custom_field_values" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "value" TEXT,
    "valueJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_custom_field_values_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_call_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "calledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationSec" INTEGER,
    "phoneNumber" TEXT,
    "callType" TEXT NOT NULL DEFAULT 'OUTBOUND',
    "outcome" TEXT,
    "notes" TEXT,
    "nextFollowUpAt" TIMESTAMP(3),
    "callbackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_call_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_transfers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromUserId" UUID,
    "toUserId" UUID,
    "fromTeamId" TEXT,
    "toTeamId" TEXT,
    "reason" TEXT,
    "transferredById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_transfers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_reengagements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "reengagedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "previousStageId" TEXT,
    "newStageId" TEXT,
    "assignedUserId" UUID,
    "nextCallDueAt" TIMESTAMP(3),
    "followUpAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_reengagements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_flag_definitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_flag_definitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_flags_on_leads" (
    "leadId" TEXT NOT NULL,
    "flagId" TEXT NOT NULL,

    CONSTRAINT "lead_flags_on_leads_pkey" PRIMARY KEY ("leadId","flagId")
);

CREATE TABLE IF NOT EXISTS "lead_score_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "breakdown" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_score_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "integrations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "credentialsRef" TEXT,
    "metadata" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_communications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" UUID,
    "type" "CommunicationType" NOT NULL,
    "direction" "CommunicationDirection" NOT NULL DEFAULT 'OUTBOUND',
    "subject" TEXT,
    "bodyPreview" TEXT,
    "externalId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_communications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "lead_views_organizationId_category_sortOrder_idx" ON "lead_views"("organizationId", "category", "sortOrder");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_views_organizationId_slug_key" ON "lead_views"("organizationId", "slug");
CREATE INDEX IF NOT EXISTS "lead_custom_field_definitions_organizationId_section_sortOr_idx" ON "lead_custom_field_definitions"("organizationId", "section", "sortOrder");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_custom_field_definitions_organizationId_key_key" ON "lead_custom_field_definitions"("organizationId", "key");
CREATE INDEX IF NOT EXISTS "lead_custom_field_values_organizationId_leadId_idx" ON "lead_custom_field_values"("organizationId", "leadId");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_custom_field_values_leadId_fieldId_key" ON "lead_custom_field_values"("leadId", "fieldId");
CREATE INDEX IF NOT EXISTS "lead_call_records_organizationId_leadId_calledAt_idx" ON "lead_call_records"("organizationId", "leadId", "calledAt");
CREATE INDEX IF NOT EXISTS "lead_call_records_organizationId_userId_idx" ON "lead_call_records"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "lead_transfers_organizationId_leadId_createdAt_idx" ON "lead_transfers"("organizationId", "leadId", "createdAt");
CREATE INDEX IF NOT EXISTS "lead_transfers_organizationId_toUserId_idx" ON "lead_transfers"("organizationId", "toUserId");
CREATE INDEX IF NOT EXISTS "lead_reengagements_organizationId_leadId_reengagedAt_idx" ON "lead_reengagements"("organizationId", "leadId", "reengagedAt");
CREATE INDEX IF NOT EXISTS "lead_flag_definitions_organizationId_sortOrder_idx" ON "lead_flag_definitions"("organizationId", "sortOrder");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_flag_definitions_organizationId_key_key" ON "lead_flag_definitions"("organizationId", "key");
CREATE INDEX IF NOT EXISTS "lead_score_snapshots_organizationId_leadId_createdAt_idx" ON "lead_score_snapshots"("organizationId", "leadId", "createdAt");
CREATE INDEX IF NOT EXISTS "integrations_organizationId_idx" ON "integrations"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_organizationId_provider_key" ON "integrations"("organizationId", "provider");
CREATE INDEX IF NOT EXISTS "lead_communications_organizationId_leadId_occurredAt_idx" ON "lead_communications"("organizationId", "leadId", "occurredAt");

DO $$ BEGIN
  ALTER TABLE "lead_views" ADD CONSTRAINT "lead_views_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_custom_field_definitions" ADD CONSTRAINT "lead_custom_field_definitions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_custom_field_values" ADD CONSTRAINT "lead_custom_field_values_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_custom_field_values" ADD CONSTRAINT "lead_custom_field_values_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_custom_field_values" ADD CONSTRAINT "lead_custom_field_values_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "lead_custom_field_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_call_records" ADD CONSTRAINT "lead_call_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_call_records" ADD CONSTRAINT "lead_call_records_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_call_records" ADD CONSTRAINT "lead_call_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_transfers" ADD CONSTRAINT "lead_transfers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_transfers" ADD CONSTRAINT "lead_transfers_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_transfers" ADD CONSTRAINT "lead_transfers_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_transfers" ADD CONSTRAINT "lead_transfers_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_transfers" ADD CONSTRAINT "lead_transfers_transferredById_fkey" FOREIGN KEY ("transferredById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_reengagements" ADD CONSTRAINT "lead_reengagements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_reengagements" ADD CONSTRAINT "lead_reengagements_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_reengagements" ADD CONSTRAINT "lead_reengagements_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_reengagements" ADD CONSTRAINT "lead_reengagements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_flag_definitions" ADD CONSTRAINT "lead_flag_definitions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_flags_on_leads" ADD CONSTRAINT "lead_flags_on_leads_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_flags_on_leads" ADD CONSTRAINT "lead_flags_on_leads_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "lead_flag_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_score_snapshots" ADD CONSTRAINT "lead_score_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_score_snapshots" ADD CONSTRAINT "lead_score_snapshots_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_communications" ADD CONSTRAINT "lead_communications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_communications" ADD CONSTRAINT "lead_communications_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lead_communications" ADD CONSTRAINT "lead_communications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

