import { api } from "@/lib/api/http";
import { deleteSavedReport, getSavedReport, updateSavedReport } from "@/features/reports/saved";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getSavedReport(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateSavedReport(ctx, params.id, body));
export const DELETE = api<P>((ctx, { params }) => deleteSavedReport(ctx, params.id));
