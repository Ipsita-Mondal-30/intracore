import { MemberStatus } from "@prisma/client";
import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { changeMemberRole, setMemberStatus } from "@/features/admin/users";

type P = { id: string; action: string };
export const POST = api<P>(
  (ctx, { params, body }) => {
    switch (params.action) {
      case "role":
        return changeMemberRole(ctx, params.id, body);
      case "suspend":
        return setMemberStatus(ctx, params.id, MemberStatus.DISABLED);
      case "reactivate":
        return setMemberStatus(ctx, params.id, MemberStatus.ACTIVE);
      default:
        throw new AppError("NOT_FOUND", "Unknown action", 404);
    }
  },
  { idempotent: true },
);
