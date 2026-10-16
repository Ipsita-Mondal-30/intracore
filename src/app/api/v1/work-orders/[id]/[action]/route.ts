import { api } from "@/lib/api/http";
import { issueMaterials, receiveFinishedGoods, transitionWorkOrder, type WorkOrderAction } from "@/features/manufacturing/work-orders";

/** POST /work-orders/:id/{release|reserve|start|complete|cancel|issue|receive} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "issue") return issueMaterials(ctx, params.id, body);
    if (params.action === "receive") return receiveFinishedGoods(ctx, params.id, body);
    return transitionWorkOrder(ctx, params.id, params.action as WorkOrderAction, body);
  },
  { idempotent: true },
);
