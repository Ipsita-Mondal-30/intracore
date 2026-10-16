import { api } from "@/lib/api/http";
import { getImportJob } from "@/features/admin/imports";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getImportJob(ctx, params.id));
