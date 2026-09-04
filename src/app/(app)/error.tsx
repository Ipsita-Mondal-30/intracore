"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("App route error", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-bold tracking-tight">Could not load this page</h1>
        <p className="mt-2 text-sm text-muted">
          Try again. If this keeps happening, sign out and sign back in.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-2xs text-subtle">Ref: {error.digest}</p>
        ) : null}
        {process.env.NODE_ENV === "development" && error.message ? (
          <p className="mt-2 break-words text-left text-2xs text-danger">{error.message}</p>
        ) : null}
        <div className="mt-6 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white"
          >
            Try again
          </button>
          <Link href="/dashboard" className="text-sm font-medium text-primary">
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
