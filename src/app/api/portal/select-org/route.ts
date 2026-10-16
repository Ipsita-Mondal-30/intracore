import { NextResponse } from "next/server";
import { PORTAL_ORG_COOKIE } from "@/features/portal/context";

/**
 * GET ?organizationId=…&next=/portal/…: remembers the organization for users with portals in
 * several. Selecting an organization grants nothing: every request still needs an active
 * portal account there.
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const org = url.searchParams.get("organizationId") ?? "";
  const next = url.searchParams.get("next") ?? "/portal";
  const target = next.startsWith("/portal") && !next.startsWith("//") ? next : "/portal";
  const res = NextResponse.redirect(new URL(target, url.origin));
  if (/^[A-Za-z0-9_-]{1,64}$/.test(org)) res.cookies.set(PORTAL_ORG_COOKIE, org, { path: "/", httpOnly: true, sameSite: "lax", secure: url.protocol === "https:" });
  return res;
}
