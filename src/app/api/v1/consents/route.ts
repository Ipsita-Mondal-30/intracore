import { api, queryObject } from "@/lib/api/http";
import { listConsents, recordConsent } from "@/features/communication/consent";

export const GET = api((ctx, { query }) => listConsents(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => recordConsent(ctx, body), { idempotent: true });
