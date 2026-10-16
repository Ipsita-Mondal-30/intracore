/** Shown instantly on every navigation inside the app while the page renders. */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-10 w-1/3 animate-pulse rounded-2xl bg-[var(--ic-surface-muted)]" />
      <div className="h-12 animate-pulse rounded-2xl bg-[var(--ic-surface-muted)]" />
      <div className="h-[420px] animate-pulse rounded-2xl bg-[var(--ic-surface-muted)]" />
    </div>
  );
}
