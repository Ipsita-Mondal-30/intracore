import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Print · IntraCore" };

/** Bare layout for printable documents: no app shell, white page, A4-friendly margins. */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-slate-900 print:min-h-0">
      <style>{`@page { size: A4; margin: 12mm; } @media print { html, body { background: #fff !important; } }`}</style>
      <main className="mx-auto max-w-4xl px-6 py-8 text-[13px] leading-snug print:max-w-none print:p-0">{children}</main>
    </div>
  );
}
