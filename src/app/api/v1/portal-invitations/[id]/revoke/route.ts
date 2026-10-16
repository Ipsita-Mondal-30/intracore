import { api } from "@/lib/api/http";
import { revokePortalInvitation } from "@/features/portal/admin";

export const POST = api<{ id: string }>((ctx, { params }) => revokePortalInvitation(ctx, params.id));
