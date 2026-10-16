import { api } from "@/lib/api/http";
import { getPreferences, updatePreferences } from "@/features/notifications/history";

export const GET = api((ctx) => getPreferences(ctx));
export const PATCH = api((ctx, { body }) => updatePreferences(ctx, body));
