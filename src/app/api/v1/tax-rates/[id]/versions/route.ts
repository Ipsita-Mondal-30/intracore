import { api } from "@/lib/api/http";
import { addTaxRateVersion } from "@/features/finance/setup";

/** { rate, effectiveFrom: "yyyy-mm-dd" } */
export const POST = api<{ id: string }>((ctx, { params, body }) => addTaxRateVersion(ctx, params.id, body), { status: 201, idempotent: true });
