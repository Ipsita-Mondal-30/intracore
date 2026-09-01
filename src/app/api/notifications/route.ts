import { NextResponse } from "next/server";
import { requireOrganizationAccess } from "@/lib/tenant";
import { getLayoutNotificationData } from "@/lib/notifications/queries";
import { isAppError } from "@/lib/errors";

export async function GET() {
  try {
    const tenant = await requireOrganizationAccess();
    const data = await getLayoutNotificationData(tenant);
    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: "Failed to load notifications" }, { status: 500 });
  }
}
