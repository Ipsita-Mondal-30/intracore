import { api } from "@/lib/api/http";
import { getExportDownload } from "@/features/reports/exports";

type P = { id: string };
/** Short-lived signed URL (60 s) for the requester's own completed export. */
export const GET = api<P>((ctx, { params }) => getExportDownload(ctx, params.id));
