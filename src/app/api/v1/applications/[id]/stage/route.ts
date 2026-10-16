import { api } from "@/lib/api/http";
import { moveApplication } from "@/features/hr/recruitment";

/** POST /applications/:id/stage { stage, reason?, hiredEmployeeId? } */
export const POST = api<{ id: string }>((ctx, { params, body }) => moveApplication(ctx, params.id, body), { idempotent: true });
