/**
 * Tests for the login-wall / anti-bot / shape-change detection in
 * TwitterConnector.fetchUpdates. Uses a fake page object so no real browser
 * is launched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TwitterConnector, type PageLike } from "../index";
import {
  AntiBotError,
  LoginWallError,
  TimelineShapeError,
  TwitterFetchError,
} from "../errors";
import type { WatchTarget } from "../../../core/types";

type ResponseHandler = (response: any) => void | Promise<void>;

interface FakePageOptions {
  /** What page.url() returns after goto. Defaults to the input url. */
  resolvedUrl?: string;
  /** What page.title() returns. Defaults to "X profile". */
  title?: string;
  /** What page.content() returns. Defaults to a normal-looking HTML body. */
  body?: string;
  /** If set, page.goto rejects with this error. */
  gotoThrows?: Error;
  /**
   * Synthetic GraphQL responses to fire after navigation completes. Each one
   * is dispatched to the response handler when we synthesize them via
   * scrolling. If empty, no responses fire (simulating shape change).
   */
  fakeResponses?: Array<{ url: string; json: any }>;
}

function makeFakePage(opts: FakePageOptions = {}): PageLike & { _fire: () => Promise<void> } {
  const handlers: ResponseHandler[] = [];
  let lastUrl = "";

  const fakeResponses = opts.fakeResponses ?? [];

  const page: PageLike & { _fire: () => Promise<void> } = {
    async goto(url, _options) {
      if (opts.gotoThrows) throw opts.gotoThrows;
      lastUrl = opts.resolvedUrl ?? url;
      return undefined;
    },
    url() {
      return lastUrl;
    },
    async title() {
      return opts.title ?? "X profile";
    },
    async content() {
      return opts.body ?? "<html><body>normal page</body></html>";
    },
    async waitForTimeout(_ms) {
      // Skip waits in tests.
    },
    async evaluate<R>(_fn: () => R): Promise<R> {
      // First scroll triggers the fake responses.
      await page._fire();
      return undefined as unknown as R;
    },
    on(_event, handler) {
      handlers.push(handler);
    },
    removeListener(_event, handler) {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    },
    async _fire() {
      for (const r of fakeResponses) {
        const fakeResponse = {
          url: () => r.url,
          json: async () => r.json,
        };
        for (const h of handlers) await h(fakeResponse);
        // Only fire each response once across all scrolls.
      }
      fakeResponses.length = 0;
    },
  };

  return page;
}

const TARGET: WatchTarget = {
  id: "wt-1",
  artistId: "artist-1",
  platform: "twitter",
  sourceType: "user",
  sourceConfig: { username: "test_user" },
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeConnector() {
  return new TwitterConnector({
    browser: { userDataDir: "/tmp/test", headless: true },
    fetch: {
      maxTweetsPerSource: 50,
      scrollDelayMs: 0,
      pageLoadTimeoutMs: 1000,
    },
  });
}

function buildUserTweetsJson(tweetIds: string[]): any {
  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: tweetIds.map((id) => ({
                    entryId: `tweet-${id}`,
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: { rest_id: id, legacy: { full_text: `tweet ${id}` } },
                        },
                      },
                    },
                  })),
                },
              ],
            },
          },
        },
      },
    },
  };
}

// ---- 1. Login wall ----

test("throws LoginWallError when redirected to /i/flow/login", async () => {
  const connector = makeConnector();
  connector.setPageForTesting(
    makeFakePage({ resolvedUrl: "https://x.com/i/flow/login?redirect_after_login=/test_user" })
  );

  await assert.rejects(
    () => connector.fetchUpdates(TARGET),
    (err: unknown) => {
      assert.ok(err instanceof LoginWallError);
      assert.ok(err instanceof TwitterFetchError);
      assert.match((err as LoginWallError).resolvedUrl, /\/i\/flow\/login/);
      return true;
    }
  );
});

// ---- 2. Anti-bot interstitial ----

test("throws AntiBotError when Cloudflare challenge title is present", async () => {
  const connector = makeConnector();
  connector.setPageForTesting(
    makeFakePage({ title: "Just a moment...", fakeResponses: [] })
  );

  await assert.rejects(
    () => connector.fetchUpdates(TARGET),
    (err: unknown) => {
      assert.ok(err instanceof AntiBotError);
      assert.ok(err instanceof TwitterFetchError);
      assert.match((err as AntiBotError).marker, /just a moment/i);
      return true;
    }
  );
});

