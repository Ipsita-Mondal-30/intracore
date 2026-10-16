import { listAssets, listContracts, listServiceHistory } from "@/features/portal/customer";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";
import { pagePortal, PortalHeader, salesKind, Section } from "@/app/portal/_components/portal-page";
import { portalTitle, salesLinks } from "../nav";

export default async function PortalService({ params }: { params: Promise<{ portal: string }> }) {
  const { portal } = await params;
  const p = await pagePortal(salesKind(portal));
  const [assets, contracts, history] = await Promise.all([listAssets(p), listContracts(p), listServiceHistory(p)]);
  return (
    <div>
      <PortalHeader title={portalTitle(portal)} organization={p.organizationName} links={salesLinks(portal)} />
      <Section title="Equipment and warranty">
        <RecordsTable columns={[{ key: "t", label: "Asset" }, { key: "s", label: "Serial" }, { key: "i", label: "Installed" }, { key: "w", label: "Warranty" }]} empty="No registered equipment.">
          {assets.length
            ? assets.map((a) => (
                <RecordsTableRow key={a.id}>
                  <RecordsTableCell><span className="font-medium">{a.tag}</span> · {a.name}</RecordsTableCell>
                  <RecordsTableCell>{a.serialNumber ?? "—"}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(a.installDate)}</RecordsTableCell>
                  <RecordsTableCell className="text-xs">
                    {a.warranties.length ? a.warranties.map((w) => `${humanize(w.type)} to ${formatDate(w.endDate)}`).join(", ") : "—"}
                    {a.underWarranty ? <span className="ml-2 font-semibold text-success">Covered</span> : null}
                  </RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Maintenance contracts">
        <RecordsTable columns={[{ key: "n", label: "Contract" }, { key: "s", label: "Status" }, { key: "p", label: "Period" }, { key: "v", label: "Value" }, { key: "e", label: "Entitlements" }]} empty="No contracts.">
          {contracts.length
            ? contracts.map((c) => (
                <RecordsTableRow key={c.id}>
                  <RecordsTableCell className="font-medium">{c.number}</RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={c.status} /></RecordsTableCell>
                  <RecordsTableCell>{formatDate(c.startDate)} – {formatDate(c.endDate)}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(c.value)}</RecordsTableCell>
                  <RecordsTableCell className="text-xs">{c.entitlements.map((e) => `${humanize(e.serviceType)} ${e.usedCount}/${e.quantity ?? "∞"}`).join(", ") || "—"}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Service history">
        <RecordsTable columns={[{ key: "d", label: "Completed" }, { key: "t", label: "Type" }, { key: "a", label: "Equipment / ticket" }, { key: "w", label: "Work done" }]} empty="No completed visits yet.">
          {history.length
            ? history.map((v) => (
                <RecordsTableRow key={v.id}>
                  <RecordsTableCell>{formatDate(v.completedAt)}</RecordsTableCell>
                  <RecordsTableCell>{v.serviceType ? humanize(v.serviceType) : "Visit"}</RecordsTableCell>
                  <RecordsTableCell className="text-xs">{[v.asset && `${v.asset.tag} · ${v.asset.name}`, v.ticket?.number, v.contract?.number].filter(Boolean).join(" · ") || "—"}</RecordsTableCell>
                  <RecordsTableCell className="text-xs">{v.workDone ?? "—"}{v.customerSignedBy ? ` (signed: ${v.customerSignedBy})` : ""}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
    </div>
  );
}
