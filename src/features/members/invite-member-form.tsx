"use client";

import { useActionState } from "react";
import { inviteMemberAction } from "@/features/members/actions";
import type { ActionResult } from "@/features/auth/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initial: (ActionResult & {
  inviteUrl?: string;
  emailSent?: boolean;
}) | null = null;

export function InviteMemberForm({
  roles,
}: {
  roles: { id: string; name: string; code: string }[];
}) {
  const [state, formAction, pending] = useActionState(
    inviteMemberAction,
    initial,
  );

  return (
    <form
      action={formAction}
      className="mt-6 grid max-w-xl gap-4 rounded-card border border-[var(--ic-border)] bg-[var(--ic-surface-muted)] p-4 sm:grid-cols-[1fr_1fr_auto]"
    >
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required />
      </div>
      <div>
        <Label htmlFor="roleId">Role</Label>
        <select
          id="roleId"
          name="roleId"
          required
          defaultValue=""
          className="flex h-10 w-full rounded-xl border border-border-strong bg-input px-3 text-sm text-foreground"
        >
          <option value="" disabled>
            Select role
          </option>
          {roles
            .filter((r) => r.code !== "owner")
            .map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
        </select>
      </div>
      <div className="flex items-end">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? "Inviting…" : "Invite"}
        </Button>
      </div>
      {state && !state.ok ? (
        <p className="sm:col-span-3 text-sm text-danger">{state.error}</p>
      ) : null}
      {state?.ok && state.emailSent ? (
        <p className="sm:col-span-3 text-sm text-muted">
          {state.message ?? "Invitation sent"}
        </p>
      ) : null}
      {state?.ok && state.inviteUrl ? (
        <p className="sm:col-span-3 break-all text-sm text-muted">
          {state.message ?? "Invitation created"}. Share this link:{" "}
          {state.inviteUrl}
        </p>
      ) : null}
    </form>
  );
}
