import Link from "next/link";
import { getSessionContext } from "@/lib/tenant";
import { AcceptButton } from "./accept-button";

/**
 * Invitation landing page. The token stays in the URL; acceptance needs a signed-in user
 * whose email matches the invitation (checked by POST /api/portal/accept).
 */
export default async function AcceptPortalInvitation({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const session = await getSessionContext();
  return (
    <div className="ic-panel mx-auto max-w-md space-y-4 p-8">
      <h1 className="text-2xl font-bold tracking-tight">Portal invitation</h1>
      {!token ? (
        <p className="text-sm text-danger">This link is missing its invitation token.</p>
      ) : !session ? (
        <p className="text-sm text-muted">
          <Link className="underline" href="/login">Sign in</Link> or <Link className="underline" href="/register">create an account</Link> with the email address the invitation was sent to, then open this link again.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">Signed in as <strong>{session.email}</strong>. Accepting gives this login access to the portal you were invited to.</p>
          <AcceptButton token={token} />
        </>
      )}
    </div>
  );
}
