import { prisma } from "@/lib/db/prisma";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export const stockedProducts = (organizationId: string) =>
  // ponytail: first 500 active stocked goods; a search combobox when catalogs outgrow it
  prisma.product.findMany({
    where: { organizationId, status: "ACTIVE", type: "GOODS", trackInventory: true },
    select: { id: true, sku: true, name: true },
    orderBy: { name: "asc" },
    take: 500,
  });

type Line = { componentId: string; quantity: string; scrapPercent: string };

/** Fixed component rows for ApiForm (`lines.N.*`); rows left without a component are ignored by the API. */
export function BomLineRows({ products, initial = [], rows = 8 }: { products: { id: string; sku: string; name: string }[]; initial?: Line[]; rows?: number }) {
  const count = Math.max(rows, initial.length + 2);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_120px_120px] gap-2 text-2xs uppercase tracking-wide text-subtle">
        <span>Component</span><span>Quantity</span><span>Scrap %</span>
      </div>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="grid grid-cols-[1fr_120px_120px] gap-2">
          <Select name={`lines.${i}.componentId`} defaultValue={initial[i]?.componentId ?? ""} aria-label={`Component ${i + 1}`}>
            <option value="">—</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
          </Select>
          <Input name={`lines.${i}.quantity`} type="number" min="0.0001" step="any" defaultValue={initial[i]?.quantity} aria-label={`Quantity ${i + 1}`} />
          <Input name={`lines.${i}.scrapPercent`} type="number" min="0" max="99.99" step="0.01" defaultValue={initial[i]?.scrapPercent} aria-label={`Scrap ${i + 1}`} />
        </div>
      ))}
    </div>
  );
}
