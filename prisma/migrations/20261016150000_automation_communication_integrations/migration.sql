-- Phase 6: workflows, approvals, reminders, background jobs, communication centre,
-- marketing, loyalty, document versions and e-signature requests, integration health.

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "checksum" TEXT,
ADD COLUMN     "signatureStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "versionGroupId" TEXT;

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "secrets" TEXT;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "dedupeKey" TEXT;

-- AlterTable
ALTER TABLE "user_notification_preferences" ADD COLUMN     "approvalRequests" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reminders" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "triggerType" TEXT NOT NULL DEFAULT 'EVENT',
    "triggerEntity" TEXT NOT NULL,
    "triggerAction" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "approvalSteps" JSONB NOT NULL DEFAULT '[]',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cursorAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "snapshot" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "approverUserId" UUID,
    "approverRoleCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "escalateToUserId" UUID,
    "escalatedAt" TIMESTAMP(3),
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "recurrence" TEXT NOT NULL DEFAULT 'NONE',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "endsAt" TIMESTAMP(3),
    "lastFiredAt" TIMESTAMP(3),
    "fireCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "result" JSONB,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" "CommunicationType" NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "category" TEXT NOT NULL DEFAULT 'TRANSACTIONAL',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "providerTemplateName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_consents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" "CommunicationType" NOT NULL,
    "address" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT,
    "recordedById" UUID,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" "CommunicationType" NOT NULL,
    "direction" "CommunicationDirection" NOT NULL DEFAULT 'OUTBOUND',
    "provider" TEXT NOT NULL,
    "templateId" TEXT,
    "campaignId" TEXT,
    "toAddress" TEXT NOT NULL,
    "fromAddress" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "providerMessageId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "createdById" UUID,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '[]',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "CommunicationType" NOT NULL,
    "templateId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'MARKETING',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "submittedById" UUID,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "customerId" TEXT,
    "contactId" TEXT,
    "leadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "communicationLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_feedback" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "campaignId" TEXT,
    "ticketId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_ledger" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "signers" JSONB NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "signedDocumentId" TEXT,
    "evidence" JSONB,
    "error" TEXT,
    "createdById" UUID,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_definitions_isEnabled_triggerEntity_triggerAction_idx" ON "workflow_definitions"("isEnabled", "triggerEntity", "triggerAction");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_organizationId_name_key" ON "workflow_definitions"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_organizationId_id_key" ON "workflow_definitions"("organizationId", "id");

-- CreateIndex
CREATE INDEX "workflow_runs_organizationId_status_idx" ON "workflow_runs"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_workflowId_sourceEventId_key" ON "workflow_runs"("workflowId", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_organizationId_id_key" ON "workflow_runs"("organizationId", "id");

-- CreateIndex
CREATE INDEX "workflow_run_events_runId_createdAt_idx" ON "workflow_run_events"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "approval_requests_organizationId_status_dueAt_idx" ON "approval_requests"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "approval_requests_organizationId_approverUserId_status_idx" ON "approval_requests"("organizationId", "approverUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_organizationId_id_key" ON "approval_requests"("organizationId", "id");

-- CreateIndex
CREATE INDEX "reminders_isActive_nextRunAt_idx" ON "reminders"("isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "reminders_organizationId_userId_idx" ON "reminders"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_key_key" ON "background_jobs"("key");

-- CreateIndex
CREATE INDEX "background_jobs_status_runAt_idx" ON "background_jobs"("status", "runAt");

-- CreateIndex
CREATE INDEX "background_jobs_organizationId_status_idx" ON "background_jobs"("organizationId", "status");

-- CreateIndex
CREATE INDEX "job_runs_name_startedAt_idx" ON "job_runs"("name", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_organizationId_channel_name_language_key" ON "message_templates"("organizationId", "channel", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_organizationId_id_key" ON "message_templates"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_consents_organizationId_channel_address_purpose_key" ON "contact_consents"("organizationId", "channel", "address", "purpose");

-- CreateIndex
CREATE INDEX "communication_logs_organizationId_createdAt_idx" ON "communication_logs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "communication_logs_organizationId_campaignId_idx" ON "communication_logs"("organizationId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "communication_logs_organizationId_idempotencyKey_key" ON "communication_logs"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "communication_logs_provider_providerMessageId_key" ON "communication_logs"("provider", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "communication_logs_organizationId_id_key" ON "communication_logs"("organizationId", "id");

-- CreateIndex
CREATE INDEX "webhook_events_organizationId_status_receivedAt_idx" ON "webhook_events"("organizationId", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_externalId_key" ON "webhook_events"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "segments_organizationId_name_key" ON "segments"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "segments_organizationId_id_key" ON "segments"("organizationId", "id");

-- CreateIndex
CREATE INDEX "campaigns_organizationId_status_scheduledAt_idx" ON "campaigns"("organizationId", "status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_organizationId_id_key" ON "campaigns"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_communicationLogId_key" ON "campaign_recipients"("communicationLogId");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaignId_status_idx" ON "campaign_recipients"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaignId_address_key" ON "campaign_recipients"("campaignId", "address");

-- CreateIndex
CREATE INDEX "customer_feedback_organizationId_customerId_idx" ON "customer_feedback"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "customer_feedback_organizationId_createdAt_idx" ON "customer_feedback"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "loyalty_ledger_organizationId_customerId_createdAt_idx" ON "loyalty_ledger"("organizationId", "customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_ledger_organizationId_sourceType_sourceId_kind_key" ON "loyalty_ledger"("organizationId", "sourceType", "sourceId", "kind");

-- CreateIndex
CREATE INDEX "signature_requests_organizationId_status_idx" ON "signature_requests"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_provider_providerRequestId_key" ON "signature_requests"("provider", "providerRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "documents_organizationId_id_key" ON "documents"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_versionGroupId_version_key" ON "documents"("versionGroupId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_organizationId_userId_dedupeKey_key" ON "notifications"("organizationId", "userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organizationId_workflowId_fkey" FOREIGN KEY ("organizationId", "workflowId") REFERENCES "workflow_definitions"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_organizationId_runId_fkey" FOREIGN KEY ("organizationId", "runId") REFERENCES "workflow_runs"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organizationId_runId_fkey" FOREIGN KEY ("organizationId", "runId") REFERENCES "workflow_runs"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_consents" ADD CONSTRAINT "contact_consents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_organizationId_templateId_fkey" FOREIGN KEY ("organizationId", "templateId") REFERENCES "message_templates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_organizationId_campaignId_fkey" FOREIGN KEY ("organizationId", "campaignId") REFERENCES "campaigns"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organizationId_templateId_fkey" FOREIGN KEY ("organizationId", "templateId") REFERENCES "message_templates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organizationId_segmentId_fkey" FOREIGN KEY ("organizationId", "segmentId") REFERENCES "segments"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organizationId_campaignId_fkey" FOREIGN KEY ("organizationId", "campaignId") REFERENCES "campaigns"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_feedback" ADD CONSTRAINT "customer_feedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_feedback" ADD CONSTRAINT "customer_feedback_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_feedback" ADD CONSTRAINT "customer_feedback_organizationId_campaignId_fkey" FOREIGN KEY ("organizationId", "campaignId") REFERENCES "campaigns"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "documents"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing documents become version 1 of their own group.
UPDATE "documents" SET "versionGroupId" = "id" WHERE "versionGroupId" IS NULL;

-- RLS on the new tables (see 20261016100000_erp_foundation).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
