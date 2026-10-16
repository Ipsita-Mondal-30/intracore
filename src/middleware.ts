import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const publicPaths = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/accept-invite",
  "/auth/callback",
  "/auth/session-error",
  "/setup",
  "/chat",
];

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
      },
    },
  });

  try {
    // Verifies the JWT locally against the cached JWKS (refreshing an expired session) instead
    // of calling the Auth server on every request.
    const { data } = await supabase.auth.getClaims();
    const user = data?.claims?.sub ? data.claims : null;

    const { pathname } = request.nextUrl;
    const isPublic =
      publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
      pathname.startsWith("/api/") ||
      pathname === "/";

    if (!user && !isPublic) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      redirectUrl.search = "";
      redirectUrl.searchParams.set("callbackUrl", `${pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(redirectUrl);
    }
  } catch {
    // Allow public routes through if auth refresh fails.
    const { pathname } = request.nextUrl;
    const isPublic =
      publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
      pathname.startsWith("/api/") ||
      pathname === "/";
    if (!isPublic) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      return NextResponse.redirect(redirectUrl);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
