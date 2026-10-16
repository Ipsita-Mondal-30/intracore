import { api } from "@/lib/api/http";
import { getMessage } from "@/features/communication/messages";

export const GET = api<{ id: string }>((ctx, { params }) => getMessage(ctx, params.id));
