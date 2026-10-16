import { api } from "@/lib/api/http";
import { getApproval } from "@/features/automation/approvals";

export const GET = api<{ id: string }>((ctx, { params }) => getApproval(ctx, params.id));
