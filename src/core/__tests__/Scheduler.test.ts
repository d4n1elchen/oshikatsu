/**
 * Tests for the generic Scheduler — focused on AbortSignal-driven graceful
 * shutdown. Other behaviors (drift-safe chaining, runImmediately, multi-task)
 * are exercised end-to-end in the daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../Scheduler";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("stop() aborts the in-flight task signal", async () => {
  const observed = deferred<AbortSignal>();
  const finished = deferred<void>();

  const scheduler = new Scheduler().add({
    name: "Test",
    intervalMinutes: 60,
    run: async (signal) => {
      observed.resolve(signal);
      // Wait for abort, then bail out. Mimics what real cooperative code does.
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      finished.resolve();
    },
  });

  scheduler.start();
  const signal = await observed.promise;
  assert.equal(signal.aborted, false);

  await scheduler.stop();
  assert.equal(signal.aborted, true);
  await finished.promise; // Task observed the abort and exited cleanly.
});

test("stop() awaits the in-flight task to drain", async () => {
  const drained = { yes: false };
  const started = deferred<void>();

  const scheduler = new Scheduler().add({
    name: "Test",
    intervalMinutes: 60,
    run: async (signal) => {
      started.resolve();
      // Pretend a 50ms tail of cleanup work after the abort fires.
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => {
            drained.yes = true;
            resolve();
          }, 50);
        }, { once: true });
      });
    },
  });

  scheduler.start();
  await started.promise;

  await scheduler.stop();
  assert.equal(drained.yes, true, "stop() should not return until task drains");
});

test("AbortError thrown by a task is not logged as an error", async () => {
  // We can't easily intercept `log.error`, but we can at least verify
  // that an AbortError doesn't propagate out of stop(). If the catch in
  // tick() handled the abort silently, stop() resolves cleanly.
  const scheduler = new Scheduler().add({
    name: "Test",
    intervalMinutes: 60,
    run: async (signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
    },
  });

  scheduler.start();
  // give it a tick to start
  await new Promise((r) => setTimeout(r, 10));
  await scheduler.stop();
  // If we got here without unhandled rejection, the abort was handled.
});

test("add() throws after start()", () => {
  const scheduler = new Scheduler().add({
    name: "First",
    intervalMinutes: 60,
    run: async () => {},
  });
  scheduler.start();

  assert.throws(() =>
    scheduler.add({ name: "Late", intervalMinutes: 60, run: async () => {} })
  );

  return scheduler.stop();
});
