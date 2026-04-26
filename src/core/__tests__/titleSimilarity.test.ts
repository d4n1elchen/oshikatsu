import { test } from "node:test";
import assert from "node:assert/strict";
import { titleSimilarity, TITLE_SIMILARITY_AUTO_MERGE_THRESHOLD } from "../titleSimilarity";

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

test("empty strings score 1 (both empty = identical)", () => {
  assert.equal(titleSimilarity("", ""), 1);
});
