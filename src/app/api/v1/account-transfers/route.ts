import { api } from "@/lib/api/http";
import { createTransfer } from "@/features/finance/bank";

export const POST = api((ctx, { body }) => createTransfer(ctx, body), { status: 201, idempotent: true });
