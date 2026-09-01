import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

export async function logLeadEmail(input: {
  organizationId: string;
  leadId: string;
  userId?: string | null;
  subject: string;
  bodyPreview: string;
  externalId?: string | null;
  recipientEmail: string;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.leadCommunication.create({
    data: {
      organizationId: input.organizationId,
      leadId: input.leadId,
      userId: input.userId ?? null,
      type: "EMAIL",
      direction: "OUTBOUND",
      subject: input.subject,
      bodyPreview: input.bodyPreview.slice(0, 500),
      externalId: input.externalId ?? null,
      metadata: {
        recipientEmail: input.recipientEmail,
        ...(input.metadata && typeof input.metadata === "object"
          ? input.metadata
          : {}),
      },
    },
  });
}

export async function findReminderForFollowUp(
  organizationId: string,
  followUpId: string,
  bucket: string,
) {
  const rows = await prisma.leadCommunication.findMany({
    where: {
      organizationId,
      type: "EMAIL",
    },
    take: 500,
    orderBy: { occurredAt: "desc" },
  });

  return rows.find((row) => {
    if (!row.metadata || typeof row.metadata !== "object") return false;
    const meta = row.metadata as Record<string, unknown>;
    return meta.followUpId === followUpId && meta.bucket === bucket;
  });
}
