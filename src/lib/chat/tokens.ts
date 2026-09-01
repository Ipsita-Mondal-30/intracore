import { createHash, randomBytes } from "crypto";

export function generateGuestToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashGuestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyGuestToken(token: string, hash: string): boolean {
  return hashGuestToken(token) === hash;
}

export function guestChatUrl(token: string): string {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  return `${siteUrl}/chat/${token}`;
}
