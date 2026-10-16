import { api } from "@/lib/api/http";
import { markNotificationRead } from "@/features/notifications/history";

type P = { id: string };
export const POST = api<P>((ctx, { params }) => markNotificationRead(ctx, params.id));
