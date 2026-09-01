-- CreateEnum
CREATE TYPE "MessageSender" AS ENUM ('USER', 'LEAD', 'SYSTEM');
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'FILE', 'SYSTEM');
CREATE TYPE "MessageStatus" AS ENUM ('SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "guestTokenHash" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_participants" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "lastReadAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderType" "MessageSender" NOT NULL,
    "senderUserId" UUID,
    "content" TEXT,
    "messageType" "MessageType" NOT NULL DEFAULT 'TEXT',
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "message_attachments" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_notification_preferences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "chatMessages" BOOLEAN NOT NULL DEFAULT true,
    "leadAssignments" BOOLEAN NOT NULL DEFAULT true,
    "followUpReminders" BOOLEAN NOT NULL DEFAULT true,
    "taskNotifications" BOOLEAN NOT NULL DEFAULT true,
    "systemNotifications" BOOLEAN NOT NULL DEFAULT true,
    "browserNotifications" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "conversations_guestTokenHash_key" ON "conversations"("guestTokenHash");
CREATE UNIQUE INDEX "conversations_organizationId_leadId_key" ON "conversations"("organizationId", "leadId");
CREATE INDEX "conversations_organizationId_lastMessageAt_idx" ON "conversations"("organizationId", "lastMessageAt");
CREATE INDEX "conversations_leadId_idx" ON "conversations"("leadId");

CREATE UNIQUE INDEX "conversation_participants_conversationId_userId_key" ON "conversation_participants"("conversationId", "userId");
CREATE INDEX "conversation_participants_userId_idx" ON "conversation_participants"("userId");

CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");
CREATE INDEX "message_attachments_messageId_idx" ON "message_attachments"("messageId");

CREATE UNIQUE INDEX "user_notification_preferences_organizationId_userId_key" ON "user_notification_preferences"("organizationId", "userId");

-- Foreign keys
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (defense in depth for Realtime SELECT subscriptions)
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversations_org_member_select" ON "conversations"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "organization_members" om
      WHERE om."organizationId" = "conversations"."organizationId"
        AND om."userId" = auth.uid()
        AND om.status = 'ACTIVE'
    )
  );

CREATE POLICY "conversation_participants_org_member_select" ON "conversation_participants"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "conversations" c
      JOIN "organization_members" om ON om."organizationId" = c."organizationId"
      WHERE c.id = "conversation_participants"."conversationId"
        AND om."userId" = auth.uid()
        AND om.status = 'ACTIVE'
    )
  );

CREATE POLICY "messages_org_member_select" ON "messages"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "conversations" c
      JOIN "organization_members" om ON om."organizationId" = c."organizationId"
      WHERE c.id = "messages"."conversationId"
        AND om."userId" = auth.uid()
        AND om.status = 'ACTIVE'
    )
  );

CREATE POLICY "message_attachments_org_member_select" ON "message_attachments"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "messages" m
      JOIN "conversations" c ON c.id = m."conversationId"
      JOIN "organization_members" om ON om."organizationId" = c."organizationId"
      WHERE m.id = "message_attachments"."messageId"
        AND om."userId" = auth.uid()
        AND om.status = 'ACTIVE'
    )
  );

-- Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE "messages";
ALTER PUBLICATION supabase_realtime ADD TABLE "conversations";
ALTER PUBLICATION supabase_realtime ADD TABLE "notifications";
