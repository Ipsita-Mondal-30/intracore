import { api } from "@/lib/api/http";
import { listIntegrations } from "@/features/integrations/service";

export const GET = api((ctx) => listIntegrations(ctx));
