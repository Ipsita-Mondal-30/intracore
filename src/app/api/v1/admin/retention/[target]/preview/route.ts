import { api, queryObject } from "@/lib/api/http";
import { previewRetention } from "@/features/admin/retention";

type P = { target: string };
export const GET = api<P>((ctx, { params, query }) => previewRetention(ctx, params.target, queryObject(query)));
