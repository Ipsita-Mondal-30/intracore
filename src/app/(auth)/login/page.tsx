"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { loginAction } from "@/features/auth/actions";
import type { ActionResult } from "@/features/auth/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initial: ActionResult | null = null;

/** Same-origin path from ?callbackUrl= (never an absolute or protocol-relative URL). */
function safeCallback(): string {
  const raw = new URLSearchParams(window.location.search).get("callbackUrl");
  return raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/dashboard";
}

export default function LoginPage() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(loginAction, initial);

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
      router.push(safeCallback());
    }
  }, [state, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="ic-panel w-full max-w-md p-8">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-sm font-bold text-white">
            IC
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-muted">
            Access your IntraCore organization
          </p>
        </div>

        <form action={formAction} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              disabled={pending}
            />
          </div>
          {state && !state.ok ? (
            <p className="text-sm text-danger">{state.error}</p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm">
          <Link href="/forgot-password" className="text-primary">
            Forgot password?
          </Link>
        </p>
        <p className="mt-4 text-center text-sm text-muted">
          No account?{" "}
          <Link href="/register" className="font-medium text-primary">
            Register
          </Link>
        </p>
      </div>
    </div>
  );
}
