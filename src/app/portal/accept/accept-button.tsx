"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function AcceptButton({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function accept() {
    setPending(true);
    setError(null);
    const res = await fetch("/api/portal/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const json = await res.json().catch(() => ({ ok: false, error: res.statusText }));
    setPending(false);
    if (!json.ok) return setError(json.error ?? "Could not accept the invitation");
    router.push("/portal");
  }
  return (
    <div className="space-y-2">
      <Button onClick={accept} disabled={pending} className="w-full">{pending ? "Accepting…" : "Accept invitation"}</Button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
