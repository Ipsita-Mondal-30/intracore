import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";

export function FeedbackForm({ interviewId }: { interviewId: string }) {
  return (
    <ApiForm path={`/interviews/${interviewId}/feedback`} submitLabel="Submit feedback" successMessage="Feedback recorded" className="grid gap-3 sm:grid-cols-3">
      <Field label="Rating (1–5)"><Input type="number" name="rating" min={1} max={5} required /></Field>
      <Field label="Recommendation">
        <Select name="recommendation">{["STRONG_YES", "YES", "NO", "STRONG_NO"].map((r) => <option key={r} value={r}>{r.replace("_", " ").toLowerCase()}</option>)}</Select>
      </Field>
      <Field label="Comments" className="sm:col-span-3"><Textarea name="comments" maxLength={5000} rows={2} /></Field>
    </ApiForm>
  );
}
