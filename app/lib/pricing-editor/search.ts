import type { Prisma } from "@prisma/client";

export function pricingProfileSearchWhere(
  storeId: string,
  query: string,
): Prisma.PricingProfileWhereInput {
  return {
    storeId,
    ...(query
      ? {
          OR: [
            { sku: { contains: query, mode: "insensitive" as const } },
            { name: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}
