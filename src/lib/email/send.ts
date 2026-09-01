import { getFromEmail, getResendClient, isEmailConfigured } from "./client";

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

export type SendEmailResult =
  | { ok: true; id?: string }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; error: string };

export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason: "RESEND_API_KEY or RESEND_FROM_EMAIL not configured",
    };
  }

  const resend = getResendClient();
  const from = getFromEmail();
  if (!resend || !from) {
    return {
      ok: false,
      skipped: true,
      reason: "RESEND_API_KEY or RESEND_FROM_EMAIL not configured",
    };
  }

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo,
    });

    if (error) {
      console.error("[email] Resend error:", error);
      return { ok: false, skipped: false, error: error.message };
    }

    return { ok: true, id: data?.id };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to send email";
    console.error("[email] send failed:", error);
    return { ok: false, skipped: false, error: message };
  }
}
