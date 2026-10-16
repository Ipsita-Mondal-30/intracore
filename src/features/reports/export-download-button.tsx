"use client";

import { useState } from "react";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";

/** Fetches a short-lived signed URL for the caller's own export and opens it. */
export function ExportDownloadButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const { url } = await apiFetch<{ url: string }>(`/data-exports/${id}/download`);
      window.location.assign(url);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Download failed");
    } finally {
      setBusy(false);
    }
  }
  return <Button type="button" size="sm" variant="secondary" onClick={download} disabled={busy}>{busy ? "…" : "Download"}</Button>;
}
