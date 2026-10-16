import { z } from "zod";
import { RecordStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";

const text = (max: number) => z.string().trim().max(max);
const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().or(z.literal("").transform(() => null));

const vendorSchema = z.object({
  code: nullable(text(32)),
  name: text(200).min(1),
  legalName: nullable(text(200)),
  email: nullable(z.string().trim().toLowerCase().email()),
  phone: nullable(text(40)),
  gstin: nullable(
    z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN"),
  ),
  pan: nullable(text(10)),
  stateCode: nullable(z.string().regex(/^[0-9]{2}$/, "State code is two digits")),
  address: nullable(text(500)),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).nullish(),
  notes: nullable(text(4000)),
});

const listSchema = listQuerySchema.extend({ status: z.nativeEnum(RecordStatus).optional() });

export async function listVendors(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "vendor.view");
  const q = listSchema.parse(query);
  const where: Prisma.VendorWhereInput = {
    organizationId: ctx.organizationId,
    status: q.status ?? { not: RecordStatus.ARCHIVED },
    ...searchWhere(q.q, ["name", "legalName", "email", "phone", "gstin", "code"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.vendor.findMany({ where, include: { _count: { select: { purchaseOrders: true } } }, ...listArgs(q, ["createdAt", "name"], "name") }),
      prisma.vendor.count({ where }),
    ]),
  );
}

export async function getVendor(ctx: AccessContext, id: string) {
  assertCan(ctx, "vendor.view");
  const vendor = await prisma.vendor.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { contacts: { where: { status: { not: RecordStatus.ARCHIVED } }, orderBy: { fullName: "asc" } } },
  });
  if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found", 404);
  return vendor;
}

export async function createVendor(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "vendor.create");
  const data = vendorSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.create({ data: { ...data, organizationId: ctx.organizationId, createdById: ctx.userId } });
    await audit(tx, ctx, { action: "vendor.created", entity: "vendor", entityId: vendor.id, next: vendor });
    return vendor;
  });
}

export async function updateVendor(ctx: AccessContext, id: string, input: unknown) {
  const data = vendorSchema.partial().extend({ status: z.nativeEnum(RecordStatus).optional() }).parse(input);
  assertCan(ctx, data.status === RecordStatus.ARCHIVED ? "vendor.delete" : "vendor.update");
  return prisma.$transaction(async (tx) => {
    const before = await tx.vendor.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Vendor not found", 404);
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const vendor = await tx.vendor.update({ where: { id }, data });
    await audit(tx, ctx, { action: "vendor.updated", entity: "vendor", entityId: id, previous: diff.previous, next: diff.next });
    return vendor;
  });
}
