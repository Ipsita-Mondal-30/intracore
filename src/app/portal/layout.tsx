import Link from "next/link";
import { logoutAction } from "@/features/auth/actions";
import { Toaster } from "@/components/ui/toaster";

export const dynamic = "force-dynamic";

/** External portals: no AppShell and no internal navigation. */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="border-b border-[var(--ic-border)] bg-[var(--ic-surface,white)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/portal" className="font-semibold">Portal</Link>
          <form action={logoutAction}>
            <button type="submit" className="text-sm text-muted hover:underline">Sign out</button>
          </form>
        </div>
      </div>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      <Toaster />
    </div>
  );
}
