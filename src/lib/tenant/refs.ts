import { MemberStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";

const invalid = (what: string) =>
  new AppError("INVALID_REFERENCE", `${what} does not belong to this organization`, 422);

export async function assertActiveMember(organizationId: string, userId: string) {
  const member = await prisma.organizationMember.findFirst({
    where: { organizationId, userId, status: MemberStatus.ACTIVE },
    select: { id: true },
  });
  if (!member) throw invalid("Assignee");
}

/**
 * Client-supplied ids on a lead must all belong to the caller's organization
 * (and a stage to the chosen pipeline). Missing values are skipped.
 */
export async function assertLeadRefs(
  organizationId: string,
  refs: {
    sourceId?: string | null;
    pipelineId?: string | null;
    stageId?: string | null;
    assignedUserId?: string | null;
    assignedTeamId?: string | null;
  },
) {
  const [source, pipeline, stage, team] = await Promise.all([
    refs.sourceId ? prisma.leadSource.findFirst({ where: { id: refs.sourceId, organizationId }, select: { id: true } }) : true,
    refs.pipelineId ? prisma.pipeline.findFirst({ where: { id: refs.pipelineId, organizationId }, select: { id: true } }) : true,
    refs.stageId ? prisma.leadStage.findFirst({ where: { id: refs.stageId, organizationId }, select: { pipelineId: true } }) : true,
    refs.assignedTeamId ? prisma.team.findFirst({ where: { id: refs.assignedTeamId, organizationId }, select: { id: true } }) : true,
  ]);
  if (!source) throw invalid("Lead source");
  if (!pipeline) throw invalid("Pipeline");
  if (!stage) throw invalid("Stage");
  if (!team) throw invalid("Team");
  if (refs.stageId && refs.pipelineId && stage !== true && stage.pipelineId !== refs.pipelineId) {
    throw new AppError("INVALID_REFERENCE", "Stage does not belong to the selected pipeline", 422);
  }
  if (refs.assignedUserId) await assertActiveMember(organizationId, refs.assignedUserId);
}
