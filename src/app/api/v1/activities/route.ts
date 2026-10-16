import { api } from "@/lib/api/http";
import { logActivity } from "@/features/customers/service";

export const POST = api((ctx, { body }) => logActivity(ctx, body), { status: 201, idempotent: true });
