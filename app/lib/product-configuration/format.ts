/** Formats integer cents (this system's only money representation — see
 * prisma/schema.prisma) as a USD display string. Never used for calculation, only
 * presentation. `null` (meaning "no price was supplied," never "$0" — the convention
 * used throughout `app/lib/pricing`) renders as `null` so callers must handle it
 * explicitly rather than accidentally printing "$0.00" for an unset price. */
export function formatCents(cents: number | null): string | null {
  if (cents === null) return null;
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
