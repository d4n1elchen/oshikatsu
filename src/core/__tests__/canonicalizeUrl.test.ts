import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl } from "../canonicalizeUrl";

// ---- input handling ----

test("returns empty string for empty/null/undefined", () => {
  assert.equal(canonicalizeUrl(""), "");
  assert.equal(canonicalizeUrl(null), "");
  assert.equal(canonicalizeUrl(undefined), "");
  assert.equal(canonicalizeUrl("   "), "");
});

test("trims whitespace", () => {
  assert.equal(canonicalizeUrl("  https://example.com  "), "https://example.com/");
});

test("returns input as-is when it cannot be parsed as URL", () => {
  assert.equal(canonicalizeUrl("not a url at all"), "not a url at all");
});

test("adds https:// scheme when missing", () => {
  assert.equal(canonicalizeUrl("youtube.com/@foo"), "https://youtube.com/@foo");
});

test("upgrades http:// to https://", () => {
  assert.equal(canonicalizeUrl("http://youtube.com/@foo"), "https://youtube.com/@foo");
});

test("strips www subdomain", () => {
  assert.equal(canonicalizeUrl("https://www.youtube.com/@foo"), "https://youtube.com/@foo");
});

test("lowercases hostname", () => {
  assert.equal(canonicalizeUrl("https://YouTube.com/@foo"), "https://youtube.com/@foo");
});

// ---- YouTube ----

test("YouTube @handle: keeps as-is", () => {
  assert.equal(canonicalizeUrl("https://youtube.com/@artist"), "https://youtube.com/@artist");
});

test("YouTube channel ID URL", () => {
  assert.equal(
    canonicalizeUrl("https://youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx"),
    "https://youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx"
  );
});

test("YouTube /c/legacy form", () => {
  assert.equal(canonicalizeUrl("https://youtube.com/c/legacyName"), "https://youtube.com/c/legacyName");
});

test("YouTube /user/legacy form", () => {
  assert.equal(canonicalizeUrl("https://youtube.com/user/oldName"), "https://youtube.com/user/oldName");
});

test("YouTube channel URL strips sub-paths like /videos, /streams, /about", () => {
  assert.equal(
    canonicalizeUrl("https://youtube.com/@artist/videos"),
    "https://youtube.com/@artist"
  );
  assert.equal(
    canonicalizeUrl("https://youtube.com/channel/UCxxxx/streams"),
    "https://youtube.com/channel/UCxxxx"
  );
});

test("YouTube channel URL strips tracking params", () => {
  assert.equal(
    canonicalizeUrl("https://youtube.com/@artist?si=tracking123"),
    "https://youtube.com/@artist"
  );
});

test("YouTube m.youtube.com is normalized to youtube.com", () => {
  assert.equal(
    canonicalizeUrl("https://m.youtube.com/@artist"),
    "https://youtube.com/@artist"
  );
});

test("YouTube www.youtube.com is normalized", () => {
  assert.equal(
    canonicalizeUrl("https://www.youtube.com/@artist/videos"),
    "https://youtube.com/@artist"
  );
});

test("YouTube watch URL is preserved (videos are events, not venues)", () => {
  // Per design: stream/video URLs represent individual events, not venue identity.
  // They are intentionally left alone.
  const watchUrl = canonicalizeUrl("https://youtube.com/watch?v=ABC123");
  assert.ok(watchUrl.includes("watch?v=ABC123"), `expected to preserve video URL, got ${watchUrl}`);
});

test("YouTube watch URL strips tracking params but keeps v=", () => {
  const result = canonicalizeUrl("https://youtube.com/watch?v=ABC123&si=tracking");
  assert.ok(result.includes("v=ABC123"));
  assert.ok(!result.includes("si=tracking"));
});

test("youtu.be short URL is preserved (treated as video, not venue)", () => {
  // youtu.be is only used for video shares, never channel identity.
  const result = canonicalizeUrl("https://youtu.be/ABC123");
  assert.ok(result.includes("ABC123"));
});

// ---- Twitch ----

test("Twitch channel URL", () => {
  assert.equal(canonicalizeUrl("https://twitch.tv/streamer"), "https://twitch.tv/streamer");
});

test("Twitch www and m subdomains normalize", () => {
  assert.equal(canonicalizeUrl("https://www.twitch.tv/streamer"), "https://twitch.tv/streamer");
  assert.equal(canonicalizeUrl("https://m.twitch.tv/streamer"), "https://twitch.tv/streamer");
});

test("Twitch sub-paths like /videos, /clips, /about collapse to channel root", () => {
  assert.equal(canonicalizeUrl("https://twitch.tv/streamer/videos"), "https://twitch.tv/streamer");
  assert.equal(canonicalizeUrl("https://twitch.tv/streamer/clips"), "https://twitch.tv/streamer");
});

test("Twitch tracking params stripped", () => {
  assert.equal(
    canonicalizeUrl("https://twitch.tv/streamer?utm_source=share"),
    "https://twitch.tv/streamer"
  );
});

// ---- NicoNico ----

test("NicoNico user URL", () => {
  assert.equal(
    canonicalizeUrl("https://nicovideo.jp/user/12345"),
    "https://nicovideo.jp/user/12345"
  );
});

test("NicoNico user URL strips sub-paths", () => {
  assert.equal(
    canonicalizeUrl("https://nicovideo.jp/user/12345/video"),
    "https://nicovideo.jp/user/12345"
  );
});

test("NicoNico live URL is preserved (live broadcasts are events)", () => {
  const url = canonicalizeUrl("https://live.nicovideo.jp/watch/lv999");
  assert.ok(url.includes("lv999"));
});

// ---- Non-platform URLs ----

test("Generic URLs are normalized but not canonicalized further", () => {
  assert.equal(
    canonicalizeUrl("https://www.example.com/foo/"),
    "https://example.com/foo"
  );
});

test("Generic URLs preserve query strings (not in tracking list)", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/page?id=42"),
    "https://example.com/page?id=42"
  );
});

test("Generic URLs strip known tracking params", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/page?id=42&utm_source=twitter&ref=post"),
    "https://example.com/page?id=42"
  );
});

// ---- Idempotency ----

test("canonicalizing a canonical URL returns the same URL", () => {
  const inputs = [
    "https://youtube.com/@artist",
    "https://youtube.com/channel/UCxxxx",
    "https://twitch.tv/streamer",
    "https://nicovideo.jp/user/12345",
    "https://example.com/page",
  ];
  for (const url of inputs) {
    assert.equal(canonicalizeUrl(canonicalizeUrl(url)), canonicalizeUrl(url));
  }
});

// ---- Different forms collapse to same canonical ----

test("YouTube: different www/scheme/subpath forms collapse to one", () => {
  const variants = [
    "https://youtube.com/@artist",
    "https://www.youtube.com/@artist",
    "http://youtube.com/@artist",
    "https://m.youtube.com/@artist",
    "https://youtube.com/@artist/videos",
    "https://youtube.com/@artist?si=track",
    "youtube.com/@artist",
  ];
  const canonical = canonicalizeUrl(variants[0]!);
  for (const v of variants) {
    assert.equal(canonicalizeUrl(v), canonical, `mismatch for ${v}`);
  }
});
