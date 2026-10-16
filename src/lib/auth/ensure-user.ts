import { prisma } from "@/lib/db/prisma";
import type { AuthUser } from "@/lib/auth/supabase-user";
import { invalidateUser, sharedCache, userTag, ACCESS_TTL } from "@/lib/cache/request-cache";

const profile = (authUser: AuthUser) => {
  const email = authUser.email?.toLowerCase();
  if (!email) throw new Error("Authenticated user has no email");
  const name =
    (typeof authUser.user_metadata?.name === "string" ? authUser.user_metadata.name : null) ||
    authUser.email?.split("@")[0] ||
    null;
  const image = typeof authUser.user_metadata?.avatar_url === "string" ? authUser.user_metadata.avatar_url : null;
  // Only known at sign-in (full user object); per-request JWT claims don't carry it.
  const emailVerified = authUser.email_confirmed_at ? new Date(authUser.email_confirmed_at) : undefined;
  return { email, name, image, emailVerified };
};

/** Map Supabase auth.users.id onto Prisma User.id (UUID). Read first; write only when needed. */
export async function ensurePrismaUser(authUser: AuthUser) {
  const { email, name, image, emailVerified } = profile(authUser);
  const existing = await prisma.user.findUnique({ where: { id: authUser.id } });
  if (existing && existing.email === email && existing.name === name && existing.image === image) {
    return existing;
  }
  const user = await prisma.user.upsert({
    where: { id: authUser.id },
    create: { id: authUser.id, email, name, image, emailVerified: emailVerified ?? null },
    update: { email, name: name ?? undefined, image: image ?? undefined, emailVerified },
  });
  invalidateUser(authUser.id);
  return user;
}

export type SessionUser = { id: string; email: string | null; name: string | null; activeOrganizationId: string | null };

/**
 * Per-request variant: the user row is served from the shared cache (tag `user:<id>`), so a
 * page load needs no database round trip for it. Writes go through `ensurePrismaUser`.
 */
export async function getSessionUser(authUser: AuthUser): Promise<SessionUser> {
  const { email, name, image } = profile(authUser);
  const cached = await sharedCache(
    () =>
      prisma.user.findUnique({
        where: { id: authUser.id },
        select: { id: true, email: true, name: true, image: true, activeOrganizationId: true },
      }),
    ["session-user", authUser.id],
    { tags: [userTag(authUser.id)], revalidate: ACCESS_TTL },
  );
  if (cached && cached.email === email && cached.name === name && cached.image === image) return cached;
  const user = await ensurePrismaUser(authUser);
  return { id: user.id, email: user.email, name: user.name, activeOrganizationId: user.activeOrganizationId };
}
