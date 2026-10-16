import { api } from "@/lib/api/http";
import { getSignatureRequest } from "@/features/documents/esign";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getSignatureRequest(ctx, params.id));
