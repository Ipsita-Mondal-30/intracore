import { api } from "@/lib/api/http";
import { deleteRetentionPolicy, upsertRetentionPolicy } from "@/features/admin/retention";

type P = { target: string };
export const PUT = api<P>((ctx, { params, body }) => upsertRetentionPolicy(ctx, params.target, body), { idempotent: true });
export const DELETE = api<P>((ctx, { params }) => deleteRetentionPolicy(ctx, params.target));
