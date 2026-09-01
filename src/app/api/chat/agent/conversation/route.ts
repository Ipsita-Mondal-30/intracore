import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/tenant";
import { getConversationDetail } from "@/features/chat/queries";
import { isAppError } from "@/lib/errors";

export async function GET(request: Request) {
  try {
    const tenant = await requirePermission("chat.view");
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    }

    const detail = await getConversationDetail(tenant, id);
    if (!detail) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      lead: detail.conversation.lead,
      messages: detail.messages,
    });
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: "Failed to load" }, { status: 500 });
  }
}
