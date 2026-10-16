-- Phase 7: portal identities and invitations, saved reports, data exports, retention policies,
-- backup runs, dealer flag, generic import entity.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "isDealer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "entity" TEXT NOT NULL DEFAULT 'lead';

-- CreateTable
CREATE TABLE "portal_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "customerId" TEXT,
    "vendorId" TEXT,
    "employeeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invitedById" UUID,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portal_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_invitations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "customerId" TEXT,
    "vendorId" TEXT,
    "employeeId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" UUID,
    "revokedAt" TIMESTAMP(3),
    "invitedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_reports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_exports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'CSV',
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rowCount" INTEGER,
    "storagePath" TEXT,
    "error" TEXT,
    "requestedById" UUID NOT NULL,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "keepDays" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "lastPurged" INTEGER,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_runs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "location" TEXT,
    "sizeBytes" BIGINT,
    "checksum" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verifyNotes" TEXT,

    CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "portal_accounts_userId_idx" ON "portal_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "portal_accounts_organizationId_userId_kind_key" ON "portal_accounts"("organizationId", "userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "portal_invitations_tokenHash_key" ON "portal_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "portal_invitations_organizationId_email_idx" ON "portal_invitations"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "saved_reports_organizationId_name_key" ON "saved_reports"("organizationId", "name");

-- CreateIndex
CREATE INDEX "data_exports_organizationId_createdAt_idx" ON "data_exports"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_organizationId_target_key" ON "retention_policies"("organizationId", "target");

-- CreateIndex
CREATE INDEX "backup_runs_startedAt_idx" ON "backup_runs"("startedAt");

-- AddForeignKey
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "vendors"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_organizationId_employeeId_fkey" FOREIGN KEY ("organizationId", "employeeId") REFERENCES "employees"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_invitations" ADD CONSTRAINT "portal_invitations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Indexes for dashboard and report aggregates (see docs/METRICS.md).
CREATE INDEX "attendance_records_organizationId_date_idx" ON "attendance_records"("organizationId", "date");
CREATE INDEX "credit_notes_organizationId_companyId_status_noteDate_idx" ON "credit_notes"("organizationId", "companyId", "status", "noteDate");
CREATE INDEX "data_exports_organizationId_requestedById_createdAt_idx" ON "data_exports"("organizationId", "requestedById", "createdAt");
CREATE INDEX "expense_claims_organizationId_companyId_status_approvedAt_idx" ON "expense_claims"("organizationId", "companyId", "status", "approvedAt");
CREATE INDEX "leave_requests_organizationId_status_startDate_idx" ON "leave_requests"("organizationId", "status", "startDate");
CREATE INDEX "quotations_organizationId_companyId_decidedAt_idx" ON "quotations"("organizationId", "companyId", "decidedAt");
CREATE INDEX "quotations_organizationId_companyId_createdAt_idx" ON "quotations"("organizationId", "companyId", "createdAt");
CREATE INDEX "sales_invoices_organizationId_companyId_status_invoiceDate_idx" ON "sales_invoices"("organizationId", "companyId", "status", "invoiceDate");
CREATE INDEX "sales_orders_organizationId_companyId_confirmedAt_idx" ON "sales_orders"("organizationId", "companyId", "confirmedAt");
CREATE INDEX "saved_reports_organizationId_createdById_idx" ON "saved_reports"("organizationId", "createdById");
CREATE INDEX "stock_entries_organizationId_companyId_type_status_postedAt_idx" ON "stock_entries"("organizationId", "companyId", "type", "status", "postedAt");
CREATE INDEX "stock_moves_organizationId_companyId_movedAt_idx" ON "stock_moves"("organizationId", "companyId", "movedAt");
CREATE INDEX "tickets_organizationId_companyId_resolvedAt_idx" ON "tickets"("organizationId", "companyId", "resolvedAt");
CREATE INDEX "vendor_bills_organizationId_companyId_status_billDate_idx" ON "vendor_bills"("organizationId", "companyId", "status", "billDate");

-- RLS on the new tables (see 20261016100000_erp_foundation).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
