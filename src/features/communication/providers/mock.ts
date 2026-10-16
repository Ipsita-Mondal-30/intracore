import { randomUUID } from "crypto";
import type { CommunicationType } from "@prisma/client";
import type { MessageProvider } from "./types";

/** Never contacts anything. Logs are marked simulated and stop at SENT (never DELIVERED). */
export const mockProvider = (key: string, channel: CommunicationType): MessageProvider => ({
  key,
  channel,
  simulated: true,
  async send() {
    return { providerMessageId: `mock_${randomUUID()}` };
  },
  async healthCheck() {},
});
