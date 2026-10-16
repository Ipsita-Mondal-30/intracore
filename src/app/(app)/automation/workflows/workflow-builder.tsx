"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/erp/api-form";

/** Catalog as the server page passes it: entity → actions and fields (with their operators). */
export type BuilderCatalog = Record<string, { label: string; actions: string[]; fields: Record<string, { type: string; options?: string[]; ops: string[] }> }>;
type Option = { value: string; label: string };
type Cond = { field: string; op: string; value: string };
type Act = { type: string; params: Record<string, string> };
type Step = { kind: "user" | "role"; approverUserId: string; approverRoleCode: string; timeoutHours: string; escalateToUserId: string };
export type BuilderInitial = {
  name: string;
  description: string | null;
  triggerEntity: string;
  triggerAction: string;
  isEnabled: boolean;
  conditions: { field: string; op: string; value?: unknown }[];
  actions: { type: string; params: Record<string, unknown> }[];
  approvalSteps: { approverUserId?: string; approverRoleCode?: string; timeoutHours?: number; escalateToUserId?: string }[];
};

const ACTION_PARAMS: Record<string, { name: string; label: string; kind: "text" | "user" | "role" | "number" }[]> = {
  notify_user: [{ name: "userId", label: "User", kind: "user" }, { name: "title", label: "Title", kind: "text" }, { name: "body", label: "Body", kind: "text" }],
  notify_role: [{ name: "roleCode", label: "Role", kind: "role" }, { name: "title", label: "Title", kind: "text" }, { name: "body", label: "Body", kind: "text" }],
  notify_record_owner: [{ name: "title", label: "Title", kind: "text" }, { name: "body", label: "Body", kind: "text" }],
  create_task: [
    { name: "title", label: "Title", kind: "text" },
    { name: "description", label: "Description", kind: "text" },
    { name: "assigneeUserId", label: "Assignee (default: you)", kind: "user" },
    { name: "dueInDays", label: "Due in days", kind: "number" },
  ],
  request_approval: [{ name: "title", label: "Approval title", kind: "text" }],
};
const ACTION_LABELS: Record<string, string> = {
  notify_user: "Notify a user",
  notify_role: "Notify a role",
  notify_record_owner: "Notify the record owner",
  create_task: "Create a task",
  request_approval: "Request approval (uses the steps below; must be last)",
};

const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v));

