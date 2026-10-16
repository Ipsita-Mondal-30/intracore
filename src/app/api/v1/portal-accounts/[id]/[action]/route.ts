import { api } from "@/lib/api/http";
import { setPortalAccountStatus } from "@/features/portal/admin";

/** POST suspend | reactivate */
export const POST = api<{ id: string; action: string }>((ctx, { params }) => setPortalAccountStatus(ctx, params.id, params.action));
