import { api } from "@/lib/api/http";
import { runSavedReport } from "@/features/reports/saved";

type P = { id: string };
export const POST = api<P>((ctx, { params }) => runSavedReport(ctx, params.id));
