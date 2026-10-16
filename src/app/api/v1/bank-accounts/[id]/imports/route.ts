import { api } from "@/lib/api/http";
import { importBankStatement } from "@/features/finance/bank";

/** Manual statement import: { fileName, csv, columns: { date, description, amount | debit+credit, reference? }, dateFormat? } */
export const POST = api<{ id: string }>((ctx, { params, body }) => importBankStatement(ctx, params.id, body), { status: 201, idempotent: true });
