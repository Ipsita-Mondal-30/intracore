import { api } from "@/lib/api/http";
import { getOrgSettings, updateOrgSettings } from "@/features/admin/settings";

export const GET = api((ctx) => getOrgSettings(ctx));
export const PATCH = api((ctx, { body }) => updateOrgSettings(ctx, body));
