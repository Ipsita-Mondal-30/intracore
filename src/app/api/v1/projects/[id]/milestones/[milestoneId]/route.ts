import { api } from "@/lib/api/http";
import { updateMilestone } from "@/features/projects/projects";

export const PATCH = api<{ id: string; milestoneId: string }>((ctx, { params, body }) => updateMilestone(ctx, params.id, params.milestoneId, body));
