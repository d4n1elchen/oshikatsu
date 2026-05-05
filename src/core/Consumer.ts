import type { DeliveryResult, ExportRecord } from "./types";

/**
 * Downstream sink for canonical events. The runner depends only on this
 * interface — no globals, no shared state — so a future plugin loader can
 * construct a `Consumer` (potentially over IPC or in another language) and
 * hand it to the runner without changing the protocol.
 *
 * `name` is the stable identity used as the cursor key in `export_cursors`.
 * Renaming a consumer means losing its cursor (or migrating it manually).
 *
 * Idempotency contract: `deliver` may be invoked again with overlapping
 * records on the next tick if a previous tick failed mid-flight. Consumers
 * are expected to dedup on `record.id` (with `record.version` as the
 * monotonic ordering key).
 *
 * Failure model: throwing means "everything in this batch is implicitly
 * retried" (the connectivity-failure shortcut). Returning a `DeliveryResult`
 * lets the consumer partially succeed: `delivered` advances the cursor,
 * `rejected` is given up on permanently, anything else is retried.
 */
export interface Consumer {
  readonly name: string;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  deliver(batch: ExportRecord[], signal: AbortSignal): Promise<DeliveryResult>;
}

/**
 * Reference implementation. Always accepts the full batch. Used in tests
 * and as the simplest possible `Consumer` for a plugin author to study.
 * Not registered in `daemon.ts` by default.
 */
export class NoopConsumer implements Consumer {
  readonly name: string;
  readonly received: ExportRecord[] = [];

  constructor(name: string = "noop") {
    this.name = name;
  }

  async deliver(batch: ExportRecord[]): Promise<DeliveryResult> {
    this.received.push(...batch);
    return { delivered: batch.map((r) => r.id) };
  }
}
