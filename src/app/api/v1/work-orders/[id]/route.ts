import { api } from "@/lib/api/http";
import { getWorkOrder } from "@/features/manufacturing/work-orders";

export const GET = api<{ id: string }>((ctx, { params }) => getWorkOrder(ctx, params.id));
