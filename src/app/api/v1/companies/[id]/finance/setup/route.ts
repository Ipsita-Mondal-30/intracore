import { api } from "@/lib/api/http";
import { setupFinance } from "@/features/finance/setup";

/** { accountingStartDate: "yyyy-mm-dd", fiscalYearStartMonth?: 4, seedChartOfAccounts?: true } */
export const POST = api<{ id: string }>((ctx, { params, body }) => setupFinance(ctx, params.id, body), { idempotent: true });
