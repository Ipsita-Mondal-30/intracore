"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Lead, LeadPriority } from "@prisma/client";
import { toast } from "sonner";
import {
  createLeadAction,
  updateLeadAction,
  type LeadActionResult,
} from "@/features/leads/actions";
import { leadFormSchema } from "@/lib/validations/leads";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

type Lookup = {
  sources: { id: string; name: string }[];
  stages: { id: string; name: string; pipelineId: string }[];
  members: { user: { id: string; name: string | null; email: string } }[];
  teams?: { id: string; name: string }[];
  tags?: { id: string; name: string }[];
  products: { id: string; name: string }[];
};

type FormValues = z.infer<typeof leadFormSchema>;

function toFormData(values: FormValues, extra: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ ...values, ...extra })) {
    if (value == null || value === false) continue;
    fd.set(key, String(value));
  }
  return fd;
}

function invalidClass(hasError: boolean) {
  return hasError ? "border-danger focus-visible:ring-danger/25" : undefined;
}

export function LeadForm({
  lookups,
  lead,
  tagNames = "",
}: {
  lookups: Lookup;
  lead?: Lead;
  tagNames?: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<LeadActionResult | null>(null);
  const [pending, setPending] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const addAnotherRef = useRef(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(leadFormSchema) as Resolver<FormValues>,
    mode: "onTouched",
    reValidateMode: "onChange",
    defaultValues: {
      firstName: lead?.firstName ?? "",
      lastName: lead?.lastName ?? "",
      company: lead?.company ?? "",
      email: lead?.email ?? "",
      phone: lead?.phone ?? "",
      alternatePhone: lead?.alternatePhone ?? "",
      whatsappNumber: lead?.whatsappNumber ?? "",
      website: lead?.website ?? "",
      gstNo: lead?.gstNo ?? "",
      jobTitle: lead?.jobTitle ?? "",
      address: lead?.address ?? "",
      city: lead?.city ?? "",
      state: lead?.state ?? "",
      country: lead?.country ?? "",
      postalCode: lead?.postalCode ?? "",
      industry: lead?.industry ?? "",
      companySize: lead?.companySize ?? "",
      requirement: lead?.requirement ?? "",
      productId: lead?.productId ?? "",
      expectedValue: lead?.expectedValue ? Number(lead.expectedValue) : undefined,
      budget: lead?.budget ?? "",
      purchaseTimeline: lead?.purchaseTimeline ?? "",
      sourceId: lead?.sourceId ?? lookups.sources[0]?.id ?? "",
      sourceDetail: lead?.sourceDetail ?? "",
      campaign: lead?.campaign ?? "",
      status: lead?.status,
      stageId: lead?.stageId ?? "",
      pipelineId: lead?.pipelineId ?? "",
      priority: (lead?.priority as LeadPriority) ?? "MEDIUM",
      leadScore: lead?.leadScore ?? 0,
      assignedUserId: lead?.assignedUserId ?? "",
      assignedTeamId: lead?.assignedTeamId ?? "",
      tags: tagNames,
      description: lead?.description ?? "",
      initialNote: "",
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitted },
    reset,
  } = form;

  useEffect(() => {
    if (result && !result.ok && result.code === "DUPLICATE") setDupOpen(true);
  }, [result]);

  async function submit(values: FormValues, force = false, stay = false) {
    setPending(true);
    const extra: Record<string, string> = {};
    if (lead) extra.leadId = lead.id;
    if (force) extra.forceCreate = "true";
    const action = lead ? updateLeadAction : createLeadAction;
    const next = await action(null, toFormData(values, extra));
    setResult(next);
    setPending(false);
    if (next.ok && next.leadId) {
      toast.success(lead ? "Lead updated" : "Lead created");
      if (stay && !lead) {
        reset();
        addAnotherRef.current = false;
        return;
      }
      router.push(`/leads/${next.leadId}`);
    } else if (!next.ok && next.code !== "DUPLICATE") {
      toast.error(next.error);
    }
  }

  function onInvalid() {
    toast.error("Please fix the highlighted fields before saving.");
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>("[data-invalid='true']")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  const errorCount = Object.keys(errors).length;

  return (
    <>
      <form
        noValidate
        className="grid gap-6"
        onSubmit={handleSubmit(
          (values) => submit(values, false, addAnotherRef.current),
          onInvalid,
        )}
      >
        {isSubmitted && errorCount > 0 ? (
          <div
            role="alert"
            className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
          >
            {errorCount} field{errorCount === 1 ? "" : "s"} need attention before you can
            save.
          </div>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2">
          <Field
            id="firstName"
            label="First name"
            required
            error={errors.firstName?.message}
          >
            <Input
              id="firstName"
              autoComplete="given-name"
              className={invalidClass(!!errors.firstName)}
              aria-invalid={!!errors.firstName}
              data-invalid={errors.firstName ? "true" : undefined}
              {...register("firstName")}
            />
          </Field>
          <Field id="lastName" label="Last name" error={errors.lastName?.message}>
            <Input id="lastName" autoComplete="family-name" {...register("lastName")} />
          </Field>
          <Field id="company" label="Company" error={errors.company?.message}>
            <Input id="company" autoComplete="organization" {...register("company")} />
          </Field>
          <Field id="jobTitle" label="Job title" error={errors.jobTitle?.message}>
            <Input id="jobTitle" autoComplete="organization-title" {...register("jobTitle")} />
          </Field>
          <Field id="gstNo" label="GST No" error={errors.gstNo?.message}>
            <Input
              id="gstNo"
              placeholder="22AAAAA0000A1Z5"
              className={invalidClass(!!errors.gstNo)}
              aria-invalid={!!errors.gstNo}
              {...register("gstNo")}
            />
          </Field>
          <Field id="email" label="Email" error={errors.email?.message}>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="name@company.com"
              className={invalidClass(!!errors.email)}
              aria-invalid={!!errors.email}
              data-invalid={errors.email ? "true" : undefined}
              {...register("email")}
            />
          </Field>
          <Field id="phone" label="Phone" required error={errors.phone?.message}>
            <Input
              id="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+91 98765 43210"
              className={invalidClass(!!errors.phone)}
              aria-invalid={!!errors.phone}
              data-invalid={errors.phone ? "true" : undefined}
              {...register("phone")}
            />
          </Field>
          <Field id="whatsappNumber" label="WhatsApp" error={errors.whatsappNumber?.message}>
            <Input
              id="whatsappNumber"
              type="tel"
              placeholder="+91 98765 43210"
              className={invalidClass(!!errors.whatsappNumber)}
              aria-invalid={!!errors.whatsappNumber}
              {...register("whatsappNumber")}
            />
          </Field>
          <Field id="city" label="City" error={errors.city?.message}>
            <Input id="city" autoComplete="address-level2" {...register("city")} />
          </Field>
          <Field id="address" label="Address" className="sm:col-span-2" error={errors.address?.message}>
            <Textarea
              id="address"
              rows={2}
              autoComplete="street-address"
              placeholder="Street, building, area"
              className={invalidClass(!!errors.address)}
              aria-invalid={!!errors.address}
              {...register("address")}
            />
          </Field>
          <Field id="country" label="Country" error={errors.country?.message}>
            <Input id="country" autoComplete="country-name" {...register("country")} />
          </Field>
          <Field id="expectedValue" label="Expected value" error={errors.expectedValue?.message}>
            <Input
              id="expectedValue"
              type="number"
              min="0"
              step="0.01"
              className={invalidClass(!!errors.expectedValue)}
              aria-invalid={!!errors.expectedValue}
              {...register("expectedValue")}
            />
          </Field>
          <Field id="productId" label="Interested in" error={errors.productId?.message}>
            <Select id="productId" {...register("productId")}>
              <option value="">Select product</option>
              {lookups.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {lookups.products.length === 0 ? (
              <p className="mt-1 text-2xs text-muted">
                No products yet.{" "}
                <Link href="/settings/lead-products" className="text-primary underline-offset-2 hover:underline">
                  Add products in settings
                </Link>
              </p>
            ) : null}
          </Field>
          <Field id="sourceId" label="Source" required error={errors.sourceId?.message}>
            <Select
              id="sourceId"
              className={invalidClass(!!errors.sourceId)}
              aria-invalid={!!errors.sourceId}
              data-invalid={errors.sourceId ? "true" : undefined}
              {...register("sourceId")}
            >
              <option value="">Select source</option>
              {lookups.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="stageId" label="Stage" error={errors.stageId?.message}>
            <Select id="stageId" {...register("stageId")}>
              <option value="">Select stage</option>
              {lookups.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="priority" label="Priority" error={errors.priority?.message}>
            <Select id="priority" {...register("priority")}>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </Select>
          </Field>
          <Field id="assignedUserId" label="Assigned to" error={errors.assignedUserId?.message}>
            <Select id="assignedUserId" {...register("assignedUserId")}>
              <option value="">Unassigned</option>
              {lookups.members.map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.user.name ?? m.user.email}
                </option>
              ))}
            </Select>
          </Field>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <h2 className="sm:col-span-2 text-sm font-semibold text-muted">Additional details</h2>
          <Field id="alternatePhone" label="Alternate phone" error={errors.alternatePhone?.message}>
            <Input
              id="alternatePhone"
              type="tel"
              className={invalidClass(!!errors.alternatePhone)}
              aria-invalid={!!errors.alternatePhone}
              {...register("alternatePhone")}
            />
          </Field>
          <Field id="website" label="Website" error={errors.website?.message}>
            <Input
              id="website"
              type="url"
              placeholder="https://example.com"
              className={invalidClass(!!errors.website)}
              aria-invalid={!!errors.website}
              {...register("website")}
            />
          </Field>
          <Field id="state" label="State" error={errors.state?.message}>
            <Input id="state" autoComplete="address-level1" {...register("state")} />
          </Field>
          <Field id="postalCode" label="Postal code" error={errors.postalCode?.message}>
            <Input id="postalCode" autoComplete="postal-code" {...register("postalCode")} />
          </Field>
          <Field id="industry" label="Industry" error={errors.industry?.message}>
            <Input id="industry" {...register("industry")} />
          </Field>
          <Field id="companySize" label="Company size" error={errors.companySize?.message}>
            <Input id="companySize" {...register("companySize")} />
          </Field>
          <Field id="budget" label="Budget" error={errors.budget?.message}>
            <Input id="budget" {...register("budget")} />
          </Field>
          <Field id="purchaseTimeline" label="Purchase timeline" error={errors.purchaseTimeline?.message}>
            <Input id="purchaseTimeline" {...register("purchaseTimeline")} />
          </Field>
          <Field id="sourceDetail" label="Source detail" error={errors.sourceDetail?.message}>
            <Input id="sourceDetail" {...register("sourceDetail")} />
          </Field>
          <Field id="campaign" label="Campaign" error={errors.campaign?.message}>
            <Input id="campaign" {...register("campaign")} />
          </Field>
          <Field id="leadScore" label="Lead score" error={errors.leadScore?.message}>
            <Input
              id="leadScore"
              type="number"
              min="0"
              max="100"
              className={invalidClass(!!errors.leadScore)}
              aria-invalid={!!errors.leadScore}
              {...register("leadScore")}
            />
          </Field>
          <Field id="assignedTeamId" label="Team" error={errors.assignedTeamId?.message}>
            <Select id="assignedTeamId" {...register("assignedTeamId")}>
              <option value="">No team</option>
              {(lookups.teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id="tags"
            label="Tags (comma separated)"
            className="sm:col-span-2"
            error={errors.tags?.message}
          >
            <Input id="tags" placeholder="hot, enterprise" {...register("tags")} />
          </Field>
          <Field id="requirement" label="Requirement" className="sm:col-span-2" error={errors.requirement?.message}>
            <Textarea
              id="requirement"
              rows={3}
              className={invalidClass(!!errors.requirement)}
              aria-invalid={!!errors.requirement}
              {...register("requirement")}
            />
          </Field>
        </section>

        <section className="grid gap-4">
          <h2 className="text-sm font-semibold">Notes</h2>
          <Field id="description" label="Description" error={errors.description?.message}>
            <Textarea
              id="description"
              rows={4}
              className={invalidClass(!!errors.description)}
              aria-invalid={!!errors.description}
              {...register("description")}
            />
          </Field>
          {!lead ? (
            <Field id="initialNote" label="Initial note" error={errors.initialNote?.message}>
              <Textarea id="initialNote" rows={3} {...register("initialNote")} />
            </Field>
          ) : null}
        </section>

        {result && !result.ok && result.code !== "DUPLICATE" ? (
          <p className="text-sm text-danger" role="alert">
            {result.error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={pending}
            onClick={() => {
              addAnotherRef.current = false;
            }}
          >
            {pending ? "Saving…" : lead ? "Save lead" : "Create"}
          </Button>
          {!lead ? (
            <Button
              type="submit"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                addAnotherRef.current = true;
              }}
            >
              Create & Add Another
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => router.push("/leads")}>
            Cancel
          </Button>
        </div>
      </form>

      <Dialog open={dupOpen} onOpenChange={setDupOpen}>
        <DialogContent>
          <DialogTitle>Possible duplicates</DialogTitle>
          <DialogDescription>
            {result && !result.ok ? result.error : "A similar lead already exists."}
          </DialogDescription>
          <ul className="mt-3 space-y-2 text-sm">
            {result && !result.ok && result.duplicates?.map((d) => (
              <li key={d.id} className="rounded-xl bg-[var(--ic-surface-muted)] px-3 py-2">
                {d.fullName} ({d.matchedOn.join(", ")})
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {result && !result.ok && result.duplicates?.[0] ? (
              <Button
                variant="secondary"
                onClick={() => router.push(`/leads/${result.duplicates![0].id}`)}
              >
                View
              </Button>
            ) : null}
            <Button
              onClick={() => {
                setDupOpen(false);
                void handleSubmit(
                  (values) => submit(values, true, addAnotherRef.current),
                  onInvalid,
                )();
              }}
            >
              Create anyway
            </Button>
            <Button variant="ghost" onClick={() => setDupOpen(false)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({
  id,
  label,
  required,
  error,
  className,
  children,
}: {
  id?: string;
  label: string;
  required?: boolean;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <Label htmlFor={id} className="flex items-center gap-1">
        {label}
        {required ? <span className="text-danger" aria-hidden="true">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="mt-1 text-2xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
