import { getAccessContext } from "@/lib/access";
import { errorResponse } from "@/lib/api/http";
import { importTemplate } from "@/features/admin/imports";

/** GET ?entity=customer → the template CSV as a download. */
export async function GET(req: Request) {
  try {
    const ctx = await getAccessContext();
    const template = importTemplate(ctx, new URL(req.url).searchParams.get("entity"));
    return new Response(template.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${template.filename}"`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
