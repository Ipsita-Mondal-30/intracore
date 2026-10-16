import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { getAccessContext } from "@/lib/access";
import { isIntraState } from "@/lib/money";
import { getSalesOrder } from "@/features/sales/orders";
import { formatDate, formatMoney, formatQty, humanize } from "@/components/erp/format";
import { PrintButton } from "../../print-button";

type Amount = { toString(): string };
const num = (v: Amount) => Number(v.toString());
const amt = (v: Amount) => num(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum = <T,>(rows: T[], pick: (r: T) => Amount) => rows.reduce((s, r) => s + num(pick(r)), 0);

export default async function PrintOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const doc = await getSalesOrder(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const { company, branch, customer, lines, currency } = doc;
  const intra = isIntraState(branch.stateCode ?? company.stateCode, doc.placeOfSupplyState);
  const taxCols = intra ? (["CGST", "SGST"] as const) : (["IGST"] as const);
  const taxAmount = (l: (typeof lines)[number], col: "CGST" | "SGST" | "IGST") => (col === "CGST" ? l.cgstAmount : col === "SGST" ? l.sgstAmount : l.igstAmount);
  const taxRate = (l: (typeof lines)[number]) => (intra ? num(l.taxRate) / 2 : num(l.taxRate));
  const totals: [string, Amount][] = [
    ["Subtotal", doc.subtotal],
    ["Discount", doc.discountTotal],
    ["Taxable value", doc.taxableTotal],
    ...taxCols.map((c): [string, Amount] => [c, sum(lines, (l) => taxAmount(l, c))]),
  ];

  return (
    <article className="space-y-6">
      <div className="flex justify-end print:hidden"><PrintButton /></div>

      <header className="flex items-start justify-between gap-6 border-b-2 border-slate-900 pb-4">
        <div>
          <p className="text-lg font-bold">{company.legalName ?? company.name}</p>
          {company.legalName && company.legalName !== company.name ? <p>{company.name}</p> : null}
          {company.address ? <p className="whitespace-pre-line text-slate-600">{company.address}</p> : null}
          <p className="text-slate-600">Branch: {branch.name}{branch.address ? `, ${branch.address}` : ""}</p>
          <p>GSTIN: <strong>{branch.gstin ?? company.gstin ?? "—"}</strong>{company.pan ? ` · PAN: ${company.pan}` : ""}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tracking-wide">SALES ORDER</p>
          <p className="font-semibold">{doc.number}</p>
          {doc.status !== "CONFIRMED" ? <p className="font-semibold uppercase text-red-700">{humanize(doc.status)}</p> : null}
        </div>
      </header>

      <section className="grid grid-cols-3 gap-6">
        <div className="col-span-2 grid grid-cols-2 gap-6">
          <div>
            <p className="text-2xs font-semibold uppercase text-slate-500">Bill to</p>
            <p className="font-semibold">{customer.legalName ?? customer.name}</p>
            {customer.billingAddress ? <p className="whitespace-pre-line">{customer.billingAddress}</p> : null}
            <p>GSTIN: {customer.gstin ?? "Unregistered"}</p>
            {doc.contact ? <p>Attn: {doc.contact.fullName}</p> : null}
          </div>
          <div>
            <p className="text-2xs font-semibold uppercase text-slate-500">Ship to</p>
            <p className="whitespace-pre-line">{doc.shippingAddress ?? customer.shippingAddress ?? customer.billingAddress ?? "—"}</p>
            {doc.deliveryInstructions ? <p className="mt-1 whitespace-pre-line text-slate-600">{doc.deliveryInstructions}</p> : null}
          </div>
        </div>
        <dl className="space-y-0.5">
          {([
            ["Order date", formatDate(doc.orderDate)],
            ["Expected delivery", formatDate(doc.expectedDeliveryDate)],
            ["Customer PO", doc.customerPoNumber ?? "—"],
            ["Quotation", doc.quotation ? `${doc.quotation.number}${doc.quotation.revision > 1 ? ` R${doc.quotation.revision}` : ""}` : "—"],
            ["Place of supply", doc.placeOfSupplyState ?? "—"],
            ["Currency", currency],
          ] as const).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium">{v}</dd></div>
          ))}
        </dl>
      </section>

      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-y border-slate-900 text-left">
            <th className="py-1.5 pr-1">#</th>
            <th className="py-1.5 pr-1">Item</th>
            <th className="py-1.5 pr-1">HSN/SAC</th>
            <th className="py-1.5 pr-1 text-right">Qty</th>
            <th className="py-1.5 pr-1">UoM</th>
            <th className="py-1.5 pr-1 text-right">Rate</th>
            <th className="py-1.5 pr-1 text-right">Disc %</th>
            <th className="py-1.5 pr-1 text-right">Taxable</th>
            {taxCols.map((c) => <th key={c} className="py-1.5 pr-1 text-right">{c}</th>)}
            <th className="py-1.5 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id} className="break-inside-avoid border-b border-slate-200 align-top">
              <td className="py-1.5 pr-1">{i + 1}</td>
              <td className="py-1.5 pr-1">{l.description}{l.product ? <span className="block text-2xs text-slate-500">{l.product.sku}</span> : null}</td>
              <td className="py-1.5 pr-1">{l.product?.hsnCode ?? "—"}</td>
              <td className="py-1.5 pr-1 text-right">{formatQty(l.quantity)}</td>
              <td className="py-1.5 pr-1">{l.uom?.code ?? ""}</td>
              <td className="py-1.5 pr-1 text-right">{amt(l.unitPrice)}</td>
              <td className="py-1.5 pr-1 text-right">{formatQty(l.discountPercent)}</td>
              <td className="py-1.5 pr-1 text-right">{amt(l.taxableAmount)}</td>
              {taxCols.map((c) => (
                <td key={c} className="py-1.5 pr-1 text-right">
                  {amt(taxAmount(l, c))}<span className="block text-2xs text-slate-500">@{formatQty(taxRate(l))}%</span>
                </td>
              ))}
              <td className="py-1.5 text-right font-medium">{amt(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="flex justify-end">
        <dl className="w-72 space-y-0.5">
          {totals.map(([k, v]) => (
            <div key={k} className="flex justify-between"><dt className="text-slate-500">{k}</dt><dd>{amt(v)}</dd></div>
          ))}
          <div className="flex justify-between border-t-2 border-slate-900 pt-1 text-base font-bold">
            <dt>Grand total</dt><dd>{formatMoney(doc.grandTotal, currency)}</dd>
          </div>
        </dl>
      </section>

      {doc.notes ? (
        <section className="break-inside-avoid">
          <p className="text-2xs font-semibold uppercase text-slate-500">Notes</p>
          <p className="whitespace-pre-line">{doc.notes}</p>
        </section>
      ) : null}

      <footer className="flex break-inside-avoid justify-end pt-10">
        <div className="text-center">
          <p>For {company.legalName ?? company.name}</p>
          <p className="mt-12 border-t border-slate-400 pt-1 text-slate-500">Authorised signatory</p>
        </div>
      </footer>
    </article>
  );
}
