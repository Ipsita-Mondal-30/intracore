import { api } from "@/lib/api/http";
import { listCatalogLookups } from "@/features/catalog/service";

/** Units of measure, product categories and tax rates. */
export const GET = api((ctx) => listCatalogLookups(ctx));
