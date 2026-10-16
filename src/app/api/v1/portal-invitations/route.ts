import { api } from "@/lib/api/http";
import { invitePortalUser, listPortalInvitations } from "@/features/portal/admin";

export const GET = api((ctx) => listPortalInvitations(ctx));
/** Returns { invitation, acceptUrl, emailSent }: the accept URL is shown once. */
export const POST = api((ctx, { body }) => invitePortalUser(ctx, body), { status: 201 });
