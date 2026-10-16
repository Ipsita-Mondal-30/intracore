"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Submits its fields as JSON to an /api/v1 endpoint.
 * - names may be dotted ("settings.quotation.approvalAmount") to build nested objects
 * - type=number inputs send numbers, checkboxes send booleans, empty fields are omitted
 *   (or sent as null when the input has data-nullable)
 * - `redirect` may contain ":id", replaced with the created record's id
 */
export function ApiForm({
  path,
  method = "POST",
  children,
  submitLabel = "Save",
  redirect,
  extra,
  successMessage = "Saved",
  className,
  confirm,
}: {
  path: string;
  method?: "POST" | "PATCH" | "PUT" | "DELETE";
  children?: ReactNode;
  submitLabel?: string;
  redirect?: string;
  extra?: Record<string, unknown>;
  successMessage?: string;
  className?: string;
  confirm?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget; // currentTarget is cleared once the handler yields
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    setErrors({});
    try {
      const body = { ...formValues(form), ...extra };
      const data = await apiFetch<{ id?: string } | null>(path, { method, body });
      toast.success(successMessage);
      if (redirect) router.push(redirect.replace(":id", data?.id ?? ""));
      else router.refresh();
      if (method === "POST" && !redirect) form.reset();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(Object.fromEntries((error.details ?? []).map((d) => [d.path, d.message])));
        toast.error(error.message);
      } else {
        toast.error("Something went wrong");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={cn("space-y-3", className)}>
      {children}
      {Object.keys(errors).length > 0 ? (
        <ul className="rounded-xl bg-red-50 px-3 py-2 text-xs text-danger">
          {Object.entries(errors).map(([field, message]) => (
            <li key={field}>
              {field ? <strong>{field}: </strong> : null}
              {message}
            </li>
          ))}
        </ul>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

function formValues(form: HTMLFormElement) {
  const out: Record<string, unknown> = {};
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
    if (!el.name || el.disabled) continue;
    let value: unknown;
    if (el instanceof HTMLInputElement && el.type === "checkbox") value = el.checked;
    else if (el.value === "") {
      if (!el.hasAttribute("data-nullable")) continue;
      value = null;
    } else if (el instanceof HTMLInputElement && el.type === "number") value = Number(el.value);
    else value = el.value;
    setPath(out, el.name.split("."), value);
  }
  return out;
}

function setPath(target: Record<string, unknown>, keys: string[], value: unknown) {
  const [head, ...rest] = keys;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  target[head] = (target[head] as Record<string, unknown>) ?? {};
  setPath(target[head] as Record<string, unknown>, rest, value);
}

/** Labelled input row used inside ApiForm. */
export function Field({
  label,
  children,
  hint,
  className,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={cn("block text-sm", className)}>
      <span className="mb-1.5 block font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-2xs text-subtle">{hint}</span> : null}
    </label>
  );
}
