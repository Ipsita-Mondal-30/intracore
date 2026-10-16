import { api } from "@/lib/api/http";
import { deleteDocument, getDocumentDownload } from "@/features/documents/service";

type P = { id: string };
/** Returns a short-lived signed download URL. */
export const GET = api<P>((ctx, { params }) => getDocumentDownload(ctx, params.id));
export const DELETE = api<P>((ctx, { params }) => deleteDocument(ctx, params.id));
