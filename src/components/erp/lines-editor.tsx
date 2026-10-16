"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

export type ProductOption = {
  id: string;
  sku: string;
  name: string;
  price: string;
  taxRateId: string | null;
};
export type TaxOption = { id: string; name: string; rate: string };
export type LineValue = {
  productId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRateId: string;
};

const blank: LineValue = { productId: "", description: "", quantity: "1", unitPrice: "", discountPercent: "", taxRateId: "" };

/**
 * Editable document lines rendered inside an ApiForm; submitted as JSON in `lines`.
 * Blank price/tax fall back on the server (customer price, product price, product tax);
 * the totals shown here are an estimate — the server computes the real amounts.
 */
export function LinesEditor({
  products,
  taxRates,
  initial = [],
  showDiscount = true,
}: {
  products: ProductOption[];
  taxRates: TaxOption[];
  initial?: LineValue[];
  showDiscount?: boolean;
}) {
  const [lines, setLines] = useState<LineValue[]>(initial.length ? initial : [blank]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const update = (i: number, patch: Partial<LineValue>) =>
    setLines((current) => current.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const payload = lines
    .filter((l) => l.productId || l.description)
    .map((l) => ({
      productId: l.productId || null,
      description: l.description || null,
      quantity: l.quantity,
      ...(l.unitPrice ? { unitPrice: l.unitPrice } : {}),
      ...(l.discountPercent ? { discountPercent: l.discountPercent } : {}),
      ...(l.taxRateId ? { taxRateId: l.taxRateId === "none" ? null : l.taxRateId } : {}),
    }));

  const estimate = lines.reduce((sum, l) => {
    const price = Number(l.unitPrice || byId.get(l.productId)?.price || 0);
    const taxId = l.taxRateId || byId.get(l.productId)?.taxRateId || "";
    const rate = Number(taxRates.find((t) => t.id === taxId)?.rate ?? 0);
    const taxable = Number(l.quantity || 0) * price * (1 - Number(l.discountPercent || 0) / 100);
    return sum + taxable * (1 + rate / 100);
  }, 0);

  return (
    <div className="space-y-2">
      <input type="hidden" name="lines" data-json value={JSON.stringify(payload)} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
            <tr>
              <th className="py-1 pr-2">Product</th>
              <th className="py-1 pr-2">Description</th>
              <th className="w-24 py-1 pr-2">Qty</th>
              <th className="w-32 py-1 pr-2">Unit price</th>
              {showDiscount ? <th className="w-20 py-1 pr-2">Disc %</th> : null}
              <th className="w-36 py-1 pr-2">Tax</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const product = byId.get(line.productId);
              return (
                <tr key={i} className="align-top">
                  <td className="py-1 pr-2">
                    <Select value={line.productId} onChange={(e) => update(i, { productId: e.target.value })} aria-label="Product">
                      <option value="">Free text…</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} · {p.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-1 pr-2">
                    <Input value={line.description} placeholder={product?.name ?? "Description"} onChange={(e) => update(i, { description: e.target.value })} />
                  </td>
                  <td className="py-1 pr-2">
                    <Input type="number" min="0" step="any" value={line.quantity} onChange={(e) => update(i, { quantity: e.target.value })} />
                  </td>
                  <td className="py-1 pr-2">
                    <Input type="number" min="0" step="0.01" value={line.unitPrice} placeholder={product ? product.price : "0.00"} onChange={(e) => update(i, { unitPrice: e.target.value })} />
                  </td>
                  {showDiscount ? (
                    <td className="py-1 pr-2">
                      <Input type="number" min="0" max="100" step="0.01" value={line.discountPercent} placeholder="0" onChange={(e) => update(i, { discountPercent: e.target.value })} />
                    </td>
                  ) : null}
                  <td className="py-1 pr-2">
                    <Select value={line.taxRateId} onChange={(e) => update(i, { taxRateId: e.target.value })} aria-label="Tax">
                      <option value="">{product ? "Product default" : "No tax"}</option>
                      <option value="none">No tax</option>
                      {taxRates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-1">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setLines((c) => c.filter((_, j) => j !== i))} aria-label="Remove line">
                      ×
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <Button type="button" variant="secondary" size="sm" onClick={() => setLines((c) => [...c, blank])}>
          Add line
        </Button>
        <span className="text-xs text-muted">
          Estimated total (incl. tax): {estimate.toLocaleString("en-IN", { maximumFractionDigits: 2 })} — final amounts are computed on save
        </span>
      </div>
    </div>
  );
}
