import { api } from "@/lib/api/http";
import { allocateLeave } from "@/features/hr/leave";

export const POST = api((ctx, { body }) => allocateLeave(ctx, body), { idempotent: true });
