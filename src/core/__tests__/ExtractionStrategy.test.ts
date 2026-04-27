/**
 * Pure unit tests for ExtractionStrategy. No DB needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TwitterExtractionStrategy,
  DefaultExtractionStrategy,
} from "../ExtractionStrategy";

const twitter = new TwitterExtractionStrategy();

function fakeTwitterRawItem(overrides: Partial<{
  rest_id: string;
  full_text: string;
  screen_name: string;
  created_at: string;
  urls: Array<{ url: string; expanded_url: string }>;
}> = {}) {
  const rest_id = overrides.rest_id ?? "1234567890";
  return {
    id: `twitter_${rest_id}`,
    sourceName: "twitter",
    sourceId: rest_id,
    rawData: {
      rest_id,
      core: {
        user_results: {
          result: {
            legacy: { screen_name: overrides.screen_name ?? "test_user" },
          },
        },
      },
      legacy: {
        full_text: overrides.full_text ?? "Hello world",
        created_at: overrides.created_at ?? "Wed Apr 23 10:00:00 +0000 2025",
        entities: { urls: overrides.urls ?? [] },
      },
    },
  };
}

// ---- supports() ----

test("Twitter strategy supports only sourceName=twitter", () => {
  assert.equal(twitter.supports("twitter"), true);
  assert.equal(twitter.supports("instagram"), false);
  assert.equal(twitter.supports(""), false);
});

test("Default strategy supports anything", () => {
  const d = new DefaultExtractionStrategy();
  assert.equal(d.supports("twitter"), true);
  assert.equal(d.supports("anything"), true);
});

// ---- buildContext() ----

test("Twitter buildContext extracts text, author, and source URL", () => {
  const item = fakeTwitterRawItem({
    full_text: "Live tonight 🎤",
    screen_name: "artist_official",
    rest_id: "555",
  });

  const ctx = twitter.buildContext(item);
  assert.ok(ctx);
  assert.equal(ctx!.text, "Live tonight 🎤");
  assert.equal(ctx!.author, "artist_official");
  assert.equal(ctx!.url, "https://x.com/artist_official/status/555");
  assert.equal(ctx!.rawContent, "Live tonight 🎤");
});

test("Twitter buildContext returns null when full_text is empty", () => {
  const item = fakeTwitterRawItem({ full_text: "" });
  assert.equal(twitter.buildContext(item), null);
});

test("Twitter buildContext returns null when legacy block is missing", () => {
  const item = { id: "x", sourceName: "twitter", sourceId: "1", rawData: {} };
  assert.equal(twitter.buildContext(item), null);
});

test("Twitter buildContext extracts related link candidates from entities.urls", () => {
  const item = fakeTwitterRawItem({
    urls: [
      { url: "https://t.co/short1", expanded_url: "https://example.com/event" },
      { url: "https://t.co/short2", expanded_url: "https://event.com/tickets" },
    ],
  });

  const ctx = twitter.buildContext(item);
  assert.ok(ctx);
  assert.equal(ctx!.relatedLinkCandidates.length, 2);
  assert.deepEqual(
    ctx!.relatedLinkCandidates.map((c) => c.url),
    ["https://example.com/event", "https://event.com/tickets"]
  );
});

test("Twitter buildContext dedupes related link candidates", () => {
  const item = fakeTwitterRawItem({
    urls: [
      { url: "https://t.co/a", expanded_url: "https://example.com/event" },
      { url: "https://t.co/b", expanded_url: "https://example.com/event" }, // dup
    ],
  });

  const ctx = twitter.buildContext(item);
  assert.equal(ctx!.relatedLinkCandidates.length, 1);
});

test("Twitter buildContext falls back to t.co URL when expanded_url is missing", () => {
  const item = fakeTwitterRawItem({
    urls: [{ url: "https://t.co/short", expanded_url: undefined as any }],
  });

  const ctx = twitter.buildContext(item);
  assert.equal(ctx!.relatedLinkCandidates[0]!.url, "https://t.co/short");
});

test("Twitter buildContext parses created_at into a Date", () => {
  const item = fakeTwitterRawItem({ created_at: "Wed Apr 23 10:00:00 +0000 2025" });
  const ctx = twitter.buildContext(item);
  assert.ok(ctx!.publishTime instanceof Date);
  assert.equal(ctx!.publishTime.getUTCFullYear(), 2025);
  assert.equal(ctx!.publishTime.getUTCMonth(), 3); // April
});

// ---- sanitize() ----

test("sanitize trims whitespace from title and description", () => {
  const ctx = twitter.buildContext(fakeTwitterRawItem())!;
  const result = twitter.sanitize(fakeTwitterRawItem(), ctx, {
    title: "  Concert  ",
    description: "  A live show  ",
    type: "concert",
    event_scope: "main",
    related_links: [],
    tags: [],
  });
  assert.equal(result.title, "Concert");
  assert.equal(result.description, "A live show");
});

test("sanitize throws on empty title", () => {
  const ctx = twitter.buildContext(fakeTwitterRawItem())!;
  assert.throws(() =>
    twitter.sanitize(fakeTwitterRawItem(), ctx, {
      title: "   ",
      description: "ok",
      type: "concert",
      event_scope: "main",
      related_links: [],
      tags: [],
    })
  );
});

test("sanitize merges related_links from LLM with link candidates from context", () => {
  const item = fakeTwitterRawItem({
    urls: [{ url: "https://t.co/a", expanded_url: "https://example.com/from-context" }],
  });
  const ctx = twitter.buildContext(item)!;

  const result = twitter.sanitize(item, ctx, {
    title: "X",
    description: "Y",
    type: "concert",
    event_scope: "main",
    related_links: [{ url: "https://example.com/from-llm" }],
    tags: [],
  });

  const urls = new Set(result.related_links.map((l) => l.url));
  assert.ok(urls.has("https://example.com/from-llm"));
  assert.ok(urls.has("https://example.com/from-context"));
});

test("sanitize drops parent_event_hint when event_scope is not 'sub'", () => {
  const ctx = twitter.buildContext(fakeTwitterRawItem())!;
  const result = twitter.sanitize(fakeTwitterRawItem(), ctx, {
    title: "X",
    description: "Y",
    type: "concert",
    event_scope: "main",
    parent_event_hint: "Some Tour",
    related_links: [],
    tags: [],
  });
  assert.equal(result.parent_event_hint, undefined);
});

test("sanitize keeps parent_event_hint when event_scope is 'sub'", () => {
  const ctx = twitter.buildContext(fakeTwitterRawItem())!;
  const result = twitter.sanitize(fakeTwitterRawItem(), ctx, {
    title: "Pre-show",
    description: "Booth",
    type: "side_event",
    event_scope: "sub",
    parent_event_hint: "Some Tour",
    related_links: [],
    tags: [],
  });
  assert.equal(result.parent_event_hint, "Some Tour");
});

test("sanitize parses ISO start_time and round-trips through Date", () => {
  const ctx = twitter.buildContext(fakeTwitterRawItem())!;
  const result = twitter.sanitize(fakeTwitterRawItem(), ctx, {
    title: "X",
    description: "Y",
    type: "concert",
    event_scope: "main",
    start_time: "2025-06-01T12:00:00Z",
    related_links: [],
    tags: [],
  });
  assert.equal(result.start_time, "2025-06-01T12:00:00.000Z");
});

test("sanitize throws on unparseable start_time", () => {
  const ctx = twitter.buildContext(fakeTwitterRawItem())!;
  assert.throws(() =>
    twitter.sanitize(fakeTwitterRawItem(), ctx, {
      title: "X",
      description: "Y",
      type: "concert",
      event_scope: "main",
      start_time: "yesterday",
      related_links: [],
      tags: [],
    })
  );
});
