"use client";

import { useState, type FormEvent } from "react";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime } from "@/components/erp/format";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { useApiQuery } from "@/lib/query/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Multipart upload to /api/v1/documents (or, with `versionOf`, a new version of that
 * document); the browser sets the multipart boundary.
 */
export function DocumentUpload({ entityType, entityId, versionOf, onDone }: { entityType?: string; entityId?: string; versionOf?: string; onDone?: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new FormData(form);
    if (!versionOf) {
      body.set("entityType", entityType ?? "");
      body.set("entityId", entityId ?? "");
    }
    setPending(true);
    try {
      const res = await fetch(versionOf ? `/api/v1/documents/${versionOf}/versions` : "/api/v1/documents", { method: "POST", body });
      const json = (await res.json().catch(() => ({ ok: false, error: res.statusText }))) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Upload failed");
      toast.success("Uploaded");
      form.reset();
      onDone?.();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <Input type="file" name="file" required className="max-w-xs" aria-label={versionOf ? "New version file" : "File"} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>{pending ? "Uploading…" : versionOf ? "Upload new version" : "Upload"}</Button>
    </form>
  );
}

/** Fetches a short-lived signed URL and opens it; "Details" shows versions and signatures. */
export function DocumentDownload({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-2">
        <DownloadLink id={id} label={label} />
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-2xs text-subtle hover:underline" aria-expanded={open}>
          {open ? "Hide details" : "Details"}
        </button>
      </span>
      {open ? <DocumentDetails id={id} /> : null}
    </span>
  );
}

function DownloadLink({ id, label }: { id: string; label: string }) {
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

type SignatureRequestRow = { id: string; status: string; provider: string; simulated: boolean; notice: string | null; completedAt: string | null };
type VersionRow = {
  id: string;
  fileName: string;
  mimeType: string;
  version: number;
  sizeBytes: number;
  checksum: string | null;
  signatureStatus: string;
  supersededAt: string | null;
  createdAt: string;
  signatureRequests: SignatureRequestRow[];
};
type Versions = { items: VersionRow[]; can: { createVersion: boolean; requestSignature: boolean } };

/**
 * Version history, checksums and e-signature status. Signature status only ever comes
 * from the provider; there is no control here (or in the API) that marks a document signed.
 */
function DocumentDetails({ id }: { id: string }) {
  // Cached per document; reopening the panel shows it instantly while it revalidates.
  const { data, error, refetch } = useApiQuery<Versions>(`/documents/${id}/versions`);
  const load = () => void refetch();
  if (error) return <p className="mt-1 text-2xs text-danger">{error instanceof ApiError ? error.message : "Could not load details"}</p>;
  if (!data) return <p className="mt-1 text-2xs text-subtle">Loading…</p>;

  const latest = data.items[0];
  const open = latest?.signatureRequests.find((r) => ["DRAFT", "SENT", "VIEWED"].includes(r.status));
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-[var(--ic-border)] p-3 text-xs">
      <ul className="space-y-1.5">
        {data.items.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">v{v.version}</span>
            <DownloadLink id={v.id} label={v.fileName} />
            <span className="text-subtle">{formatDateTime(v.createdAt)}</span>
            {v.checksum ? <span className="font-mono text-2xs text-subtle" title={`SHA-256 ${v.checksum}`}>sha256 {v.checksum.slice(0, 12)}…</span> : null}
            {v.signatureStatus !== "NONE" ? <StatusBadge status={v.signatureStatus} /> : null}
            {v.signatureRequests.some((r) => r.simulated && r.status === "SIGNED") ? (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-medium text-amber-900">Simulated – not a legal signature</span>
            ) : null}
            {v.supersededAt ? <span className="text-2xs text-subtle">superseded</span> : null}
          </li>
        ))}
      </ul>
      {latest && data.can.requestSignature ? (
        <SignaturePanel document={latest} open={open} onChange={load} />
      ) : null}
      {data.can.createVersion ? <DocumentUpload versionOf={id} onDone={load} /> : null}
    </div>
  );
}

function SignaturePanel({ document, open, onChange }: { document: VersionRow; open?: SignatureRequestRow; onChange: () => void }) {
  const [pending, setPending] = useState(false);
  async function run(path: string, body?: unknown) {
    setPending(true);
    try {
      await apiFetch(path, { method: "POST", body });
      onChange();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Request failed");
    } finally {
      setPending(false);
    }
  }
  async function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    await run("/signature-requests", { documentId: document.id, signers: [{ name: String(f.get("name")), email: String(f.get("email")) }] });
  }

  if (open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span>Signature request:</span>
        <StatusBadge status={open.status} />
        {open.notice ? <span className="text-2xs text-amber-900">{open.notice}</span> : null}
        {open.status === "DRAFT" ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(`/signature-requests/${open.id}/send`)}>Send for signature</Button> : null}
        {open.status !== "DRAFT" ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(`/signature-requests/${open.id}/refresh`)}>Check status</Button> : null}
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => window.confirm("Void this signature request?") && run(`/signature-requests/${open.id}/void`)}>Void</Button>
      </div>
    );
  }
  if (document.mimeType !== "application/pdf" || document.signatureStatus === "SIGNED") return null;
  return (
    <form onSubmit={request} className="flex flex-wrap items-center gap-2">
      <span>Request e-signature:</span>
      <Input name="name" required placeholder="Signer name" className="max-w-[160px]" aria-label="Signer name" />
      <Input name="email" type="email" required placeholder="signer@example.com" className="max-w-[200px]" aria-label="Signer email" />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>Request signature</Button>
    </form>
  );
}
