import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD,
  findParentByHint,
  titleSimilarity,
} from "../titleSimilarity";

const DEFAULT_HINT_THRESHOLDS = { matchThreshold: 0.6, ambiguityMargin: 0.05 };

test("identical titles score 1", () => {
  assert.equal(titleSimilarity("Tokyo Dome Concert", "Tokyo Dome Concert"), 1);
});

test("case-insensitive for ASCII", () => {
  assert.ok(titleSimilarity("Tokyo Dome Concert", "tokyo dome concert") >= TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD);
});

test("substring containment scores above threshold", () => {
  // "Album Release" is contained in the longer title
  const score = titleSimilarity("New Album Release", "Album Release");
  assert.ok(score >= TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD, `score was ${score}`);
});

test("completely different titles score low", () => {
  const score = titleSimilarity("Tokyo Dome Concert", "Merch Booth Opening");
  assert.ok(score < TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD, `score was ${score}`);
});

test("Japanese titles are preserved and match exactly", () => {
  assert.equal(titleSimilarity("東京ドームコンサート", "東京ドームコンサート"), 1);
});

test("different Japanese titles score low", () => {
  const score = titleSimilarity("東京ドームコンサート", "大阪グッズ販売");
  assert.ok(score < TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD, `score was ${score}`);
});

test("partial Japanese title overlap", () => {
  const score = titleSimilarity("東京ドームコンサート", "コンサート");
  assert.ok(score > 0, `score was ${score}`);
});

test("Japanese partial-prefix duplicate crosses threshold", () => {
  // Models real data: a campaign title and the same title with a sub-hashtag.
  // With the prior CJK-run-as-one-token tokenizer, this scored 0.53 and missed
  // the merge threshold; segmented tokens push it over.
  const score = titleSimilarity(
    "栃木放送パワープレイキャンペーン",
    "栃木放送パワープレイキャンペーン「#放課後ボーダーライン」"
  );
  assert.ok(
    score >= TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD,
    `score was ${score}`
  );
});

test("Japanese partial-suffix overlap crosses threshold", () => {
  // "東京ドーム公演" vs "アニバーサリー東京ドーム公演" — shared multi-token suffix.
  const score = titleSimilarity(
    "東京ドーム公演",
    "アニバーサリー東京ドーム公演"
  );
  assert.ok(
    score >= TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD,
    `score was ${score}`
  );
});

test("empty strings score 1 (both empty = identical)", () => {
  assert.equal(titleSimilarity("", ""), 1);
});

test("full containment of shorter in longer scores 1 (F3 hint→title case)", () => {
  // Regression for the 2026-05-17 audit, F3: an annotation hint that is a
  // strict prefix of the full event title used to score ~0.54 (symmetric
  // ratio-by-longer) and miss the 0.6 threshold. Asymmetric containment now
  // scores 1.
  assert.equal(
    titleSimilarity(
      "コラボ企画「#組曲2」第九弾",
      "コラボ企画「#組曲2」第九弾「放課後ボーダーライン」プレイリストイン",
    ),
    1,
  );
});

// ---- findParentByHint() ----

test("findParentByHint returns no_match when candidate set is empty", () => {
  const result = findParentByHint("any hint", [], DEFAULT_HINT_THRESHOLDS);
  assert.equal(result.kind, "no_match");
  assert.deepEqual(result.topCandidates, []);
});

test("findParentByHint returns match for a clear best", () => {
  const result = findParentByHint(
    "東京ドーム公演",
    [
      { id: "a", title: "アニバーサリー東京ドーム公演" },
      { id: "b", title: "大阪グッズ販売" },
    ],
    DEFAULT_HINT_THRESHOLDS,
  );
  assert.equal(result.kind, "match");
  if (result.kind === "match") {
    assert.equal(result.id, "a");
  }
});

test("findParentByHint returns no_match when best score is below threshold", () => {
  const result = findParentByHint(
    "Concert",
    [{ id: "a", title: "Merch Booth Opening" }],
    DEFAULT_HINT_THRESHOLDS,
  );
  assert.equal(result.kind, "no_match");
  assert.equal(result.topCandidates.length, 1);
});

test("findParentByHint returns ambiguous when top two are within the margin", () => {
  // Two near-identical titles both contain the hint exactly — they tie at 1.0.
  const result = findParentByHint(
    "東京ドーム公演",
    [
      { id: "a", title: "東京ドーム公演" },
      { id: "b", title: "東京ドーム公演" },
    ],
    DEFAULT_HINT_THRESHOLDS,
  );
  assert.equal(result.kind, "ambiguous");
});

test("findParentByHint returns match (not ambiguous) when runner-up is below threshold", () => {
  // Best ties with itself technically but runner-up is unrelated and well below.
  const result = findParentByHint(
    "東京ドーム公演",
    [
      { id: "a", title: "東京ドーム公演" },
      { id: "b", title: "大阪グッズ販売" },
    ],
    DEFAULT_HINT_THRESHOLDS,
  );
  assert.equal(result.kind, "match");
});

test("findParentByHint topCandidates is sorted descending and capped at 5", () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    title: `東京ドーム公演 ${i}`,
  }));
  const result = findParentByHint("東京ドーム公演", candidates, DEFAULT_HINT_THRESHOLDS);
  assert.equal(result.topCandidates.length, 5);
  for (let i = 1; i < result.topCandidates.length; i++) {
    assert.ok(result.topCandidates[i - 1]!.score >= result.topCandidates[i]!.score);
  }
});
