import { AppError } from "@/lib/errors";
import { portalApi } from "@/features/portal/http";
import { punch } from "@/features/portal/employee";

/** POST check-in | check-out */
export const POST = portalApi<{ action: string }>("EMPLOYEE", (p, { params }) => {
  if (params.action === "check-in") return punch(p, "in");
  if (params.action === "check-out") return punch(p, "out");
  throw new AppError("NOT_FOUND", "Unknown action", 404);
});
