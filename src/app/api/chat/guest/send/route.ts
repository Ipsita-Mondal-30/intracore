import { NextResponse } from "next/server";
import { getConversationByGuestToken } from "@/lib/chat/conversations";
import { sendLeadMessage } from "@/lib/chat/messages";

const rateLimit = new Map<string, { count: number; resetAt: number }>();
const MAX_PER_MINUTE = 20;

function checkRateLimit(key: string) {
  const now = Date.now();
  const entry = rateLimit.get(key);
  if (!entry || entry.resetAt < now) {
    rateLimit.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= MAX_PER_MINUTE) return false;
  entry.count += 1;
  return true;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      token?: string;
      content?: string;
      honeypot?: string;
    };

    if (body.honeypot) {
      return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
    }

    const token = body.token?.trim();
    const content = body.content?.trim() ?? "";

    if (!token || !content) {
      return NextResponse.json(
        { ok: false, error: "Token and content are required" },
        { status: 400 },
      );
    }

    if (content.length > 4000) {
      return NextResponse.json(
        { ok: false, error: "Message too long" },
        { status: 400 },
      );
    }

    if (!checkRateLimit(token)) {
      return NextResponse.json({ ok: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const conversation = await getConversationByGuestToken(token);
    if (!conversation) {
      return NextResponse.json({ ok: false, error: "Invalid chat link" }, { status: 404 });
    }

    const message = await sendLeadMessage(conversation.id, content);
    return NextResponse.json({ ok: true, message });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to send message",
      },
      { status: 500 },
    );
  }
}
