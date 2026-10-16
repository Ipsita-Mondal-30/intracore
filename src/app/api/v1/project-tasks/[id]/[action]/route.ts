import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { addTaskComment, setTaskStatus } from "@/features/projects/tasks";

/** POST /project-tasks/:id/{status|comments} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "status") return setTaskStatus(ctx, params.id, body);
    if (params.action === "comments") return addTaskComment(ctx, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown task action", 404);
  },
  { idempotent: true },
);
