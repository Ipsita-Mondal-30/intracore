import { api } from "@/lib/api/http";
import { decideApproval, type ApprovalAction } from "@/features/automation/approvals";

type P = { id: string; action: string };

/** POST /approvals/:id/{approve|reject} — reject needs { comment } */
export const POST = api<P>((ctx, { params, body }) => decideApproval(ctx, params.id, params.action as ApprovalAction, body), { idempotent: true });
