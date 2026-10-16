import { z } from "zod";
import type { CommunicationType } from "@prisma/client";

/**
 * Allowlisted integration providers. Only these keys can be configured through the API.
 * `secrets` are encrypted into Integration.secrets and never returned; `config` is plain,
 * non-secret settings stored in Integration.metadata.
 */
type FieldDef = { key: string; label: string; required?: boolean; hint?: string };
export type ProviderDef = {
  key: string;
  label: string;
  /** null for providers that are not messaging channels (e.g. e-signature) */
  channel: CommunicationType | null;
  /** true: never contacts anything; messages are recorded as simulated */
  mock?: boolean;
  secrets: FieldDef[];
  config: FieldDef[];
};

export const PROVIDERS: Record<string, ProviderDef> = {
  whatsapp_cloud: {
    key: "whatsapp_cloud",
    label: "WhatsApp Business (Cloud API)",
    channel: "WHATSAPP",
    secrets: [
      { key: "accessToken", label: "Access token", required: true, hint: "System-user permanent token with whatsapp_business_messaging" },
      { key: "appSecret", label: "App secret", required: true, hint: "Meta app secret; signs webhook deliveries" },
      { key: "verifyToken", label: "Webhook verify token", required: true, hint: "Any random string; paste the same value in Meta's webhook setup" },
    ],
    config: [
      { key: "phoneNumberId", label: "Phone number ID", required: true },
      { key: "businessAccountId", label: "WhatsApp Business account ID" },
      { key: "apiVersion", label: "Graph API version", hint: "Default v21.0" },
    ],
  },
  email_resend: {
    key: "email_resend",
    label: "Email (Resend)",
    channel: "EMAIL",
    secrets: [{ key: "apiKey", label: "Resend API key", hint: "Leave empty to use the platform key (RESEND_API_KEY)" }],
    config: [{ key: "fromEmail", label: "From address", hint: "Verified sender, e.g. Acme <billing@acme.com>; defaults to RESEND_FROM_EMAIL" }],
  },
  mock_email: { key: "mock_email", label: "Mock email (testing)", channel: "EMAIL", mock: true, secrets: [], config: [] },
  mock_sms: { key: "mock_sms", label: "Mock SMS (testing)", channel: "SMS", mock: true, secrets: [], config: [] },
  mock_whatsapp: { key: "mock_whatsapp", label: "Mock WhatsApp (testing)", channel: "WHATSAPP", mock: true, secrets: [], config: [] },
  esign_mock: {
    key: "esign_mock",
    label: "Mock e-signature (testing, not legally valid)",
    channel: null,
    mock: true,
    secrets: [{ key: "webhookSecret", label: "Webhook secret", required: true }],
    config: [],
  },
};

export function providerDef(key: string): ProviderDef | null {
  return Object.hasOwn(PROVIDERS, key) ? PROVIDERS[key] : null;
}

const value = z.string().trim().max(2000);

/** Zod schema for a provider's fields; `partial` allows omitting required fields (kept from before). */
export function fieldsSchema(fields: FieldDef[], partial = false) {
  return z
    .object(Object.fromEntries(fields.map((f) => [f.key, f.required && !partial ? value.min(1, `${f.label} is required`) : value.optional()])))
    .strict();
}
