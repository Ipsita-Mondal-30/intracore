import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { listDocuments, uploadDocument } from "@/features/documents/service";

export const GET = api((ctx, { query }) =>
  listDocuments(ctx, query.get("entityType") ?? "", query.get("entityId") ?? ""),
);

/** multipart/form-data: entityType, entityId, file */
export const POST = api(
  async (ctx, { req }) => {
    const form = await req.formData().catch(() => {
      throw new AppError("VALIDATION_ERROR", "Expected multipart/form-data", 422);
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("VALIDATION_ERROR", "file is required", 422);
    return uploadDocument(ctx, {
      entityType: String(form.get("entityType") ?? ""),
      entityId: String(form.get("entityId") ?? ""),
      file,
    });
  },
  { status: 201 },
);
