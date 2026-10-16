import { api } from "@/lib/api/http";
import { getTimeline } from "@/features/customers/service";

export const GET = api<{ id: string }>((ctx, { params }) => getTimeline(ctx, { customerId: params.id }));
