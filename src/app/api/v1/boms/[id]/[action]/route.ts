import { api } from "@/lib/api/http";
import { transitionBom, type BomAction } from "@/features/manufacturing/boms";

/** POST /boms/:id/{activate|archive|copy} */
export const POST = api<{ id: string; action: string }>((ctx, { params }) => transitionBom(ctx, params.id, params.action as BomAction), { idempotent: true });
