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

// `ja` locale segments mixed Japanese + ASCII correctly: ASCII splits on
// whitespace/punctuation, CJK splits on dictionary-known word boundaries
// (e.g. "栃木放送" → ["栃木", "放送"]). Treating each CJK run as a single
// token — the previous behavior — defeated Jaccard for partial-prefix duplicates.
const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

function tokenize(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const tokens = new Set<string>();
  for (const segment of segmenter.segment(normalized)) {
    if (segment.isWordLike && segment.segment.length > 0) {
      tokens.add(segment.segment);
    }
  }
  return tokens;
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
    // Full containment of the shorter string in the longer one is a strong
    // signal that they refer to the same thing (the longer just added detail
    // like a venue or sub-title). Penalizing for the length difference
    // mis-scores hint→title matches where the hint is by nature shorter —
    // see the 2026-05-17 audit, F3. Symmetric ratio-by-longer used to score
    // these around 0.5 and miss the 0.6 threshold; full containment now → 1.
    return 1;
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

export type ParentHintCandidate = { id: string; title: string };
export type ScoredParentHintCandidate = ParentHintCandidate & { score: number };
export type ParentHintThresholds = {
  /** Minimum similarity for a hint to attach to a candidate. */
  matchThreshold: number;
  /** Required margin between top-1 and top-2. Below this, we declare ambiguity. */
  ambiguityMargin: number;
};

export type FindParentByHintResult =
  | { kind: "match"; id: string; score: number; topCandidates: ScoredParentHintCandidate[] }
  | { kind: "ambiguous"; topCandidates: ScoredParentHintCandidate[] }
  | { kind: "no_match"; topCandidates: ScoredParentHintCandidate[] };

/**
 * Score each candidate's title against the hint and return the best match,
 * or `ambiguous` when top-1 and top-2 are within the configured margin, or
 * `no_match` when the top score is below threshold (or the candidate set is
 * empty). Used by both annotation parent-attachment and sub-event hint
 * matching — they want the same "which existing event does this hint point
 * at?" question, just with different downstream actions.
 */
export function findParentByHint(
  hint: string,
  candidates: ParentHintCandidate[],
  thresholds: ParentHintThresholds,
): FindParentByHintResult {
  const scored: ScoredParentHintCandidate[] = candidates
    .map((c) => ({ ...c, score: titleSimilarity(hint, c.title) }))
    .sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  const best = scored[0];
  if (!best || best.score < thresholds.matchThreshold) {
    return { kind: "no_match", topCandidates: top };
  }
  const runnerUp = scored[1];
  if (
    runnerUp &&
    runnerUp.score >= thresholds.matchThreshold &&
    best.score - runnerUp.score < thresholds.ambiguityMargin
  ) {
    return { kind: "ambiguous", topCandidates: top };
  }
  return { kind: "match", id: best.id, score: best.score, topCandidates: top };
}
