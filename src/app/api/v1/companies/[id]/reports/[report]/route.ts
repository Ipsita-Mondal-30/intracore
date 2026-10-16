import { api, queryObject } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import type { AccessContext } from "@/lib/access";
import {
  balanceSheet,
  financeReconciliation,
  generalLedger,
  payablesAging,
  profitAndLoss,
  receivablesAging,
  trialBalance,
} from "@/features/finance/reports";
import { gstr1, gstr3b } from "@/features/finance/gst-reports";

const REPORTS: Record<string, (ctx: AccessContext, companyId: string, query: unknown) => Promise<unknown>> = {
  "trial-balance": trialBalance,
  "general-ledger": generalLedger,
  "profit-and-loss": profitAndLoss,
  "balance-sheet": balanceSheet,
  "receivables-aging": receivablesAging,
  "payables-aging": payablesAging,
  reconciliation: (ctx, companyId) => financeReconciliation(ctx, companyId),
  gstr1,
  gstr3b,
};

/** GET /companies/:id/reports/{trial-balance|general-ledger|profit-and-loss|balance-sheet|receivables-aging|payables-aging|reconciliation|gstr1|gstr3b} */
export const GET = api<{ id: string; report: string }>((ctx, { params, query }) => {
  const report = REPORTS[params.report];
  if (!report) throw new AppError("NOT_FOUND", "Unknown report", 404);
  return report(ctx, params.id, queryObject(query));
});
