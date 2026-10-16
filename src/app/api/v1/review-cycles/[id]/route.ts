import { api } from "@/lib/api/http";
import { getReviewCycle } from "@/features/hr/performance";

export const GET = api<{ id: string }>((ctx, { params }) => getReviewCycle(ctx, params.id));
