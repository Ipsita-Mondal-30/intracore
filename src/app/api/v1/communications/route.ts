import { api, queryObject } from "@/lib/api/http";
import { listMessages, sendMessage } from "@/features/communication/messages";

export const GET = api((ctx, { query }) => listMessages(ctx, queryObject(query)));
/** Requires an Idempotency-Key header. */
export const POST = api((ctx, { req, body }) => sendMessage(ctx, body, req.headers.get("idempotency-key")), { status: 202, idempotent: true });
