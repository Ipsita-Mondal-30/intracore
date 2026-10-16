import { ProviderError, providerFetch, type MessageProvider, type ProviderSettings } from "./types";

/**
 * WhatsApp Business Cloud API. Business-initiated messages must use an approved template:
 * body parameters are sent in the template's declared variable order ({{1}}, {{2}} … on Meta's side).
 * The access token travels only in the Authorization header; errors are sanitized by the caller.
 */
const DEFAULT_VERSION = "v21.0";
const base = (s: ProviderSettings) => `https://graph.facebook.com/${s.config.apiVersion || DEFAULT_VERSION}`;
const metaError = (json: unknown) => {
  const e = (json as { error?: { message?: string; code?: number } } | null)?.error;
  return e ? `${e.code ?? ""} ${e.message ?? ""}`.trim() : undefined;
};
const headers = (s: ProviderSettings) => ({ authorization: `Bearer ${s.secrets.accessToken}`, "content-type": "application/json" });

function requireSettings(s: ProviderSettings) {
  if (!s.secrets.accessToken || !s.config.phoneNumberId) throw new ProviderError("WhatsApp integration is missing the access token or phone number ID", true, "NOT_CONFIGURED");
}

export const whatsappCloudProvider: MessageProvider = {
  key: "whatsapp_cloud",
  channel: "WHATSAPP",
  simulated: false,
  async send(message, settings) {
    requireSettings(settings);
    const t = message.template;
    if (!t?.providerTemplateName) throw new ProviderError("WhatsApp messages need a template with a provider template name", true, "TEMPLATE_NOT_APPROVED");
    const parameters = t.variables.map((name) => {
      const text = message.variables[name];
      if (!text) throw new ProviderError(`Missing value for template variable ${name}`, true, "TEMPLATE_VARIABLES");
      return { type: "text", text };
    });
    const json = await providerFetch(
      `${base(settings)}/${encodeURIComponent(settings.config.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: headers(settings),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: message.to,
          type: "template",
          template: {
            name: t.providerTemplateName,
            language: { code: t.language },
            components: parameters.length ? [{ type: "body", parameters }] : [],
          },
        }),
      },
      metaError,
    );
    const id = (json as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id;
    if (!id) throw new ProviderError("WhatsApp response had no message id", false, "BAD_RESPONSE");
    return { providerMessageId: id };
  },
  async healthCheck(settings) {
    requireSettings(settings);
    await providerFetch(`${base(settings)}/${encodeURIComponent(settings.config.phoneNumberId)}?fields=id`, { headers: headers(settings) }, metaError);
  },
};
