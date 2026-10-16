"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@/components/ui/button";

/** Browser caller for /api/portal (same envelope as /api/v1). */
async function portalFetch(path: string, method: string, body?: unknown) {
  const res = await fetch(`/api/portal${path}`, {
    method,
    headers: { "content-type": "application/json", ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: res.statusText }));
  if (!json.ok) throw new Error(json.error ?? "Request failed");
  return json.data as Record<string, unknown> | null;
}

/** Form values → JSON: checkboxes are booleans, empty fields are omitted, data-json fields are parsed. */
function values(form: HTMLFormElement) {
  const out: Record<string, unknown> = {};
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) || !el.name || el.disabled) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") out[el.name] = el.checked;
    else if (el.hasAttribute("data-json")) out[el.name] = JSON.parse(el.value || "null");
    else if (el.value !== "") out[el.name] = el instanceof HTMLInputElement && el.type === "number" ? Number(el.value) : el.value;
  }
  return out;
}

export function PortalForm({
  path,
  method = "POST",
  children,
  submitLabel = "Submit",
  successMessage = "Saved",
  redirect,
  transform,
}: {
  path: string;
  method?: "POST" | "PATCH";
  children: ReactNode;
  submitLabel?: string;
  successMessage?: string;
  /** ":id" is replaced with the created record's id */
  redirect?: string;
  /** Reshape flat form values before sending (e.g. into lines) */
  transform?: (v: Record<string, unknown>) => unknown;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    try {
      const v = values(form);
      const data = await portalFetch(path, method, transform ? transform(v) : v);
      toast.success(successMessage);
      if (redirect) router.push(redirect.replace(":id", String(data?.id ?? "")));
      else {
        form.reset();
        router.refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {children}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Sending…" : submitLabel}
      </Button>
    </form>
  );
}

export function PortalAction({
  path,
  label,
  body,
  confirm,
  method = "POST",
  variant = "secondary",
  redirect,
}: {
  path: string;
  label: string;
  body?: unknown;
  confirm?: string;
  method?: "POST" | "PATCH";
  variant?: ButtonProps["variant"];
  redirect?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    try {
      await portalFetch(path, method, body ?? {});
      toast.success(`${label}: done`);
      if (redirect) router.push(redirect);
      else router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${label} failed`);
    } finally {
      setPending(false);
    }
  }
  return (
    <Button type="button" size="sm" variant={variant} onClick={run} disabled={pending}>
      {pending ? "…" : label}
    </Button>
  );
}
