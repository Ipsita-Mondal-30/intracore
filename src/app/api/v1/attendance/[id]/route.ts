import { api } from "@/lib/api/http";
import { getAttendance } from "@/features/hr/attendance";

export const GET = api<{ id: string }>((ctx, { params }) => getAttendance(ctx, params.id));
