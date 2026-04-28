# Phase 4: Monitoring & Observability

> **Status:** Landed. 11 new tests in `Scheduler.test.ts` and `SchedulerRunsRepo.test.ts` plus an extraction `error_class` capture test.
> **Follow-ups:** Alert dispatch, auto-recovery, and health-check CLI deferred to Phase 7 per the implementation plan. Manual pruning + client-side per-target aggregation tracked in `TECH_DEBTS.md`.

## Overview

Phase 4 introduces the substrate for monitoring the daemon: a `scheduler_runs` table that captures every tick of every task, instrumentation in the `Scheduler` to record start/finish/status, and a `[6] Monitor` TUI tab that surfaces the data. Alerting and automated recovery are deferred to Phase 7 — this phase only builds the data layer and a read-only view.

This phase is contained: one new table, one migration, ~30 lines of scheduler instrumentation, one TUI view. No new long-running processes, no external integrations.

## Problem

Phases 1–3 produce structured failure signals — `LoginWallError`, `AntiBotError`, `TimelineShapeError`, `TwitterFetchError`, `RawStorage` write failures, `EventResolver.processBatch` per-event failures — but those signals only land in logs. As soon as a target starts silently failing (login wall, broken GraphQL shape, persistent SQLite error), the only way to notice is to tail logs, which the operator stops doing the moment the daemon "seems fine."

With Phase 5 (Downstream Export) about to consume normalized events for calendar/notification dispatch, "is the daemon healthy?" becomes a load-bearing question. Without a structured answer, exports go stale, calendar entries lag reality, and the operator finds out by spotting a missing announcement.

## Goals

- The operator can answer "is the daemon healthy?" without reading logs.
- The operator can see which watch targets are failing repeatedly versus genuinely quiet.
- Phase 5 export tasks get visibility automatically by registering as `ScheduledTask`s.
- Provide the data layer Phase 7 will build alerting/auto-recovery on top of.
- Keep the change small — instrumentation, not a new subsystem.

## Non-Goals

- No alert dispatch (email, webhook, Slack) — Phase 7.
- No automated recovery / auto-disable of unhealthy targets — Phase 7.
- No health-check CLI command for external monitoring — Phase 7.
- No external monitoring integrations (Prometheus, OpenTelemetry, etc.) — Phase 7.
- No real-time streaming. The TUI polls; structured log lines remain the streaming channel.
- No automatic pruning policy. A manual `reset:runs` script is provided.

## Failure Signal Inventory

Different pipeline stages persist failure information differently. Phase 4 unifies their presentation in the Monitor view but does not normalize storage — each stage already has the right place for its data:

| Stage              | Per-item failure persistence                         | Per-cycle failure persistence    |
| ------------------ | ---------------------------------------------------- | -------------------------------- |
| Ingestion (fetch)  | None — per-target outcomes captured in run details   | `scheduler_runs.details`         |
| Extraction         | `raw_items.status='error'` + `error_message`         | `scheduler_runs.details`         |
| Resolution         | None — failed events retry next cycle                | `scheduler_runs.details`         |

Extraction is the only stage with **persistent per-item failures**. They survive across daemon restarts until the operator either retries (manual `markNew`) or fixes the upstream issue. The Monitor view treats this as a first-class signal, not just an aggregate count.

To make per-item extraction failures groupable, this phase also adds an `error_class` column to `raw_items` — symmetrical with `scheduler_runs.error_class` and far more useful than free-text error messages alone (e.g., "12 ZodError, 3 LLMTimeoutError" beats "15 errors with various messages").

## Data Model

### `scheduler_runs`

| Field           | Type                   | Description |
| --------------- | ---------------------- | ----------- |
| `id`            | text PK (uuid)         | Run identifier. |
| `task_name`     | text                   | "Ingestion", "Extraction", "Resolution", and future tasks. |
| `started_at`    | integer (timestamp)    | When the run began. |
| `finished_at`   | integer (timestamp)    | When the run ended; null only for an in-flight crashed daemon (rare). |
| `status`        | text                   | `completed` \| `failed` \| `aborted` \| `running`. `running` is overwritten on completion; surfaces only if the daemon was killed mid-tick. |
| `error_class`   | text nullable          | `error.name` (e.g., `LoginWallError`, `TwitterFetchError`, `Error`). Set when status is `failed`. |
| `error_message` | text nullable          | First line of `error.message`, truncated. |
| `details`       | json nullable          | Free-form payload returned by the task (counts, per-target stats). |

Indexes:

- `(task_name, started_at desc)` — for "recent runs of task X" rendering.
- `(status, started_at desc)` — for "recent failures across all tasks".

### `raw_items.error_class` (new column)

Add a nullable `error_class` column to the existing `raw_items` table. Populated by `ExtractionEngine.processItem` when it catches an error, using `error.name`. Existing `error_message` keeps its free-text role.

