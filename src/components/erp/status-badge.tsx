import { Badge } from "@/components/ui/badge";
import { humanize } from "@/components/erp/format";

const TONES: Record<string, "default" | "primary" | "success" | "warning" | "danger" | "neutral"> = {
  DRAFT: "neutral",
  PENDING_APPROVAL: "warning",
  APPROVED: "primary",
  SENT: "primary",
  ACCEPTED: "success",
  REJECTED: "danger",
  EXPIRED: "warning",
  CANCELLED: "danger",
  SUPERSEDED: "default",
  CONFIRMED: "primary",
  PARTIALLY_DELIVERED: "warning",
  DELIVERED: "success",
  PARTIALLY_RECEIVED: "warning",
  RECEIVED: "success",
  POSTED: "success",
  CLOSED: "default",
  ACTIVE: "success",
  INACTIVE: "neutral",
  ARCHIVED: "default",
  WON: "success",
  LOST: "danger",
  PROSPECTING: "neutral",
  QUALIFICATION: "primary",
  PROPOSAL: "primary",
  NEGOTIATION: "warning",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={TONES[status] ?? "default"}>{humanize(status)}</Badge>;
}
