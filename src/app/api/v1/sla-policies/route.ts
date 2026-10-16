import { api } from "@/lib/api/http";
import { createSlaPolicy, listSlaPolicies } from "@/features/service/sla";

export const GET = api((ctx) => listSlaPolicies(ctx));
export const POST = api((ctx, { body }) => createSlaPolicy(ctx, body), { status: 201, idempotent: true });
