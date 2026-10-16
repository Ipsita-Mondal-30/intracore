import { api } from "@/lib/api/http";
import { getExport } from "@/features/reports/exports";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getExport(ctx, params.id));
