import { z } from "zod";

/**
 * Shared list query: ?page=1&pageSize=25&sort=createdAt&dir=desc&q=text
 * Endpoints extend `listQuerySchema` with their own filters and pass the
 * whitelisted sortable fields; anything else is a 422.
 */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
  q: z.string().trim().max(100).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

export function listArgs(
  query: ListQuery,
  sortable: readonly string[],
  defaultSort = "createdAt",
) {
  const sort = query.sort ?? defaultSort;
  if (!sortable.includes(sort)) {
    throw new z.ZodError([
      { code: "custom", path: ["sort"], message: `sort must be one of: ${sortable.join(", ")}` },
    ]);
  }
  return {
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
    orderBy: [{ [sort]: query.dir }, { id: "asc" as const }],
  };
}

/** Case-insensitive `contains` across the given fields, or {} when q is empty. */
export function searchWhere(q: string | undefined, fields: readonly string[]) {
  if (!q) return {};
  return { OR: fields.map((f) => ({ [f]: { contains: q, mode: "insensitive" as const } })) };
}

export async function paginate<T>(
  query: ListQuery,
  run: () => Promise<[T[], number]>,
): Promise<Page<T>> {
  const [items, total] = await run();
  return { items, total, page: query.page, pageSize: query.pageSize };
}
