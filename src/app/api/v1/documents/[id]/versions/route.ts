import { api } from "@/lib/api/http";
import { formFile, listDocumentVersions, uploadDocumentVersion } from "@/features/documents/service";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => listDocumentVersions(ctx, params.id));
/** multipart/form-data: file — becomes the next version of the document. */
export const POST = api<P>(
  async (ctx, { req, params }) => uploadDocumentVersion(ctx, params.id, (await formFile(req)).file),
  { status: 201 },
);
