import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";

export function PerformanceGaugeCard({
  name,
  pendingLabel = "Pending",
  pendingValue = "0",
  lostLabel = "Lost",
  lostValue = "—",
}: {
  name?: string | null;
  pendingLabel?: string;
  pendingValue?: string;
  lostLabel?: string;
  lostValue?: string;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Performance</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center pb-6">
        <div className="relative mb-4 flex h-36 w-36 items-center justify-center">
          <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full">
            <circle
              cx="60"
              cy="60"
              r="48"
              fill="none"
              className="stroke-[var(--ic-table-row-hover)]"
              strokeWidth="10"
            />
            <circle
              cx="60"
              cy="60"
              r="48"
              fill="none"
              stroke="var(--ic-primary)"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray="40 260"
              transform="rotate(-90 60 60)"
              opacity="0.35"
            />
          </svg>
          <Avatar name={name} size="lg" />
        </div>
        <div className="w-full space-y-2 text-sm">
          <div className="flex items-center justify-between rounded-xl bg-[var(--ic-surface-muted)] px-3 py-2">
            <span className="text-muted">{pendingLabel}</span>
            <span className="font-semibold">{pendingValue}</span>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-[var(--ic-surface-muted)] px-3 py-2">
            <span className="text-muted">{lostLabel}</span>
            <span className="font-semibold">{lostValue}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
