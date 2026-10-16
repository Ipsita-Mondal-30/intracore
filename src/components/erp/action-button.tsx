"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInvalidateAfterWrite } from "@/lib/query/hooks";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * POSTs to an /api/v1 path (e.g. "/quotations/:id/approve"). `prompt` asks for a text
 * value first (sent as `promptField`); `redirectTo` may use ":id" from the response.
 */
export function ActionButton({
  path,
  label,
  body,
  prompt,
  promptField = "reason",
  confirm,
  redirectTo,
  variant = "secondary",
  method = "POST",
}: {
  path: string;
  label: string;
  body?: Record<string, unknown>;
  prompt?: string;
  promptField?: string;
  confirm?: string;
  redirectTo?: string;
  variant?: ButtonProps["variant"];
  method?: "POST" | "PATCH" | "PUT" | "DELETE";
}) {
  const router = useRouter();
  const invalidate = useInvalidateAfterWrite();
  const [pending, setPending] = useState(false);

  async function run() {
    let payload = body ?? {};
    if (prompt) {
      const value = window.prompt(prompt);
      if (value === null) return;
      payload = { ...payload, [promptField]: value };
    }
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    try {
      const data = await apiFetch<Record<string, unknown> | null>(path, { method, body: payload });
      toast.success(`${label}: done`);
      const id = (data?.id as string) ?? ((data?.salesOrder as { id?: string })?.id ?? "");
      invalidate();
      if (redirectTo) router.push(redirectTo.replace(":id", id));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : `${label} failed`);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" size="sm" variant={variant} onClick={run} disabled={pending}>
      {pending ? "Working…" : label}
    </Button>
  );
}
