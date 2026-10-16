import { api } from "@/lib/api/http";
import { deleteRole, getRole, updateRole } from "@/features/admin/roles";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getRole(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateRole(ctx, params.id, body));
export const DELETE = api<P>((ctx, { params }) => deleteRole(ctx, params.id));
