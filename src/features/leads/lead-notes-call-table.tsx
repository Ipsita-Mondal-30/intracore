"use client";

import { formatLeadListDateTime } from "@/lib/leads/display-formatters";
import { CallRecordingPlayer } from "@/features/leads/call-recording-player";

export type NotesCallRow = {
  id: string;
  kind: "note" | "call";
  at: string;
  dialedNo: string | null;
  description: string;
  agentName: string;
  did: string | null;
  recordingPath?: string | null;
  leadId?: string;
};

export function LeadNotesCallTable({ rows }: { rows: NotesCallRow[] }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No notes or call records yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--ic-border)]">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--ic-border)] bg-[var(--ic-surface-muted)] text-xs font-semibold text-muted">
            <th className="w-10 px-3 py-2.5">#</th>
            <th className="px-3 py-2.5">Date</th>
            <th className="px-3 py-2.5">Dialed No</th>
            <th className="min-w-[240px] px-3 py-2.5">Description</th>
            <th className="px-3 py-2.5">Agent Name</th>
            <th className="px-3 py-2.5">DID</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.kind}-${row.id}`}
              className="border-b border-[var(--ic-border)]/70 last:border-0 odd:bg-white even:bg-[var(--ic-surface-muted)]/40"
            >
              <td className="px-3 py-2.5 text-muted">{index + 1}</td>
              <td className="whitespace-nowrap px-3 py-2.5">
                {formatLeadListDateTime(row.at)}
              </td>
              <td className="px-3 py-2.5">{row.dialedNo ?? "—"}</td>
              <td className="px-3 py-2.5">
                <div>{row.description}</div>
                {row.kind === "call" && row.recordingPath && row.leadId ? (
                  <CallRecordingPlayer leadId={row.leadId} callRecordId={row.id} />
                ) : null}
              </td>
              <td className="px-3 py-2.5">{row.agentName}</td>
              <td className="px-3 py-2.5">{row.did ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
