import React, { useEffect, useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { RawStorage } from "../../core/RawStorage";
import type { RawItem } from "../../core/types";

export default function RawItems() {
  const [stats, setStats] = useState<{ total: number; new: number; processed: number; error: number } | null>(null);
  const [recentItems, setRecentItems] = useState<RawItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  const storage = React.useMemo(() => new RawStorage(), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [s, items] = await Promise.all([
      storage.getStats(),
      // Include error items so the [x] retry keybinding has reachable targets;
      // otherwise the only way to clear failures was the extract:once script.
      storage.getQueueAndErrors(undefined, 100),
    ]);
    setStats(s);
    setRecentItems(items);
    setLoading(false);
  }, [storage]);

  useEffect(() => { loadData(); }, [loadData]);

  useInput((input, key) => {
    // Refresh
    if (input === "r") {
      loadData();
      return;
    }

    if (recentItems.length === 0) return;

    // Navigation
    if (key.upArrow && cursor > 0) {
      const newCursor = cursor - 1;
      setCursor(newCursor);
      if (newCursor < windowStart) setWindowStart(newCursor);
    }
    if (key.downArrow && cursor < recentItems.length - 1) {
      const newCursor = cursor + 1;
      setCursor(newCursor);
      if (newCursor >= windowStart + 10) setWindowStart(newCursor - 9);
    }

    // Expand / Collapse
    if (key.return) {
      const selected = recentItems[cursor];
      setExpandedItemId(expandedItemId === selected.id ? null : selected.id);
    }

    // Collapse on Esc
    if (key.escape) {
      setExpandedItemId(null);
    }

    // Force retry (mark as new)
    if (input === "x" && recentItems.length > 0) {
      const selected = recentItems[cursor];
      if (selected.status === "error") {
        storage.markNew(selected.id).then(() => loadData());
      }
    }
  });

  if (loading) {
    return <Text>Loading ingestion data...</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold color="magenta" underline>Raw Items</Text>

      {/* Stats Dashboard */}
      {stats && (
        <Box marginTop={1} flexDirection="row" gap={3}>
          <Box flexDirection="column">
            <Text dimColor>Total</Text>
            <Text bold>{stats.total}</Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>New</Text>
            <Text bold color="cyan">{stats.new}</Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>Processed</Text>
            <Text bold color="green">{stats.processed}</Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>Errors</Text>
            <Text bold color="red">{stats.error}</Text>
          </Box>
        </Box>
      )}

      {/* Recent Items */}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Pending &amp; Errored Items</Text>
        {recentItems.length === 0 ? (
          <Text color="yellow" italic>No pending or errored items.</Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {recentItems.slice(windowStart, windowStart + 10).map((item, index) => {
              const actualIndex = windowStart + index;
              const tweetText = item.rawData?.legacy?.full_text || "[No text found]";
              const snippet = tweetText.replace(/\n/g, " ").substring(0, 40) + (tweetText.length > 40 ? "..." : "");
              const rawCreatedAt = item.rawData?.legacy?.created_at;
              const postTime = rawCreatedAt ? formatTimestamp(new Date(rawCreatedAt)) : "Unknown post time";
              const isSelected = actualIndex === cursor;
              const isExpanded = expandedItemId === item.id;
              
              return (
                <Box key={item.id} flexDirection="column">
                  <Box flexDirection="row" gap={2}>
                    <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "▸" : " "}</Text>
                    <Text dimColor>↓ {formatTimestamp(item.fetchedAt)}</Text>
                    <Text color="blue">{item.sourceName}</Text>
                    <Text>{item.sourceId.substring(0, 19)}</Text>
                    <StatusBadge status={item.status} />
                    <Text color="gray">✉ {postTime}</Text>
                    <Text dimColor italic>{snippet}</Text>
                  </Box>

                  {/* Expanded JSON View */}
                  {isExpanded && (
                    <Box marginLeft={4} marginTop={1} marginBottom={1} flexDirection="column" gap={1}>
                      {item.status === "error" && item.errorMessage && (
                        <Box borderStyle="single" borderColor="red" padding={1} width="95%" flexDirection="column">
                          <Text color="red" bold>Error</Text>
                          <Text>{item.errorMessage}</Text>
                        </Box>
                      )}
                      <Box borderStyle="single" padding={1} width="95%" flexDirection="column">
                        <Text>{JSON.stringify(item.rawData, null, 2).split("\n").slice(0, 30).join("\n")}</Text>
                        <Text dimColor italic>... (truncated for preview)</Text>
                      </Box>
                    </Box>
                  )}
                </Box>
              );
            })}
            {recentItems.length > 10 && (
              <Box marginTop={1}>
                <Text dimColor italic>
                  Showing {windowStart + 1} - {Math.min(windowStart + 10, recentItems.length)} of {recentItems.length} items
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Keybindings */}
      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          ↑↓ Navigate  ⏎ Expand  <Text color="white">r</Text> Refresh  <Text color="white">x</Text> Retry Error
        </Text>
      </Box>
    </Box>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = status === "new" ? "cyan" : status === "processed" ? "green" : "red";
  return <Text color={color}>[{status}]</Text>;
}

function formatTimestamp(date: Date): string {
  if (!(date instanceof Date)) {
    date = new Date(date as any);
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  });
}
