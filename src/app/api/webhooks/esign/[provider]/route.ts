import { NextResponse } from "next/server";
import { handleESignWebhook } from "@/features/documents/esign";
import { sanitizeError } from "@/lib/sanitize";

/**
 * E-signature provider callbacks. The raw body is HMAC-verified with the org's
 * integration secret before anything is applied; unknown provider, unknown envelope and
 * bad signature all get the same 401. A redelivered event id answers 200 without reprocessing.
 */
export async function POST(request: Request, route: { params: Promise<{ provider: string }> }) {
  const { provider } = await route.params;
  try {
    const rawBody = await request.text();
    const result = await handleESignWebhook(provider, rawBody, request.headers);
    if (!result) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    console.error(`[esign webhook] ${provider}: ${sanitizeError(error)}`);
    // 500 so the provider retries; the stored event is FAILED and will be reprocessed.
    return NextResponse.json({ ok: false, error: "Webhook failed" }, { status: 500 });
  }
}