export function WorkflowBuilder({ catalog, members, roles, initial, workflowId }: { catalog: BuilderCatalog; members: Option[]; roles: Option[]; initial?: BuilderInitial; workflowId?: string }) {
  const router = useRouter();
  const entities = Object.keys(catalog);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [entity, setEntity] = useState(initial?.triggerEntity ?? entities[0]);
  const [action, setAction] = useState(initial?.triggerAction ?? catalog[entities[0]].actions[0]);
  const [enabled, setEnabled] = useState(initial?.isEnabled ?? false);
  const [conds, setConds] = useState<Cond[]>(initial?.conditions.map((c) => ({ field: c.field, op: c.op, value: show(c.value) })) ?? []);
  const [acts, setActs] = useState<Act[]>(initial?.actions.map((a) => ({ type: a.type, params: Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, show(v)])) })) ?? [{ type: "notify_record_owner", params: {} }]);
  const [steps, setSteps] = useState<Step[]>(
    initial?.approvalSteps.map((s) => ({ kind: s.approverRoleCode ? "role" : "user", approverUserId: s.approverUserId ?? "", approverRoleCode: s.approverRoleCode ?? "", timeoutHours: show(s.timeoutHours), escalateToUserId: s.escalateToUserId ?? "" })) ?? [],
  );
  const [pending, setPending] = useState(false);
  const fields = catalog[entity]?.fields ?? {};

  const patch = <T,>(set: (fn: (rows: T[]) => T[]) => void, i: number, p: Partial<T>) => set((rows) => rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  function typed(field: string, op: string, raw: string): unknown {
    if (op === "exists" || op === "changed") return raw !== "false";
    const one = (v: string) => (fields[field]?.type === "number" ? Number(v) : fields[field]?.type === "boolean" ? v === "true" : v);
    return op === "in" || op === "not_in" ? raw.split(",").map((v) => v.trim()).filter(Boolean).map(one) : one(raw.trim());
  }

  async function save() {
    const body = {
      name,
      description: description || null,
      triggerEntity: entity,
      triggerAction: action,
      isEnabled: enabled,
      conditions: conds.map((c) => ({ field: c.field, op: c.op, value: typed(c.field, c.op, c.value) })),
      actions: acts.map((a) => ({
        type: a.type,
        params: Object.fromEntries(Object.entries(a.params).filter(([, v]) => v !== "").map(([k, v]) => [k, k === "dueInDays" ? Number(v) : v])),
      })),
      approvalSteps: steps.map((s) => ({
        ...(s.kind === "user" ? { approverUserId: s.approverUserId } : { approverRoleCode: s.approverRoleCode }),
        ...(s.timeoutHours ? { timeoutHours: Number(s.timeoutHours) } : {}),
        ...(s.escalateToUserId ? { escalateToUserId: s.escalateToUserId } : {}),
      })),
    };
    setPending(true);
    try {
      const saved = await apiFetch<{ id: string }>(workflowId ? `/workflows/${workflowId}` : "/workflows", { method: workflowId ? "PATCH" : "POST", body });
      toast.success("Workflow saved");
      if (workflowId) router.refresh();
      else router.push(`/automation/workflows/${saved.id}`);
    } catch (error) {
      const details = error instanceof ApiError && error.details?.length ? ` (${error.details.map((d) => `${d.path}: ${d.message}`).join("; ")})` : "";
      toast.error(error instanceof ApiError ? `${error.message}${details}` : "Save failed");
    } finally {
      setPending(false);
    }
  }

  const userSelect = (value: string, onChange: (v: string) => void, label: string, optional = false) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{optional ? "—" : "Select…"}</option>
      {members.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
    </Select>
  );

  return (
    <div className="space-y-5 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} /></Field>
        <Field label="When this record…">
          <Select value={entity} onChange={(e) => { const next = e.target.value; setEntity(next); setAction(catalog[next].actions[0]); setConds([]); }}>
            {entities.map((k) => <option key={k} value={k}>{catalog[k].label}</option>)}
          </Select>
        </Field>
        <Field label="…has this event (audit action)">
          <Select value={action} onChange={(e) => setAction(e.target.value)}>
            {catalog[entity].actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
        </Field>
      </div>

      <section className="space-y-2">
        <h3 className="font-medium">Conditions <span className="text-2xs text-subtle">(all must hold; in/not in take comma-separated values)</span></h3>
        {conds.map((c, i) => {
          const def = fields[c.field];
          return (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_140px_1fr_auto]">
              <Select value={c.field} onChange={(e) => patch(setConds, i, { field: e.target.value, op: fields[e.target.value]?.ops[0] ?? "eq" })} aria-label="Field">
                {Object.keys(fields).map((f) => <option key={f} value={f}>{f} ({fields[f].type})</option>)}
              </Select>
              <Select value={c.op} onChange={(e) => patch(setConds, i, { op: e.target.value })} aria-label="Operator">
                {(def?.ops ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
              {c.op === "exists" || c.op === "changed" ? (
                <Select value={c.value || "true"} onChange={(e) => patch(setConds, i, { value: e.target.value })} aria-label="Value"><option value="true">true</option><option value="false">false</option></Select>
              ) : def?.options && c.op !== "in" && c.op !== "not_in" && c.op !== "contains" ? (
                <Select value={c.value} onChange={(e) => patch(setConds, i, { value: e.target.value })} aria-label="Value">
                  <option value="">Select…</option>
                  {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </Select>
              ) : def?.type === "boolean" ? (
                <Select value={c.value} onChange={(e) => patch(setConds, i, { value: e.target.value })} aria-label="Value"><option value="true">true</option><option value="false">false</option></Select>
              ) : (
                <Input value={c.value} onChange={(e) => patch(setConds, i, { value: e.target.value })} placeholder={def?.type === "date" ? "2026-12-31" : def?.options ? def.options.join(", ") : "value"} aria-label="Value" />
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setConds((rows) => rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          );
        })}
        <Button type="button" size="sm" variant="secondary" onClick={() => { const f = Object.keys(fields)[0]; setConds((rows) => [...rows, { field: f, op: fields[f].ops[0], value: "" }]); }}>Add condition</Button>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Actions <span className="text-2xs text-subtle">(text may use {"{{field}}"} from the fields above)</span></h3>
        {acts.map((a, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-[var(--ic-border)] p-3">
            <div className="flex gap-2">
              <Select value={a.type} onChange={(e) => patch(setActs, i, { type: e.target.value, params: {} })} aria-label="Action">
                {Object.keys(ACTION_PARAMS).map((t) => <option key={t} value={t}>{ACTION_LABELS[t]}</option>)}
              </Select>
              <Button type="button" size="sm" variant="ghost" onClick={() => setActs((rows) => rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {ACTION_PARAMS[a.type].map((p) => {
                const set = (v: string) => patch(setActs, i, { params: { ...a.params, [p.name]: v } });
                const value = a.params[p.name] ?? "";
                return (
                  <Field key={p.name} label={p.label}>
                    {p.kind === "user" ? userSelect(value, set, p.label, p.name !== "userId")
                      : p.kind === "role" ? (
                        <Select value={value} onChange={(e) => set(e.target.value)}><option value="">Select…</option>{roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select>
                      ) : <Input type={p.kind === "number" ? "number" : "text"} value={value} onChange={(e) => set(e.target.value)} />}
                  </Field>
                );
              })}
            </div>
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={() => setActs((rows) => [...rows, { type: "notify_user", params: {} }])}>Add action</Button>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Approval steps <span className="text-2xs text-subtle">(sequential; used by “Request approval”)</span></h3>
        {steps.map((s, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[110px_1fr_110px_1fr_auto]">
            <Select value={s.kind} onChange={(e) => patch(setSteps, i, { kind: e.target.value as Step["kind"] })} aria-label="Approver type"><option value="user">User</option><option value="role">Role</option></Select>
            {s.kind === "user" ? userSelect(s.approverUserId, (v) => patch(setSteps, i, { approverUserId: v }), "Approver") : (
              <Select value={s.approverRoleCode} onChange={(e) => patch(setSteps, i, { approverRoleCode: e.target.value })} aria-label="Approver role"><option value="">Select…</option>{roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select>
            )}
            <Input type="number" min={1} value={s.timeoutHours} onChange={(e) => patch(setSteps, i, { timeoutHours: e.target.value })} placeholder="Timeout h" aria-label="Timeout hours" />
            {userSelect(s.escalateToUserId, (v) => patch(setSteps, i, { escalateToUserId: v }), "Escalate to", true)}
            <Button type="button" size="sm" variant="ghost" onClick={() => setSteps((rows) => rows.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={() => setSteps((rows) => [...rows, { kind: "user", approverUserId: "", approverRoleCode: "", timeoutHours: "", escalateToUserId: "" }])}>Add step</Button>
      </section>

      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled (reacts to events from the moment it is enabled)</label>
      <Button type="button" size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save workflow"}</Button>
    </div>
  );
}

/** Dry run: POST /workflows/:id/test with a sample snapshot; nothing is executed. */
export function WorkflowTestPanel({ workflowId, sample }: { workflowId: string; sample: string }) {
  const [text, setText] = useState(sample);
  const [result, setResult] = useState<string | null>(null);
  async function run() {
    try {
      const next = JSON.parse(text);
      setResult(JSON.stringify(await apiFetch(`/workflows/${workflowId}/test`, { method: "POST", body: { next } }), null, 2));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Sample must be a JSON object");
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} aria-label="Sample snapshot (JSON)" className="font-mono text-xs" />
      <Button type="button" size="sm" variant="secondary" onClick={run}>Test (dry run)</Button>
      {result ? <pre className="max-h-80 overflow-auto rounded-xl bg-[var(--ic-surface-muted)] p-3 text-xs">{result}</pre> : null}
    </div>
  );
}
