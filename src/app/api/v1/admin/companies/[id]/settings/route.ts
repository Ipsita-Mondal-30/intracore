import { api } from "@/lib/api/http";
import { getCompanySettings, updateCompanySettings } from "@/features/admin/settings";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getCompanySettings(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateCompanySettings(ctx, params.id, body));
