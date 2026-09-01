import { describe, expect, it } from "vitest";
import { hashGuestToken, verifyGuestToken } from "@/lib/chat/tokens";
import { computeUnreadCount } from "@/lib/chat/unread";

describe("guest token hashing", () => {
  it("verifies valid tokens", () => {
    const token = "test-token-abc";
    const hash = hashGuestToken(token);
    expect(verifyGuestToken(token, hash)).toBe(true);
    expect(verifyGuestToken("wrong", hash)).toBe(false);
  });
});

describe("unread count", () => {
  it("counts messages after lastReadAt from others", () => {
    const lastRead = new Date("2026-08-22T10:00:00Z");
    const count = computeUnreadCount(
      [
        {
          createdAt: new Date("2026-08-22T09:00:00Z"),
          senderType: "LEAD",
          senderUserId: null,
        },
        {
          createdAt: new Date("2026-08-22T11:00:00Z"),
          senderType: "LEAD",
          senderUserId: null,
        },
        {
          createdAt: new Date("2026-08-22T11:30:00Z"),
          senderType: "USER",
          senderUserId: "user-1",
        },
        {
          createdAt: new Date("2026-08-22T12:00:00Z"),
          senderType: "USER",
          senderUserId: "user-2",
        },
      ],
      lastRead,
      "user-1",
    );
    expect(count).toBe(2);
  });
});

describe("chat permissions catalog", () => {
  it("includes chat.view and chat.send", async () => {
    const { PERMISSIONS } = await import("@/lib/permissions/catalog");
    const codes = PERMISSIONS.map((p) => p.code);
    expect(codes).toContain("chat.view");
    expect(codes).toContain("chat.send");
    expect(codes).toContain("chat.manage");
  });
});
