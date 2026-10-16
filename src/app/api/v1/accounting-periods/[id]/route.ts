import { api } from "@/lib/api/http";
import { setPeriodStatus } from "@/features/finance/setup";

/** { status: "OPEN" | "CLOSED", reason? } — reopening requires a reason. */
export const PATCH = api<{ id: string }>((ctx, { params, body }) => setPeriodStatus(ctx, params.id, body));
