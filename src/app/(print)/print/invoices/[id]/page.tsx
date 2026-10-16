import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { getAccessContext } from "@/lib/access";
import { isIntraState } from "@/lib/money";
import { GST_STATES } from "@/lib/gst";
import { getInvoice } from "@/features/finance/receivables";
import { formatDate, formatMoney, formatQty, humanize } from "@/components/erp/format";
import { PrintButton } from "../../print-button";

type Amount = { toString(): string };
const num = (v: Amount) => Number(v.toString());
const amt = (v: Amount) => num(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function PrintInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const doc = await getInvoice(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const { company, branch, customer, lines, currency } = doc;
  const pos = doc.placeOfSupplyState;
  const intra = num(doc.igstTotal) > 0 ? false : isIntraState(branch.stateCode ?? company.stateCode, pos);
  const taxCols = intra ? (["CGST", "SGST"] as const) : (["IGST"] as const);
  const taxAmount = (l: (typeof lines)[number], col: "CGST" | "SGST" | "IGST") => (col === "CGST" ? l.cgstAmount : col === "SGST" ? l.sgstAmount : l.igstAmount);
  const taxRate = (l: (typeof lines)[number]) => (intra ? num(l.taxRate) / 2 : num(l.taxRate));
  const totals: [string, Amount][] = [
    ["Subtotal", doc.subtotal],
    ["Discount", doc.discountTotal],
    ["Taxable value", doc.taxableTotal],
    ...taxCols.map((c): [string, Amount] => [c, c === "CGST" ? doc.cgstTotal : c === "SGST" ? doc.sgstTotal : doc.igstTotal]),
  ];

  return (
    <article className="space-y-6">
      <div className="flex justify-end print:hidden"><PrintButton /></div>

      {doc.status !== "POSTED" ? (
        <p className="border-2 border-red-700 py-2 text-center font-bold uppercase text-red-700">
          {doc.status === "CANCELLED" ? "Cancelled" : "Draft"} — not a valid tax invoice
        </p>
      ) : null}

      <header className="flex items-start justify-between gap-6 border-b-2 border-slate-900 pb-4">
        <div>
          <p className="text-lg font-bold">{company.legalName ?? company.name}</p>
          {company.legalName && company.legalName !== company.name ? <p>{company.name}</p> : null}
          {company.address ? <p className="whitespace-pre-line text-slate-600">{company.address}</p> : null}
          <p className="text-slate-600">Branch: {branch.name}{branch.address ? `, ${branch.address}` : ""}</p>
          <p>GSTIN: <strong>{doc.sellerGstin ?? "—"}</strong>{company.pan ? ` · PAN: ${company.pan}` : ""}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tracking-wide">TAX INVOICE</p>
          <p className="font-semibold">{doc.number ?? "Draft"}</p>
          {doc.status !== "POSTED" ? <p className="font-semibold uppercase text-red-700">{humanize(doc.status)}</p> : null}
          {doc.irn ? <p className="break-all text-2xs text-slate-600">IRN: {doc.irn}</p> : null}
        </div>
      </header>

      <section className="grid grid-cols-3 gap-6">
        <div className="col-span-2 grid grid-cols-2 gap-6">
          <div>
            <p className="text-2xs font-semibold uppercase text-slate-500">Bill to</p>
            <p className="font-semibold">{customer.legalName ?? customer.name}</p>
            {doc.billingAddress ? <p className="whitespace-pre-line">{doc.billingAddress}</p> : null}
            <p>GSTIN: {doc.customerGstin ?? "Unregistered"}</p>
          </div>
          <div>
            <p className="text-2xs font-semibold uppercase text-slate-500">Ship to</p>
            <p className="whitespace-pre-line">{doc.shippingAddress ?? doc.billingAddress ?? "—"}</p>
          </div>
        </div>
        <dl className="space-y-0.5">
          {([
            ["Invoice date", formatDate(doc.invoiceDate)],
            ["Due date", formatDate(doc.dueDate)],
            ["Place of supply", pos ? `${pos} – ${GST_STATES[pos] ?? "?"}` : "—"],
            ["Reverse charge", doc.reverseCharge ? "Yes" : "No"],
            ...(doc.salesOrder ? [["Order ref.", doc.salesOrder.number] as const] : []),
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
              <td className="py-1.5 pr-1">{l.hsnCode ?? "—"}</td>
              <td className="py-1.5 pr-1 text-right">{formatQty(l.quantity)}</td>
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
            <dt>Invoice total</dt><dd>{formatMoney(doc.grandTotal, currency)}</dd>
          </div>
          {doc.status === "POSTED" && num(doc.grandTotal) !== num(doc.outstanding) ? (
            <div className="flex justify-between"><dt className="text-slate-500">Balance due</dt><dd>{formatMoney(doc.outstanding, currency)}</dd></div>
          ) : null}
        </dl>
      </section>

      {doc.terms ? (
        <section className="break-inside-avoid">
          <p className="text-2xs font-semibold uppercase text-slate-500">Terms & conditions</p>
          <p className="whitespace-pre-line">{doc.terms}</p>
        </section>
      ) : null}

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
