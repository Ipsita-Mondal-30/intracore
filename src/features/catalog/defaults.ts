import type { Prisma } from "@prisma/client";

/** Keep in sync with the seed in prisma/migrations/20261016110000_crm_and_sales. */
export const DEFAULT_UOMS = [
  ["NOS", "Numbers"],
  ["KG", "Kilogram"],
  ["LTR", "Litre"],
  ["MTR", "Metre"],
  ["BOX", "Box"],
  ["HRS", "Hours"],
] as const;

export const DEFAULT_TAX_RATES = [0, 5, 12, 18, 28];

export async function seedCatalogDefaults(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.uom.createMany({
    data: DEFAULT_UOMS.map(([code, name]) => ({ organizationId, code, name })),
    skipDuplicates: true,
  });
  for (const rate of DEFAULT_TAX_RATES) {
    const name = `GST ${rate}%`;
    if (await tx.taxRate.findUnique({ where: { organizationId_name: { organizationId, name } } })) continue;
    await tx.taxRate.create({
      data: {
        organizationId,
        name,
        rate,
        versions: { create: { rate, effectiveFrom: new Date("2017-07-01T00:00:00.000Z") } },
      },
    });
  }
}
