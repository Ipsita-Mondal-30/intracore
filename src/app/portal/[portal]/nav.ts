export function salesLinks(portal: string) {
  const base = `/portal/${portal}`;
  const links = [
    { href: base, label: "Overview" },
    { href: `${base}/tickets`, label: "Support tickets" },
    { href: `${base}/service`, label: "Assets & service" },
  ];
  if (portal === "dealer") links.splice(1, 0, { href: `${base}/catalog`, label: "Catalog & order requests" });
  return links;
}

export const portalTitle = (portal: string) => (portal === "dealer" ? "Dealer portal" : "Customer portal");
