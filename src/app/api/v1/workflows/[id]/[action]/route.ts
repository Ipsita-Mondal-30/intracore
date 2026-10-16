import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { testWorkflow } from "@/features/automation/workflows";

type P = { id: string; action: string };

/** POST /workflows/:id/test — dry run against a sample snapshot; executes nothing. */
export const POST = api<P>((ctx, { params, body }) => {
  if (params.action === "test") return testWorkflow(ctx, params.id, body);
  throw new AppError("NOT_FOUND", "Unknown workflow action", 404);
});
