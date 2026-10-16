import { api } from "@/lib/api/http";
import { addCorrectiveAction, transitionNonConformance, type NcrAction } from "@/features/quality/ncr";

/** POST /nonconformances/:id/{actions|start|close|reopen} — `actions` adds a corrective-action task. */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) =>
    params.action === "actions" ? addCorrectiveAction(ctx, params.id, body) : transitionNonConformance(ctx, params.id, params.action as NcrAction, body),
  { idempotent: true },
);
