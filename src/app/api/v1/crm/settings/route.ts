import { api } from "@/lib/api/http";
import { getCrmSettings, updateCrmSettings } from "@/features/customers/service";

export const GET = api((ctx) => getCrmSettings(ctx));
export const PUT = api((ctx, { body }) => updateCrmSettings(ctx, body));
