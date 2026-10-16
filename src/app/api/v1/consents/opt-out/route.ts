import { api } from "@/lib/api/http";
import { optOut } from "@/features/communication/consent";

export const POST = api((ctx, { body }) => optOut(ctx, body), { idempotent: true });
