import type { MessageProvider } from "./types";
import { mockProvider } from "./mock";
import { whatsappCloudProvider } from "./whatsapp-cloud";
import { resendEmailProvider } from "./resend-email";

/** Implementations by integration provider key (see features/integrations/registry.ts). SMS: mock only. */
const IMPLEMENTATIONS: Record<string, MessageProvider> = {
  whatsapp_cloud: whatsappCloudProvider,
  email_resend: resendEmailProvider,
  mock_email: mockProvider("mock_email", "EMAIL"),
  mock_sms: mockProvider("mock_sms", "SMS"),
  mock_whatsapp: mockProvider("mock_whatsapp", "WHATSAPP"),
};

export function getProvider(key: string): MessageProvider | null {
  return Object.hasOwn(IMPLEMENTATIONS, key) ? IMPLEMENTATIONS[key] : null;
}

export { ProviderError, type MessageProvider, type OutboundMessage, type ProviderSettings } from "./types";
