import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { INSTALLATION_ACTIONS, transitionInstallationJob, type InstallationAction } from "@/features/service/installations";

/** POST /installation-jobs/:id/{start|complete|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!INSTALLATION_ACTIONS.includes(params.action as InstallationAction)) throw new AppError("NOT_FOUND", "Unknown installation action", 404);
    return transitionInstallationJob(ctx, params.id, params.action as InstallationAction, body);
  },
  { idempotent: true },
);
