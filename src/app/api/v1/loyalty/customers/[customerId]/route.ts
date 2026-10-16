import { api } from "@/lib/api/http";
import { loyaltyBalance } from "@/features/marketing/loyalty";

export const GET = api<{ customerId: string }>((ctx, { params }) => loyaltyBalance(ctx, params.customerId));
