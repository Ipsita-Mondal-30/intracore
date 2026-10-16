import { api } from "@/lib/api/http";
import { getConsent, updateConsent } from "@/features/communication/consent";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getConsent(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateConsent(ctx, params.id, body));
