import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { CONTRACT_ACTIONS, createRenewalQuotation, transitionContract, type ContractAction } from "@/features/service/contracts";

/** POST /service-contracts/:id/{activate|cancel|expire|renewal-quotation} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!CONTRACT_ACTIONS.includes(params.action)) throw new AppError("NOT_FOUND", "Unknown contract action", 404);
    if (params.action === "renewal-quotation") return createRenewalQuotation(ctx, params.id, body);
    return transitionContract(ctx, params.id, params.action as ContractAction, body);
  },
  { idempotent: true },
);
