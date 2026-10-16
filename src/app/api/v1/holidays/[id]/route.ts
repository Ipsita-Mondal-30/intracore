import { api } from "@/lib/api/http";
import { deleteHoliday } from "@/features/hr/org";

export const DELETE = api<{ id: string }>((ctx, { params }) => deleteHoliday(ctx, params.id));
