import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { PROJECT_TRANSITIONS, removeProjectMember, setProjectMember, transitionProject } from "@/features/projects/projects";
import { projectReport } from "@/features/projects/reports";

type P = { id: string; action: string };

/** GET /projects/:id/report */
export const GET = api<P>((ctx, { params }) => {
  if (params.action === "report") return projectReport(ctx, params.id);
  throw new AppError("NOT_FOUND", "Unknown project resource", 404);
});

/** POST /projects/:id/{activate|hold|complete|cancel|reopen|members|remove-member} */
export const POST = api<P>(
  (ctx, { params, body }) => {
    if (PROJECT_TRANSITIONS.includes(params.action)) return transitionProject(ctx, params.id, params.action);
    if (params.action === "members") return setProjectMember(ctx, params.id, body);
    if (params.action === "remove-member") return removeProjectMember(ctx, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown project action", 404);
  },
  { idempotent: true },
);
