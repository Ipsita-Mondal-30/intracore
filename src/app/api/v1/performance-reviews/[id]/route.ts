import { api } from "@/lib/api/http";
import { getPerformanceReview } from "@/features/hr/performance";

export const GET = api<{ id: string }>((ctx, { params }) => getPerformanceReview(ctx, params.id));
