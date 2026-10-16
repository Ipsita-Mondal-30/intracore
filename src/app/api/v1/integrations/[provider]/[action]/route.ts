import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { checkIntegration, setIntegrationEnabled } from "@/features/integrations/service";

type P = { provider: string; action: string };

/** POST /integrations/:provider/{connect|disconnect|check} */
export const POST = api<P>((ctx, { params }) => {
  if (params.action === "connect") return setIntegrationEnabled(ctx, params.provider, true);
  if (params.action === "disconnect") return setIntegrationEnabled(ctx, params.provider, false);
  if (params.action === "check") return checkIntegration(ctx, params.provider);
  throw new AppError("NOT_FOUND", "Unknown integration action", 404);
});