| Field              | Type            | Description |
| ------------------ | --------------- | ----------- |
| `error_class`      | text nullable   | `error.name` of the exception (e.g., `ZodError`, `LLMTimeoutError`, `Error`). Set alongside `status='error'`. |

`RawStorage.markError(itemId, errorMessage)` becomes `markError(itemId, errorMessage, errorClass?)`. The optional shape keeps existing callers working, but the extractor will pass `error.name` going forward.

### `ScheduledTask.run` signature

The current signature is `(signal: AbortSignal) => Promise<void>`. Extend to allow returning a details payload that ends up in `scheduler_runs.details`:

```ts
type RunDetails = Record<string, unknown>;
run: (signal: AbortSignal) => Promise<RunDetails | void>;
```

Returning `void` is still valid — the row gets recorded with `details = null`. Tasks that have natural counts (the daemon's three) return them.

Recommended payload shapes (suggestions, not enforced):

- Ingestion: `{ totalTargets, fetched: { perTarget: { username: { items, status, error_class? } } } }`.
- Extraction: `{ processed, failed }` — already computed by `processBatch`.
- Resolution: `{ resolved, failed }` — already computed.

## Scheduler Instrumentation

Replace the current `tick()` body with:

```
async tick(state, runNow):
    if not state.running: return
    if runNow:
        runId = uuid()
        startedAt = now()
        insert scheduler_runs(runId, name, startedAt, status="running")
        controller = new AbortController()
        try:
            details = await state.task.run(controller.signal)
            update scheduler_runs(runId, finishedAt=now(), status="completed", details)
        except AbortError:
            update scheduler_runs(runId, finishedAt=now(), status="aborted")
        except err:
            update scheduler_runs(runId, finishedAt=now(),
                                  status="failed",
                                  error_class=err.name,
                                  error_message=truncate(err.message, 1000))
            log.error(...)  # keep the existing log line
    schedule next tick
```

Key points:

- Insert + update is two writes per cycle. With WAL mode and the existing busy-timeout, this is negligible — extraction/ingestion already do far more I/O.
- The "running" status is a defensive measure for ungraceful daemon kills (SIGKILL, OOM). Normal SIGINT shutdown drains in-flight cleanly.
- The existing `log.error` for unhandled task errors stays — logs and `scheduler_runs` are complementary, not redundant.

A small repo class (`SchedulerRunsRepo`) wraps the insert/update SQL so the scheduler doesn't sprout drizzle queries inline. Same DI pattern as `RawStorage` / `VenueResolver`.

## TUI: `[6] Monitor`

Three panels stacked vertically:

**Top panel** — one card per task:

```
  Ingestion       ●  last completed 2m ago    last failed —          12/12 ok in 1h
  Extraction      ●  last completed 47s ago   last failed 3h ago     30/30 ok in 1h
  Resolution      ●  last completed 12s ago   last failed —          22/22 ok in 1h
```

Card color: green (last run completed), yellow (last run aborted, or any failure in last hour), red (last run failed).

**Middle panel** — per-item extraction failure summary, queried from `raw_items`:

```
  Extraction failures (raw_items where status='error')
  Total errored items:  15
  Grouped by error_class:
    ZodError              12   (oldest 3h ago, newest 4m ago)
    LLMTimeoutError        2   (oldest 1h ago, newest 1h ago)
    Error                  1   (oldest 6h ago, newest 6h ago)
```

This panel is empty (collapsed to a single "no errored items" line) when the queue is clean. Selecting a row could deep-link into the existing `[2] Raw Items` view filtered by that error class — defer the deep-link if it expands scope.

**Bottom panel** — recent runs table (last 50):

```
  Task         Started              Duration   Status      Detail
  Ingestion    2026-04-26 14:32:01  4m 12s     completed   12 targets, 47 new
  Resolution   2026-04-26 14:31:55  280ms      completed   resolved 3, failed 0
  Extraction   2026-04-26 14:31:20  1m 4s      failed      Error: ollama is down
  Ingestion    2026-04-26 14:17:01  3m 58s     completed   12 targets, 0 new
  ...
```

Status colors mirror the cards. Selecting a row could expand to show full `details` JSON; defer to follow-up if needed.

Keybindings: `↑↓` navigate, `r` refresh, `c` clear (calls `reset:runs` after confirm — defer if scope creeps).

### Per-target last-success surface

Within ingestion, the `details.fetched.perTarget` map holds per-target outcomes. The Monitor view computes "last success per target" client-side by scanning the most recent N ingestion runs. Phase 7 will likely promote this to a proper view or denormalized table; for Phase 4, the client-side scan is sufficient for the TUI's read-only purpose.

## Logging

End each tick with a structured summary line so operators tailing logs see the same data:

```
[Scheduler] Ingestion run completed in 4m12s; 12 targets, 47 new items, 0 failed
[Scheduler] Extraction run failed in 1m4s: Error: ollama is down
[Scheduler] Resolution run completed in 280ms; 3 resolved, 0 failed
```

This replaces the per-stage `log.info("Started ...")` cadence. Cleaner output, same information.

## Pruning

`scheduler_runs` grows ~720 rows/day (3 tasks × 4 cycles/min × 60 min / 1 = 720 if extraction runs every minute; in practice closer to ~80–100 with default intervals). After a year that's ~30k rows — fine for SQLite, the Monitor view's `LIMIT 50` is unaffected.

For now, ship a `reset:runs` script that deletes runs older than a configurable cutoff (`--older-than=30d`). Skip automatic pruning. If row count becomes a problem we can add a daily prune task later.

## Open Questions

1. **Should `details` JSON be queryable with indexes?** SQLite supports JSON paths and even functional indexes since 3.38. For Phase 4 we render in TypeScript after a `LIMIT 50` query, so no path indexes are needed. Revisit if the per-target view requires them.

2. **Should `error_message` be redacted?** Twitter URLs in raw item rendering are already shown in plaintext in the TUI; storing them in `error_message` doesn't escalate exposure. No redaction in Phase 4. Phase 7 alert dispatch may need it.

3. **Two views show the same errored items — is that confusing?** The `[2] Raw Items` view lists individual errored rows for retry; the new `[6] Monitor` aggregates them by class for health awareness. They serve different purposes (per-row triage vs. aggregate signal) and live at different abstraction levels, so two views is the right answer. The Monitor view's middle panel could deep-link into Raw Items filtered by class as a follow-up.

## Testing

- Scheduler unit test: a successful run writes one `scheduler_runs` row with `status='completed'` and the returned `details`.
- Scheduler unit test: a thrown `Error` writes `status='failed'`, `error_class`, `error_message`.
- Scheduler unit test: an aborted run writes `status='aborted'` and no `error_class`.
- Scheduler unit test: a task returning `void` still gets a row, with `details = null`.
- Repo test: `SchedulerRunsRepo` insert/update round-trip on an in-memory SQLite.
- ExtractionEngine test: a thrown `ZodError` lands as `raw_items.status='error'` with `error_class='ZodError'` (extends the existing failure test).
- TUI: deferred — render coverage is hard without snapshots; rely on visual inspection during dev.

Total estimated: ~4 new tests in `Scheduler.test.ts` + ~3 in a new `SchedulerRunsRepo.test.ts` + ~1 added to `ExtractionEngine.test.ts`.

## Tech Debts to Record (post-implementation)

After landing this phase, update `TECH_DEBTS.md`:

- Remove "No per-cycle metrics or run history" from the Scheduler section.
- Refine "No error classification on persistent storage failures" to reference the now-existing `scheduler_runs` consumer instead of "the future Monitoring component."
- Add (small): "Monitor TUI view computes per-target last-success client-side; promote to a denormalized view if it gets slow or Phase 7 alerting needs server-side aggregation."
- Add (small): "Automatic pruning of `scheduler_runs` is deferred; manual via `reset:runs --older-than=N`."
- Add (small): "Resolution per-event failures are not persisted (failed events stay un-resolved and retry next cycle). If recurring resolver errors become a real signal — e.g. a code bug producing the same exception every cycle — promote to a similar `error_class`-tagged persistence shape. Ephemeral retry is fine for now."

## Cross-References

- `src/core/Scheduler.ts` — primary implementation target.
- `src/db/schema.ts` — new `scheduler_runs` table.
- `src/tui/views/Monitor.tsx` — new view.
- `src/tui/App.tsx` — register the new tab.
- `src/scripts/resetDb.ts` — extend to support `--older-than-runs` mode (or new script).
- `ARCHITECTURE.md` — Component 7 (Monitoring); Phase 4 implements the data-collection half.
- `design_docs/2026-04-23-implementation-plan/plan.md` — Phase 4 was pulled forward from Phase 6 in this restructure.

## Implementation Plan

1. Add `scheduler_runs` table to `src/db/schema.ts` and generate the migration.
2. Add `error_class` nullable column to `raw_items` in the same migration.
3. Add `SchedulerRunsRepo` (insert + update + `recent(taskName?, limit)` queries) under `src/core/`.
4. Update `ScheduledTask.run` signature to allow `Promise<RunDetails | void>`.
5. Instrument `Scheduler.tick`: insert before run, update after, distinguish `completed | aborted | failed`, capture `error.name` / `error.message`.
6. Update daemon tasks (`runIngestionCycle`, extractor, resolver) to return their counts as `RunDetails`.
7. Update `RawStorage.markError` to accept an optional `errorClass`; update `ExtractionEngine.processItem` to pass `error.name`.
8. Replace per-tick `log.info("Started ...")` lines with a single end-of-run summary.
9. Add `[6] Monitor` TUI view (three panels: task cards, extraction failure summary, recent runs table) and register the tab.
10. Add `reset:runs` script (or extend `resetDb.ts`).
11. Tests per the Testing section.
12. Update `TECH_DEBTS.md` per "Tech Debts to Record."

Estimated effort: 4–5 hours including tests.
