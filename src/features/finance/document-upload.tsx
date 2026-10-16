"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Multipart upload to /api/v1/documents; the browser sets the multipart boundary. */
export function DocumentUpload({ entityType, entityId }: { entityType: string; entityId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new FormData(form);
    body.set("entityType", entityType);
    body.set("entityId", entityId);
    setPending(true);
    try {
      const res = await fetch("/api/v1/documents", { method: "POST", body });
      const json = (await res.json().catch(() => ({ ok: false, error: res.statusText }))) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Upload failed");
      toast.success("Uploaded");
      form.reset();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <Input type="file" name="file" required className="max-w-xs" aria-label="Receipt file" />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>{pending ? "Uploading…" : "Upload"}</Button>
    </form>
  );
}

/** Fetches a short-lived signed URL and opens it. */
export function DocumentDownload({ id, label }: { id: string; label: string }) {
  const [pending, setPending] = useState(false);
  async function open() {
    // Open the tab synchronously (inside the click) so popup blockers allow it.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    setPending(true);
    try {
      const { signedUrl } = await apiFetch<{ signedUrl: string }>(`/documents/${id}`);
      if (tab) tab.location.href = signedUrl;
      else window.location.assign(signedUrl);
    } catch (e) {
      tab?.close();
      toast.error(e instanceof ApiError ? e.message : "Download failed");
    } finally {
      setPending(false);
    }
  }
  return (
    <button type="button" onClick={open} disabled={pending} className="text-primary hover:underline disabled:opacity-50">
      {label}
    </button>
  );
}
