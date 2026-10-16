import { api } from "@/lib/api/http";
import { getTemplate, updateTemplate } from "@/features/communication/templates";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getTemplate(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateTemplate(ctx, params.id, body));
