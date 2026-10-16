import { api, queryObject } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { adjustPoints, loyaltyStatement, redeemPoints } from "@/features/marketing/loyalty";

type P = { customerId: string; action: string };

/** GET /loyalty/customers/:customerId/statement */
export const GET = api<P>((ctx, { params, query }) => {
  if (params.action === "statement") return loyaltyStatement(ctx, params.customerId, queryObject(query));
  throw new AppError("NOT_FOUND", "Unknown loyalty resource", 404);
});

/** POST /loyalty/customers/:customerId/{redeem|adjust} */
export const POST = api<P>(
  (ctx, { params, body }) => {
    if (params.action === "redeem") return redeemPoints(ctx, params.customerId, body);
    if (params.action === "adjust") return adjustPoints(ctx, params.customerId, body);
    throw new AppError("NOT_FOUND", "Unknown loyalty action", 404);
  },
  { idempotent: true },
);
