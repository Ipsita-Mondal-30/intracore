import { api } from "@/lib/api/http";
import { formFile, listDocuments, uploadDocument } from "@/features/documents/service";

/** Latest version of each document; `allVersions=true` includes superseded versions. */
export const GET = api((ctx, { query }) =>
  listDocuments(ctx, query.get("entityType") ?? "", query.get("entityId") ?? "", {
    allVersions: query.get("allVersions") === "true",
  }),
);

/** multipart/form-data: entityType, entityId, file */
export const POST = api(
  async (ctx, { req }) => {
    const { form, file } = await formFile(req);
    return uploadDocument(ctx, {
      entityType: String(form.get("entityType") ?? ""),
      entityId: String(form.get("entityId") ?? ""),
      file,
    });
  },
  { status: 201 },
);
