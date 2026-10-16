import { api } from "@/lib/api/http";
import { createFiscalYear, listFiscalYears } from "@/features/finance/setup";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => listFiscalYears(ctx, params.id));
/** { containingDate: "yyyy-mm-dd" } */
export const POST = api<P>((ctx, { params, body }) => createFiscalYear(ctx, params.id, body), { status: 201, idempotent: true });
