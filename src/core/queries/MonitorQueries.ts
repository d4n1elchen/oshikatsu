import { count, desc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { rawItems } from "../../db/schema";

type DbInstance = typeof defaultDb;

export type ExtractionFailureGroup = {
  errorClass: string;
  count: number;
  oldest: Date;
  newest: Date;
};

export type ExtractionFailureSummary = {
  total: number;
  groups: ExtractionFailureGroup[];
};

/**
 * Summary of `raw_items` rows in error status, grouped by error_class.
 * Backs the Monitor TUI's "extraction failures" panel and replaces the
 * in-TS grouping that view used to do client-side.
 */
export async function getExtractionFailureSummary(
  dbi: DbInstance = defaultDb
): Promise<ExtractionFailureSummary> {
  const errorClassExpr = sql<string>`COALESCE(${rawItems.errorClass}, 'Error')`;

  const rows = await dbi
    .select({
      errorClass: errorClassExpr,
      cnt: count(),
      oldestSec: sql<number>`MIN(${rawItems.fetchedAt})`,
      newestSec: sql<number>`MAX(${rawItems.fetchedAt})`,
    })
    .from(rawItems)
    .where(eq(rawItems.status, "error"))
    .groupBy(errorClassExpr)
    .orderBy(desc(count()));

  const groups: ExtractionFailureGroup[] = rows.map((r) => ({
    errorClass: r.errorClass,
    count: r.cnt,
    oldest: new Date(r.oldestSec * 1000),
    newest: new Date(r.newestSec * 1000),
  }));

  const total = groups.reduce((sum, g) => sum + g.count, 0);

  return { total, groups };
}
