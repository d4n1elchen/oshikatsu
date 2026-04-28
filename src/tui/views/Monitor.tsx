import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { db } from "../../db";
import { rawItems, schedulerRuns } from "../../db/schema";
import { count, desc, eq } from "drizzle-orm";
import { SchedulerRunsRepo } from "../../core/SchedulerRunsRepo";
import type { SchedulerRun } from "../../core/types";

const TASK_NAMES = ["Ingestion", "Extraction", "Resolution"] as const;

type TaskCard = {
  name: string;
  lastRun: SchedulerRun | null;
  lastSuccess: SchedulerRun | null;
  lastFailure: SchedulerRun | null;
  countsLastHour: { completed: number; failed: number; aborted: number };
};

type ExtractionFailureGroup = {
  errorClass: string;
  count: number;
  oldest: Date;
  newest: Date;
};

type MonitorData = {
  cards: TaskCard[];
  recent: SchedulerRun[];
  extractionFailures: {
    total: number;
    groups: ExtractionFailureGroup[];
  };
};

const STATUS_COLOR: Record<string, string> = {
  completed: "green",
  failed: "red",
  aborted: "yellow",
  running: "cyan",
};

const HOUR_MS = 60 * 60 * 1000;

export default function Monitor() {
  const [data, setData] = useState<MonitorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);

  const repo = React.useMemo(() => new SchedulerRunsRepo(), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    const sinceHour = new Date(Date.now() - HOUR_MS);
    const [recent, countsRows, extractionErrorRows] = await Promise.all([
      repo.recent(50),
      repo.countsSince(sinceHour),
      db
        .select({
          errorClass: rawItems.errorClass,
          fetchedAt: rawItems.fetchedAt,
        })
        .from(rawItems)
        .where(eq(rawItems.status, "error")),
    ]);

    // Build per-task cards
    const cards: TaskCard[] = await Promise.all(
      TASK_NAMES.map(async (name) => {
        const taskRecent = recent.filter((r) => r.taskName === name);
        const lastRun = taskRecent[0] ?? null;
        const lastSuccess = taskRecent.find((r) => r.status === "completed") ?? null;
        const lastFailure = taskRecent.find((r) => r.status === "failed") ?? null;

        const counts = { completed: 0, failed: 0, aborted: 0 };
        for (const c of countsRows) {
          if (c.taskName !== name) continue;
          if (c.status in counts) counts[c.status as keyof typeof counts] = c.count;
        }
        return { name, lastRun, lastSuccess, lastFailure, countsLastHour: counts };
      })
    );

    // Group extraction failures by error_class
    const groupMap = new Map<string, { count: number; oldest: Date; newest: Date }>();
    for (const row of extractionErrorRows) {
      const key = row.errorClass ?? "Error";
      const existing = groupMap.get(key);
      if (existing) {
        existing.count++;
        if (row.fetchedAt < existing.oldest) existing.oldest = row.fetchedAt;
        if (row.fetchedAt > existing.newest) existing.newest = row.fetchedAt;
      } else {
        groupMap.set(key, { count: 1, oldest: row.fetchedAt, newest: row.fetchedAt });
      }
    }
    const groups: ExtractionFailureGroup[] = [...groupMap.entries()]
      .map(([errorClass, v]) => ({ errorClass, ...v }))
      .sort((a, b) => b.count - a.count);

    setData({
      cards,
      recent,
      extractionFailures: { total: extractionErrorRows.length, groups },
    });
    setLoading(false);
  }, [repo]);

  React.useEffect(() => { loadData(); }, [loadData]);

  useInput((input, key) => {
    if (input === "r") loadData();
    if (key.upArrow && cursor > 0) setCursor(cursor - 1);
    if (key.downArrow && data && cursor < data.recent.length - 1) setCursor(cursor + 1);
  });

  if (loading) return <Text color="cyan">Loading monitor data...</Text>;
  if (!data) return <Text>No data</Text>;

  return (
    <Box flexDirection="column" height="100%">
      {/* Top: per-task cards */}
      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">Tasks</Text>
        {data.cards.map((card) => <TaskCardRow key={card.name} card={card} />)}
      </Box>

      {/* Middle: extraction failure summary */}
      <Box flexDirection="column" borderStyle="single" borderColor="red" paddingX={1} marginTop={1}>
        <Text bold color="red">Extraction failures (raw_items where status='error')</Text>
        {data.extractionFailures.total === 0 ? (
          <Text color="green">  No errored items.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>  Total errored items: <Text bold>{data.extractionFailures.total}</Text></Text>
            <Text dimColor>  Grouped by error_class:</Text>
            {data.extractionFailures.groups.map((g) => (
              <Box key={g.errorClass}>
                <Text>    </Text>
                <Text color="red">{g.errorClass.padEnd(24)}</Text>
                <Text>{String(g.count).padStart(4)}   </Text>
                <Text dimColor>(oldest {timeAgo(g.oldest)}, newest {timeAgo(g.newest)})</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>

      {/* Bottom: recent runs table */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1} flexGrow={1}>
        <Text bold>Recent runs (last {data.recent.length})</Text>
        <Box flexDirection="row" marginTop={1}>
          <Text bold dimColor>{"Task".padEnd(12)}</Text>
          <Text bold dimColor>{"Started".padEnd(20)}</Text>
          <Text bold dimColor>{"Duration".padEnd(10)}</Text>
          <Text bold dimColor>{"Status".padEnd(11)}</Text>
          <Text bold dimColor>Detail</Text>
        </Box>
        {data.recent.slice(0, 20).map((run, idx) => {
          const isSelected = idx === cursor;
          return (
            <Box key={run.id} flexDirection="row">
              <Text color={isSelected ? "cyan" : undefined}>{run.taskName.padEnd(12)}</Text>
              <Text dimColor>{formatTimestamp(run.startedAt).padEnd(20)}</Text>
              <Text dimColor>{formatDuration(run).padEnd(10)}</Text>
              <Text color={STATUS_COLOR[run.status] ?? "white"}>{run.status.padEnd(11)}</Text>
              <Text wrap="truncate">{formatRunDetail(run)}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>↑↓ Navigate  <Text color="white">r</Text> Refresh</Text>
      </Box>
    </Box>
  );
}

function TaskCardRow({ card }: { card: TaskCard }) {
  const status = card.lastRun?.status ?? "running";
  const cardColor = computeCardColor(card);
  const successAgo = card.lastSuccess ? timeAgo(card.lastSuccess.startedAt) : "—";
  const failureAgo = card.lastFailure ? timeAgo(card.lastFailure.startedAt) : "—";
  const c = card.countsLastHour;
  const total = c.completed + c.failed + c.aborted;
  const ratio = total > 0 ? `${c.completed}/${total} ok in 1h` : "no runs in 1h";

  return (
    <Box flexDirection="row">
      <Text color={cardColor}>● </Text>
      <Text bold>{card.name.padEnd(13)}</Text>
      <Text dimColor>last </Text>
      <Text color={STATUS_COLOR[status] ?? "white"}>{status.padEnd(10)}</Text>
      <Text dimColor>  ok {successAgo.padEnd(10)}</Text>
      <Text dimColor>  fail {failureAgo.padEnd(10)}</Text>
      <Text dimColor>  {ratio}</Text>
    </Box>
  );
}

function computeCardColor(card: TaskCard): string {
  if (!card.lastRun) return "gray";
  if (card.lastRun.status === "failed") return "red";
  if (card.lastRun.status === "aborted") return "yellow";
  if (card.countsLastHour.failed > 0) return "yellow";
  return "green";
}

function timeAgo(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < HOUR_MS) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * HOUR_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  return `${Math.floor(diff / (24 * HOUR_MS))}d ago`;
}

function formatTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function formatDuration(run: SchedulerRun): string {
  if (!run.finishedAt) return "running…";
  const ms = run.finishedAt.getTime() - run.startedAt.getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function formatRunDetail(run: SchedulerRun): string {
  if (run.status === "failed") {
    return `${run.errorClass ?? "Error"}: ${run.errorMessage ?? ""}`;
  }
  if (!run.details) return "";
  const d = run.details as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else if (k === "perTarget" && typeof v === "object" && v !== null) {
      const targets = Object.keys(v as Record<string, unknown>);
      if (targets.length > 0) parts.push(`targets=${targets.length}`);
    }
  }
  return parts.join(", ");
}
