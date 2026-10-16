import { api } from "@/lib/api/http";
import { getInspectionTemplate, updateInspectionTemplate } from "@/features/quality/inspections";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getInspectionTemplate(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateInspectionTemplate(ctx, params.id, body));
