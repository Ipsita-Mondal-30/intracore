import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";

export function ReviewForm({ reviewId, action }: { reviewId: string; action: "self" | "manager" }) {
  return (
    <ApiForm path={`/performance-reviews/${reviewId}/${action}`} submitLabel="Submit review" successMessage="Review submitted" confirm="Submit? It cannot be edited afterwards." className="grid gap-3 sm:grid-cols-4">
      <Field label="Rating (1–5)"><Input type="number" name="rating" min={1} max={5} required /></Field>
      <Field label="Comments" className="sm:col-span-3"><Textarea name="comments" maxLength={5000} rows={2} /></Field>
    </ApiForm>
  );
}

export function GoalProgressForm({ goalId, current, status }: { goalId: string; current: string; status: string }) {
  return (
    <ApiForm path={`/goals/${goalId}`} method="PATCH" submitLabel="Update progress" successMessage="Progress updated" className="flex flex-wrap items-end gap-3">
      <Field label="Current value"><Input name="currentValue" inputMode="decimal" defaultValue={current} /></Field>
      <Field label="Status">
        <Select name="status" defaultValue={status}>{["NOT_STARTED", "ON_TRACK", "AT_RISK", "ACHIEVED", "MISSED"].map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}</Select>
      </Field>
    </ApiForm>
  );
}
