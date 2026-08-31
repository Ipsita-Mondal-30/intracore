"use client";

import { useEffect, useState } from "react";

export function CallRecordingPlayer({
  leadId,
  callRecordId,
}: {
  leadId: string;
  callRecordId: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);

    fetch(`/api/leads/${leadId}/call-records/${callRecordId}/recording`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Failed to load recording");
        }
        return res.json();
      })
      .then((data: { signedUrl?: string }) => {
        if (!cancelled && data.signedUrl) setSrc(data.signedUrl);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [leadId, callRecordId]);

  if (error) {
    return <span className="text-xs text-red-600">{error}</span>;
  }
  if (!src) {
    return <span className="text-xs text-muted">Loading audio…</span>;
  }

  return (
    <audio controls preload="none" className="ic-audio-player">
      <source src={src} />
    </audio>
  );
}
