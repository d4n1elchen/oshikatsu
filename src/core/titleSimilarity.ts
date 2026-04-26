/**
 * Deterministic title similarity for event resolution.
 *
 * Strategy:
 * - Normalize whitespace and fold ASCII case.
 * - Preserve Japanese and other non-ASCII characters as-is.
 * - Compute token overlap (Jaccard) and substring containment scores.
 * - Return the higher of the two scores.
 *
 * Threshold recommendation: 0.6 for automatic merge; below that requires
 * additional corroborating signals.
 */

function normalizeTitle(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .trim()
    // Fold only ASCII letters to lowercase to preserve Japanese/CJK titles.
    .replace(/[A-Za-z]/g, (c) => c.toLowerCase());
}

function tokenize(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  // Split on ASCII whitespace and punctuation, keep CJK chars as individual tokens.
  const tokens = normalized.match(/[　-鿿가-힯豈-﫿]+|[^\s\p{P}]+/gu) ?? [];
  return new Set(tokens.filter((t) => t.length > 0));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

function substringScore(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    // Partial containment — score proportional to shorter/longer ratio
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  }
  return 0;
}

export function titleSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const jaccard = jaccardSimilarity(tokensA, tokensB);
  const substring = substringScore(a, b);
  return Math.max(jaccard, substring);
}

export const TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD = 0.6;
