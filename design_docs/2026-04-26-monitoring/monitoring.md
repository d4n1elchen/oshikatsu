# Phase 4: Monitoring & Observability

> **Status:** Proposed.
> **Follow-ups:** Alert dispatch, auto-recovery, and health-check CLI deferred to Phase 7 per the implementation plan.

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

Two panels stacked vertically:

**Top panel** — one card per task:

```
  Ingestion       ●  last completed 2m ago    last failed —          12/12 ok in 1h
  Extraction      ●  last completed 47s ago   last failed 3h ago     30/30 ok in 1h
  Resolution      ●  last completed 12s ago   last failed —          22/22 ok in 1h
```

Card color: green (last run completed), yellow (last run aborted, or any failure in last hour), red (last run failed).

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

3. **Should the Monitor view be the new home for ingestion errors?** Currently the `[2] Raw Items` view shows `status='error'` raw items via `getQueueAndErrors`. That's row-level extraction errors, not scheduler-level run errors — they belong in different views. Keep both.

## Testing

- Scheduler unit test: a successful run writes one `scheduler_runs` row with `status='completed'` and the returned `details`.
- Scheduler unit test: a thrown `Error` writes `status='failed'`, `error_class`, `error_message`.
- Scheduler unit test: an aborted run writes `status='aborted'` and no `error_class`.
- Scheduler unit test: a task returning `void` still gets a row, with `details = null`.
- Repo test: `SchedulerRunsRepo` insert/update round-trip on an in-memory SQLite.
- TUI: deferred — render coverage is hard without snapshots; rely on visual inspection during dev.

Total estimated: ~4 new tests in `Scheduler.test.ts` + ~3 in a new `SchedulerRunsRepo.test.ts`.

## Tech Debts to Record (post-implementation)

After landing this phase, update `TECH_DEBTS.md`:

- Remove "No per-cycle metrics or run history" from the Scheduler section.
- Refine "No error classification on persistent storage failures" to reference the now-existing `scheduler_runs` consumer instead of "the future Monitoring component."
- Add (small): "Monitor TUI view computes per-target last-success client-side; promote to a denormalized view if it gets slow or Phase 7 alerting needs server-side aggregation."
- Add (small): "Automatic pruning of `scheduler_runs` is deferred; manual via `reset:runs --older-than=N`."

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
2. Add `SchedulerRunsRepo` (insert + update + `recent(taskName?, limit)` queries) under `src/core/`.
3. Update `ScheduledTask.run` signature to allow `Promise<RunDetails | void>`.
4. Instrument `Scheduler.tick`: insert before run, update after, distinguish `completed | aborted | failed`, capture `error.name` / `error.message`.
5. Update daemon tasks (`runIngestionCycle`, extractor, resolver) to return their counts as `RunDetails`.
6. Replace per-tick `log.info("Started ...")` lines with a single end-of-run summary.
7. Add `[6] Monitor` TUI view and tab registration.
8. Add `reset:runs` script (or extend `resetDb.ts`).
9. Tests per the Testing section.
10. Update `TECH_DEBTS.md` per "Tech Debts to Record."

Estimated effort: 3–4 hours including tests.
