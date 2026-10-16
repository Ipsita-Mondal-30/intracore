"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Inquiry, InquiryStatus, LeadPriority } from "@prisma/client";
import { toast } from "sonner";
import type { z } from "zod";
import {
  createInquiryAction,
  updateInquiryAction,
  type InquiryActionResult,
} from "@/features/inquiries/actions";
import { inquiryFormSchema } from "@/lib/validations/inquiries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Lookup = {
  members: { user: { id: string; name: string | null; email: string } }[];
  recentLeads: { id: string; fullName: string; email: string | null }[];
};

type FormValues = z.infer<typeof inquiryFormSchema>;

function toFormData(values: FormValues, extra: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ ...values, ...extra })) {
    if (value == null) continue;
    fd.set(key, String(value));
  }
  return fd;
}

function invalidClass(hasError: boolean) {
  return hasError ? "border-danger focus-visible:ring-danger/25" : undefined;
}

export function InquiryForm({
  lookups,
  inquiry,
}: {
  lookups: Lookup;
  inquiry?: Inquiry;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(inquiryFormSchema) as Resolver<FormValues>,
    mode: "onTouched",
    defaultValues: {
      subject: inquiry?.subject ?? "",
      description: inquiry?.description ?? "",
      contactName: inquiry?.contactName ?? "",
      email: inquiry?.email ?? "",
      phone: inquiry?.phone ?? "",
      status: (inquiry?.status as InquiryStatus) ?? "OPEN",
      priority: (inquiry?.priority as LeadPriority) ?? "MEDIUM",
      assignedUserId: inquiry?.assignedUserId ?? "",
      linkedLeadId: inquiry?.linkedLeadId ?? "",
      source: inquiry?.source ?? "",
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = form;

  async function submit(values: FormValues) {
    setPending(true);
    const extra: Record<string, string> = {};
    if (inquiry) extra.inquiryId = inquiry.id;
    const action = inquiry ? updateInquiryAction : createInquiryAction;
    const result: InquiryActionResult = await action(null, toFormData(values, extra));
    setPending(false);

    if (result.ok && result.inquiryId) {
      toast.success(inquiry ? "Inquiry updated" : "Inquiry created");
      router.push(`/leads/inquiries/${result.inquiryId}`);
      router.refresh();
      return;
    }
    if (!result.ok) {
      toast.error(result.error);
    }
  }

  function onInvalid() {
    toast.error("Please fix the highlighted fields before saving.");
  }

  return (
    <form
      className="space-y-6"
      onSubmit={handleSubmit(submit, onInvalid)}
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2" data-invalid={errors.subject ? "true" : undefined}>
          <Label htmlFor="subject">Subject</Label>
          <Input
            id="subject"
            className={invalidClass(!!errors.subject)}
            {...register("subject")}
          />
          {errors.subject ? (
            <p className="mt-1 text-xs text-danger">{errors.subject.message}</p>
          ) : null}
        </div>

        <div data-invalid={errors.contactName ? "true" : undefined}>
          <Label htmlFor="contactName">Contact name</Label>
          <Input
            id="contactName"
            className={invalidClass(!!errors.contactName)}
            {...register("contactName")}
          />
          {errors.contactName ? (
            <p className="mt-1 text-xs text-danger">{errors.contactName.message}</p>
          ) : null}
        </div>

        <div>
          <Label htmlFor="source">Source</Label>
          <Input id="source" placeholder="Website, phone, referral…" {...register("source")} />
        </div>

        <div data-invalid={errors.email ? "true" : undefined}>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            className={invalidClass(!!errors.email)}
            {...register("email")}
          />
          {errors.email ? (
            <p className="mt-1 text-xs text-danger">{errors.email.message}</p>
          ) : null}
        </div>

        <div data-invalid={errors.phone ? "true" : undefined}>
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            className={invalidClass(!!errors.phone)}
            {...register("phone")}
          />
          {errors.phone ? (
            <p className="mt-1 text-xs text-danger">{errors.phone.message}</p>
          ) : null}
        </div>

        <div>
          <Label htmlFor="status">Status</Label>
          <Select id="status" {...register("status")}>
            <option value="OPEN">Open</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="RESOLVED">Resolved</option>
            <option value="CLOSED">Closed</option>
          </Select>
        </div>

        <div>
          <Label htmlFor="priority">Priority</Label>
          <Select id="priority" {...register("priority")}>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </Select>
        </div>

        <div>
          <Label htmlFor="assignedUserId">Assigned to</Label>
          <Select id="assignedUserId" {...register("assignedUserId")}>
            <option value="">Unassigned</option>
            {lookups.members.map((member) => (
              <option key={member.user.id} value={member.user.id}>
                {member.user.name ?? member.user.email}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="linkedLeadId">Linked lead (optional)</Label>
          <Select id="linkedLeadId" {...register("linkedLeadId")}>
            <option value="">None</option>
            {lookups.recentLeads.map((lead) => (
              <option key={lead.id} value={lead.id}>
                {lead.fullName}
                {lead.email ? ` (${lead.email})` : ""}
              </option>
            ))}
          </Select>
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            rows={4}
            placeholder="Details about the inquiry…"
            {...register("description")}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : inquiry ? "Save changes" : "Create inquiry"}
        </Button>
        <Link
          href={inquiry ? `/leads/inquiries/${inquiry.id}` : "/leads/inquiries"}
          className="inline-flex h-10 items-center justify-center rounded-xl border border-[var(--ic-border)] bg-surface px-4 text-sm font-medium hover:bg-[var(--ic-surface-muted)]"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
