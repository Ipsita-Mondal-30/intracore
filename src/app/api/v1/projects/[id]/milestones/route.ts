import { api } from "@/lib/api/http";
import { createMilestone } from "@/features/projects/projects";

export const POST = api<{ id: string }>((ctx, { params, body }) => createMilestone(ctx, params.id, body), { status: 201, idempotent: true });
