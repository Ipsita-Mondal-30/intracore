import { api } from "@/lib/api/http";
import { configureIntegration, getIntegration } from "@/features/integrations/service";

type P = { provider: string };
export const GET = api<P>((ctx, { params }) => getIntegration(ctx, params.provider));
/** Body: { config: {...}, secrets: {...} }. Secrets are write-only; blank ones keep the stored value. */
export const PUT = api<P>((ctx, { params, body }) => configureIntegration(ctx, params.provider, body));
