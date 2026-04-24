import React, { useEffect, useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { RawStorage } from "../../core/RawStorage";
import type { RawItem } from "../../core/types";

export default function Monitor() {
  const [stats, setStats] = useState<{ total: number; new: number; processed: number; error: number } | null>(null);
  const [recentItems, setRecentItems] = useState<RawItem[]>([]);
  const [loading, setLoading] = useState(true);

  const storage = React.useMemo(() => new RawStorage(), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [s, items] = await Promise.all([
      storage.getStats(),
      storage.getUnprocessed(undefined, 10),
    ]);
    setStats(s);
    setRecentItems(items);
    setLoading(false);
  }, [storage]);

  useEffect(() => { loadData(); }, [loadData]);

  useInput((input) => {
    if (input === "r") {
      loadData();
    }
  });

  if (loading) {
    return <Text>Loading ingestion data...</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold color="magenta" underline>Ingestion Monitor</Text>

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
        <Text bold>Recent Unprocessed Items</Text>
        {recentItems.length === 0 ? (
          <Text color="yellow" italic>No unprocessed items.</Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {recentItems.map((item) => (
              <Box key={item.id} flexDirection="row" gap={2}>
                <Text dimColor>{formatTimestamp(item.fetchedAt)}</Text>
                <Text color="blue">{item.sourceName}</Text>
                <Text>{item.sourceId.substring(0, 20)}</Text>
                <StatusBadge status={item.status} />
              </Box>
            ))}
          </Box>
        )}
      </Box>

      {/* Keybindings */}
      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          <Text color="white">r</Text> Refresh
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
  });
}
