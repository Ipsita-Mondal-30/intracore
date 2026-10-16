-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "companyId" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "pan" TEXT,
    "gstin" TEXT,
    "stateCode" TEXT,
    "baseCurrency" TEXT NOT NULL DEFAULT 'INR',
    "address" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "stateCode" TEXT,
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_scopes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "assignedUserId" UUID,
    "createdById" UUID NOT NULL,
    "dueAt" TIMESTAMP(3),
    "remindAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "priority" "LeadPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_organizationId_code_key" ON "companies"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "companies_organizationId_id_key" ON "companies"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "companies_organizationId_gstin_key" ON "companies"("organizationId", "gstin");

-- CreateIndex
CREATE INDEX "branches_organizationId_companyId_idx" ON "branches"("organizationId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "branches_companyId_code_key" ON "branches"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "branches_organizationId_id_key" ON "branches"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_organizationId_companyId_id_key" ON "branches"("organizationId", "companyId", "id");

-- CreateIndex
CREATE INDEX "member_scopes_memberId_idx" ON "member_scopes"("memberId");

-- CreateIndex
CREATE INDEX "member_scopes_organizationId_companyId_idx" ON "member_scopes"("organizationId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequences_companyId_documentType_key" ON "number_sequences"("companyId", "documentType");

-- CreateIndex
CREATE INDEX "idempotency_keys_createdAt_idx" ON "idempotency_keys"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_organizationId_userId_key_key" ON "idempotency_keys"("organizationId", "userId", "key");

-- CreateIndex
CREATE INDEX "tasks_organizationId_assignedUserId_status_dueAt_idx" ON "tasks"("organizationId", "assignedUserId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_organizationId_entityType_entityId_idx" ON "tasks"("organizationId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "tasks_status_remindAt_remindedAt_idx" ON "tasks"("status", "remindAt", "remindedAt");

-- CreateIndex
CREATE UNIQUE INDEX "documents_storagePath_key" ON "documents"("storagePath");

-- CreateIndex
CREATE INDEX "documents_organizationId_entityType_entityId_idx" ON "documents"("organizationId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_companyId_createdAt_idx" ON "audit_logs"("organizationId", "companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organizationId_id_key" ON "organization_members"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_scopes" ADD CONSTRAINT "member_scopes_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "organization_members"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_scopes" ADD CONSTRAINT "member_scopes_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_scopes" ADD CONSTRAINT "member_scopes_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Backfill: every existing organization gets a default company + branch, and
-- every existing member is scoped to it, so current users keep access. ───────────
INSERT INTO "companies" ("id", "organizationId", "code", "name", "baseCurrency", "isDefault", "updatedAt")
SELECT 'cmp_' || o."id", o."id", 'MAIN', o."name", o."currency", true, CURRENT_TIMESTAMP
FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "companies" c WHERE c."organizationId" = o."id");

INSERT INTO "branches" ("id", "organizationId", "companyId", "code", "name", "updatedAt")
SELECT 'br_' || c."id", c."organizationId", c."id", 'HO', 'Head Office', CURRENT_TIMESTAMP
FROM "companies" c
WHERE NOT EXISTS (SELECT 1 FROM "branches" b WHERE b."companyId" = c."id");

INSERT INTO "member_scopes" ("id", "organizationId", "memberId", "companyId")
SELECT 'ms_' || m."id", m."organizationId", m."id", c."id"
FROM "organization_members" m
JOIN "companies" c ON c."organizationId" = m."organizationId" AND c."isDefault"
WHERE NOT EXISTS (SELECT 1 FROM "member_scopes" s WHERE s."memberId" = m."id");

-- ─── Row level security on every public table. Prisma connects as the table owner
-- and bypasses RLS; the Supabase anon/authenticated roles get nothing unless a policy
-- grants it, which closes the REST (PostgREST) exposure of tables without policies. ─
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- Realtime pushes notification rows to their recipient only.
DROP POLICY IF EXISTS "notifications_recipient_select" ON "notifications";
CREATE POLICY "notifications_recipient_select" ON "notifications"
  FOR SELECT USING ("userId" = auth.uid());
