import { ProviderError, providerFetch, type MessageProvider, type ProviderSettings } from "./types";

/**
 * Email through Resend's REST API with the org integration's API key. Without one, the
 * platform key and sender from the environment (RESEND_API_KEY / RESEND_FROM_EMAIL) are used.
 * The log id is sent as Resend's Idempotency-Key, so a retry after a crash never sends twice.
 */
function credentials(s: ProviderSettings) {
  const apiKey = s.secrets.apiKey || process.env.RESEND_API_KEY?.trim();
  const from = s.config.fromEmail || process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from) throw new ProviderError("Resend API key or from address not configured", true, "NOT_CONFIGURED");
  return { apiKey, from };
}
const resendError = (json: unknown) => (json as { message?: string } | null)?.message;

export const resendEmailProvider: MessageProvider = {
  key: "email_resend",
  channel: "EMAIL",
  simulated: false,
  async send(message, settings) {
    const { apiKey, from } = credentials(settings);
    const json = await providerFetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": message.id },
        body: JSON.stringify({ from, to: [message.to], subject: message.subject ?? "(no subject)", text: message.body }),
      },
      resendError,
    );
    const id = (json as { id?: string } | null)?.id;
    if (!id) throw new ProviderError("Resend response had no message id", false, "BAD_RESPONSE");
    return { providerMessageId: id };
  },
  async healthCheck(settings) {
    const { apiKey } = credentials(settings);
    await providerFetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${apiKey}` } }, resendError);
  },
};