test("throws AntiBotError when 'Sorry, you have been blocked' is in body", async () => {
  const connector = makeConnector();
  connector.setPageForTesting(
    makeFakePage({ body: "<html><body>Sorry, you have been blocked</body></html>" })
  );

  await assert.rejects(
    () => connector.fetchUpdates(TARGET),
    (err: unknown) => err instanceof AntiBotError
  );
});

// ---- 3. Shape change ----

test("throws TimelineShapeError when no UserTweets response fires and zero items", async () => {
  const connector = makeConnector();
  // No fakeResponses → the scroll fires nothing → handler counter stays at 0.
  connector.setPageForTesting(makeFakePage({ fakeResponses: [] }));

  await assert.rejects(
    () => connector.fetchUpdates(TARGET),
    (err: unknown) => {
      assert.ok(err instanceof TimelineShapeError);
      assert.ok(err instanceof TwitterFetchError);
      return true;
    }
  );
});

// ---- 4. Genuinely empty timeline (no error) ----

test("returns [] when UserTweets responds with no entries (genuinely empty)", async () => {
  const connector = makeConnector();
  connector.setPageForTesting(
    makeFakePage({
      // The handler fires (count > 0) but there are no tweet entries.
      fakeResponses: [
        { url: "https://x.com/i/api/graphql/abc/UserTweets", json: buildUserTweetsJson([]) },
      ],
    })
  );

  const items = await connector.fetchUpdates(TARGET);
  assert.deepEqual(items, []);
});

// ---- 5. Normal fetch ----

test("returns parsed tweets on a normal fetch", async () => {
  const connector = makeConnector();
  connector.setPageForTesting(
    makeFakePage({
      fakeResponses: [
        {
          url: "https://x.com/i/api/graphql/abc/UserTweets",
          json: buildUserTweetsJson(["111", "222", "333"]),
        },
      ],
    })
  );

  const items = await connector.fetchUpdates(TARGET);
  assert.equal(items.length, 3);
  assert.equal(items[0]!.sourceName, "twitter");
  assert.deepEqual(
    items.map((i) => i.sourceId),
    ["111", "222", "333"]
  );
});

// ---- 6. Hard navigation error (regression for the existing re-throw fix) ----

test("wraps a raw page.goto failure as TwitterFetchError", async () => {
  const connector = makeConnector();
  connector.setPageForTesting(
    makeFakePage({ gotoThrows: new Error("net::ERR_NAME_NOT_RESOLVED") })
  );

  await assert.rejects(
    () => connector.fetchUpdates(TARGET),
    (err: unknown) => {
      // Wrapped, not a bare Error
      assert.ok(err instanceof TwitterFetchError);
      assert.match((err as Error).message, /ERR_NAME_NOT_RESOLVED/);
      return true;
    }
  );
});

// ---- AbortSignal ----

test("throws if signal is already aborted before navigation starts", async () => {
  const connector = makeConnector();
  connector.setPageForTesting(makeFakePage());
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => connector.fetchUpdates(TARGET, controller.signal),
    (err: unknown) => err instanceof TwitterFetchError
  );
});

test("aborts during a slow page.goto via signal race", async () => {
  // Construct a fake page where goto never resolves.
  const handlers: any[] = [];
  const page: any = {
    goto: () => new Promise(() => {}), // never resolves
    url: () => "https://x.com/test_user",
    title: async () => "X profile",
    content: async () => "<html></html>",
    waitForTimeout: async () => {},
    evaluate: async () => undefined,
    on: (_e: any, h: any) => handlers.push(h),
    removeListener: () => {},
  };

  const connector = makeConnector();
  connector.setPageForTesting(page);

  const controller = new AbortController();
  const fetchPromise = connector.fetchUpdates(TARGET, controller.signal);

  // Abort after a tick, well before the would-be timeout.
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(
    fetchPromise,
    (err: unknown) =>
      err instanceof TwitterFetchError && /Aborted/.test((err as Error).message)
  );
});

// ---- Missing page guard ----

test("throws TwitterFetchError if browser was never started", async () => {
  const connector = makeConnector();
  // Don't call setPageForTesting or start().

  await assert.rejects(
    () => connector.fetchUpdates(TARGET),
    (err: unknown) => err instanceof TwitterFetchError
  );
});
