import { api } from "@/lib/api/http";
import { createRole, listRoles } from "@/features/admin/roles";

export const GET = api((ctx) => listRoles(ctx));
export const POST = api((ctx, { body }) => createRole(ctx, body), { status: 201, idempotent: true });
