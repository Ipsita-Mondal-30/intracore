import { api } from "@/lib/api/http";
import { listMemberScopes, setMemberScopes } from "@/features/companies/service";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => listMemberScopes(ctx, params.id));
export const PUT = api<P>((ctx, { params, body }) => setMemberScopes(ctx, params.id, body), { idempotent: true });
