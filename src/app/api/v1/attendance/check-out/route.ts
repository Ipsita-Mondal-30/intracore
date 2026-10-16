import { api } from "@/lib/api/http";
import { punch } from "@/features/hr/attendance";

export const POST = api((ctx) => punch(ctx, "out"), { idempotent: true });
