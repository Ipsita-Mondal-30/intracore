export function DashboardCharts({
  bySource,
  byStage,
  overTime,
  byAssignee,
}: {
  bySource: { label: string; value: number }[];
  byStage: { label: string; value: number; color?: string | null }[];
  overTime: { label: string; created: number; converted: number; conversionRate: number }[];
  byAssignee: { label: string; value: number; pipelineValue: number }[];
}) {
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-2">
      <BarCard title="Leads by source" items={bySource} />
      <BarCard title="Leads by stage" items={byStage} />
      <div className="ic-card p-5">
        <h3 className="mb-3 text-base font-semibold">Created vs converted</h3>
        {overTime.length === 0 ? (
          <p className="text-sm text-muted">No history yet.</p>
        ) : (
          <svg viewBox="0 0 640 180" className="h-[180px] w-full text-primary">
            {overTime.map((row, i) => {
              const max = Math.max(...overTime.map((r) => r.created), 1);
              const x = (i / Math.max(overTime.length - 1, 1)) * 600 + 20;
              const y = 160 - (row.created / max) * 130;
              const y2 = 160 - (row.converted / max) * 130;
              return (
                <g key={row.label}>
                  <circle cx={x} cy={y} r="3" fill="currentColor" />
                  <circle cx={x} cy={y2} r="3" className="fill-[var(--ic-success-text)]" />
                  {i > 0 ? (
                    <>
                      <line
                        x1={( (i - 1) / Math.max(overTime.length - 1, 1)) * 600 + 20}
                        y1={160 - (overTime[i - 1].created / max) * 130}
                        x2={x}
                        y2={y}
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <line
                        x1={( (i - 1) / Math.max(overTime.length - 1, 1)) * 600 + 20}
                        y1={160 - (overTime[i - 1].converted / max) * 130}
                        x2={x}
                        y2={y2}
                        className="stroke-[var(--ic-success-text)]"
                        strokeWidth="2"
                      />
                    </>
                  ) : null}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <div className="ic-card p-5">
        <h3 className="mb-3 text-base font-semibold">Assignee performance</h3>
        {byAssignee.length === 0 ? (
          <p className="text-sm text-muted">No assignments yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {byAssignee.map((row) => (
              <li key={row.label} className="flex justify-between gap-2">
                <span>{row.label}</span>
                <span className="text-muted">
                  {row.value} leads · {row.pipelineValue}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BarCard({
  title,
  items,
}: {
  title: string;
  items: { label: string; value: number; color?: string | null }[];
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="ic-card p-5">
      <h3 className="mb-3 text-base font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted">No data yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.label}>
              <div className="mb-1 flex justify-between text-2xs text-muted">
                <span>{item.label}</span>
                <span>{item.value}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-pill bg-[var(--ic-surface-muted)]">
                <div
                  className="h-full rounded-pill bg-primary"
                  style={{
                    width: `${(item.value / max) * 100}%`,
                    background: item.color || undefined,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
