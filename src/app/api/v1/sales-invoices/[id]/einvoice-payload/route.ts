import { api } from "@/lib/api/http";
import { buildEInvoice } from "@/features/finance/einvoice";

/** The e-invoice payload and everything that would make the IRP reject it. */
export const GET = api<{ id: string }>((ctx, { params }) => buildEInvoice(ctx, params.id));
