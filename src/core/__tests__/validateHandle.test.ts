import { test } from "node:test";
import assert from "node:assert/strict";
import { validateHandle } from "../validateHandle";

test("accepts a typical operator-friendly handle", () => {
  assert.deepEqual(validateHandle("arashi"), { valid: true });
  assert.deepEqual(validateHandle("nogizaka46"), { valid: true });
  assert.deepEqual(validateHandle("snake_case"), { valid: true });
  assert.deepEqual(validateHandle("kebab-case"), { valid: true });
});

test("accepts unicode handles", () => {
  assert.deepEqual(validateHandle("嵐"), { valid: true });
  assert.deepEqual(validateHandle("乃木坂46"), { valid: true });
});

test("rejects empty input", () => {
  const r = validateHandle("");
  assert.equal(r.valid, false);
  if (!r.valid) assert.match(r.reason, /required/);
});

test("rejects whitespace", () => {
  const r = validateHandle("foo bar");
  assert.equal(r.valid, false);
  if (!r.valid) assert.match(r.reason, /whitespace/);
});

test("rejects path-unsafe punctuation", () => {
  for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    const r = validateHandle(`foo${ch}bar`);
    assert.equal(r.valid, false, `should reject "${ch}"`);
  }
});

test("rejects leading/trailing dots, hyphens, underscores", () => {
  assert.equal(validateHandle(".foo").valid, false);
  assert.equal(validateHandle("-foo").valid, false);
  assert.equal(validateHandle("_foo").valid, false);
  assert.equal(validateHandle("foo.").valid, false);
  assert.equal(validateHandle("foo-").valid, false);
  assert.equal(validateHandle("foo_").valid, false);
});

test("rejects overly long handles", () => {
  const long = "a".repeat(65);
  const r = validateHandle(long);
  assert.equal(r.valid, false);
  if (!r.valid) assert.match(r.reason, /too long/);
});
