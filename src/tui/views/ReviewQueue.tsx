import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { db } from "../../db";
import {
  artists,
  eventResolutionDecisions,
  extractedEvents,
  normalizedEvents,
  venues,
} from "../../db/schema";
import { desc, eq } from "drizzle-orm";
import { EventResolver } from "../../core/EventResolver";

type ReviewItem = {
  decisionId: string;
  decision: string;
  score: number | null;
  signals: Record<string, unknown>;
  reason: string;
  createdAt: Date;
  // Candidate (the extracted event being evaluated)
  extractedId: string;
  candidateTitle: string;
  candidateDescription: string;
  candidateStartTime: Date | null;
  candidateAuthor: string;
  candidateSourceUrl: string;
  candidateRawContent: string;
  candidateScope: string;
  candidateParentHint: string | null;
  candidateArtistName: string | null;
  candidateVenueName: string | null;
  // Matched normalized event (if any)
  matchedId: string | null;
  matchedTitle: string | null;
  matchedStartTime: Date | null;
  matchedVenueName: string | null;
  matchedSourceCount: number;
};

export default function ReviewQueue() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const resolver = React.useMemo(() => new EventResolver(undefined, { quiet: true }), []);

  const loadData = useCallback(async () => {
    setLoading(true);

    const decisions = await db
      .select()
      .from(eventResolutionDecisions)
      .where(eq(eventResolutionDecisions.decision, "needs_review"))
      .orderBy(desc(eventResolutionDecisions.createdAt))
      .limit(100);

    const enriched = await Promise.all(
      decisions.map(async (d): Promise<ReviewItem | null> => {
        const [extractedRows] = await Promise.all([
          db
            .select()
            .from(extractedEvents)
            .where(eq(extractedEvents.id, d.candidateExtractedEventId))
            .limit(1),
        ]);

        const ev = extractedRows[0];
        if (!ev) return null;

        const [artistRows, venueRows, matchedRows] = await Promise.all([
          ev.artistId
            ? db.select({ name: artists.name }).from(artists).where(eq(artists.id, ev.artistId)).limit(1)
            : Promise.resolve([]),
          ev.venueId
            ? db.select({ name: venues.name }).from(venues).where(eq(venues.id, ev.venueId)).limit(1)
            : Promise.resolve([]),
          d.matchedNormalizedEventId
            ? db
                .select()
                .from(normalizedEvents)
                .where(eq(normalizedEvents.id, d.matchedNormalizedEventId))
                .limit(1)
            : Promise.resolve([]),
        ]);

        const matched = matchedRows[0] ?? null;
        const matchedVenue = matched?.venueId
          ? await db.select({ name: venues.name }).from(venues).where(eq(venues.id, matched.venueId)).limit(1)
          : [];

        return {
          decisionId: d.id,
          decision: d.decision,
          score: d.score,
          signals: (d.signals as Record<string, unknown>) ?? {},
          reason: d.reason,
          createdAt: d.createdAt,
          extractedId: ev.id,
          candidateTitle: ev.title,
          candidateDescription: ev.description,
          candidateStartTime: ev.startTime,
          candidateAuthor: ev.author,
          candidateSourceUrl: ev.sourceUrl,
          candidateRawContent: ev.rawContent,
          candidateScope: ev.eventScope,
          candidateParentHint: ev.parentEventHint,
          candidateArtistName: artistRows[0]?.name ?? null,
          candidateVenueName: venueRows[0]?.name ?? ev.venueName ?? null,
          matchedId: matched?.id ?? null,
          matchedTitle: matched?.title ?? null,
          matchedStartTime: matched?.startTime ?? null,
          matchedVenueName: matchedVenue[0]?.name ?? matched?.venueName ?? null,
          matchedSourceCount: 0, // populated below
        };
      })
    ).then((rows) => rows.filter((r): r is ReviewItem => r !== null));

    setItems(enriched);
    setLoading(false);
  }, []);

  React.useEffect(() => { loadData(); }, [loadData]);

  const acceptAsMerge = useCallback(async () => {
    const item = items[cursor];
    if (!item || !item.matchedId) {
      setStatusMessage("⚠ No matched candidate to merge into.");
      return;
    }
    try {
      await resolver.acceptAsMerge(item.extractedId, item.matchedId);
      setStatusMessage(`✓ Merged into "${item.matchedTitle}".`);
      await loadData();
      setCursor(Math.min(cursor, Math.max(0, items.length - 2)));
    } catch (e: any) {
      setStatusMessage(`✗ ${e.message ?? e}`);
    }
  }, [items, cursor, resolver, loadData]);

  const acceptAsNew = useCallback(async () => {
    const item = items[cursor];
    if (!item) return;
    try {
      await resolver.acceptAsNew(item.extractedId);
      setStatusMessage(`✓ Created as new canonical event.`);
      await loadData();
      setCursor(Math.min(cursor, Math.max(0, items.length - 2)));
    } catch (e: any) {
      setStatusMessage(`✗ ${e.message ?? e}`);
    }
  }, [items, cursor, resolver, loadData]);

  useInput((input, key) => {
    if (key.upArrow && cursor > 0) {
      setCursor(cursor - 1);
      setShowRaw(false);
      setStatusMessage(null);
    }
    if (key.downArrow && cursor < items.length - 1) {
      setCursor(cursor + 1);
      setShowRaw(false);
      setStatusMessage(null);
    }
    if (key.return) setShowRaw(!showRaw);
    if (input === "r") loadData();
    if (input === "m") acceptAsMerge();
    if (input === "n") acceptAsNew();
  });

  if (loading) return <Text color="cyan">Loading review queue...</Text>;

  if (items.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">✓ No pending reviews. The resolver is happy.</Text>
        <Text dimColor>Press <Text color="white">r</Text> to refresh.</Text>
      </Box>
    );
  }

  const visibleCount = 10;
  let startIndex = Math.max(0, cursor - Math.floor(visibleCount / 2));
  if (startIndex + visibleCount > items.length) {
    startIndex = Math.max(0, items.length - visibleCount);
  }
  const visible = items.slice(startIndex, startIndex + visibleCount);
  const selected = items[cursor];

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="row" borderStyle="single" borderColor="yellow" paddingX={1} flexGrow={1}>

        {/* Left: list */}
        <Box
          flexDirection="column"
          width="40%"
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
          borderColor="gray"
          paddingRight={1}
        >
          <Box marginBottom={1}>
            <Text bold color="yellow">Review Queue ({items.length})</Text>
          </Box>
          {visible.map((item, idx) => {
            const actualIndex = startIndex + idx;
            const isSelected = actualIndex === cursor;
            return (
              <Box key={item.decisionId} flexDirection="row">
                <Text color={isSelected ? "yellow" : "gray"}>{isSelected ? "▶ " : "  "}</Text>
                <Text color={isSelected ? "white" : "gray"} wrap="truncate">
                  {item.score != null ? `[${item.score.toFixed(2)}] ` : ""}{item.candidateTitle}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Right: details */}
        <Box flexDirection="column" width="60%" paddingLeft={1}>
          {selected ? (
            <Box flexDirection="column">
              <Text bold color="yellow">⚠ Needs Review</Text>
              <Box marginTop={1} flexDirection="column">
                <Text>
                  <Text dimColor>Score:    </Text>
                  {selected.score != null ? selected.score.toFixed(2) : "—"}
                </Text>
                <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
                  <Text>{selected.reason}</Text>
                </Box>
              </Box>

              {/* Candidate */}
              <Box marginTop={1} flexDirection="column">
                <Text bold color="cyan">Candidate (extracted)</Text>
                <Text>
                  <Text dimColor>  Title:  </Text>{selected.candidateTitle}
                </Text>
                {selected.candidateArtistName && (
                  <Text><Text dimColor>  Artist: </Text>{selected.candidateArtistName}</Text>
                )}
                <Text>
                  <Text dimColor>  Time:   </Text>
                  {selected.candidateStartTime
                    ? new Date(selected.candidateStartTime).toLocaleString()
                    : "Unknown"}
                </Text>
                {selected.candidateVenueName && (
                  <Text><Text dimColor>  Venue:  </Text>{selected.candidateVenueName}</Text>
                )}
                <Text>
                  <Text dimColor>  Scope:  </Text>{selected.candidateScope}
                  {selected.candidateParentHint && (
                    <Text dimColor> (hint: "{selected.candidateParentHint}")</Text>
                  )}
                </Text>
                <Text>
                  <Text dimColor>  Source: </Text>
                  <Text color="blue">@{selected.candidateAuthor}</Text>
                </Text>
              </Box>

              {/* Matched */}
              {selected.matchedId && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="green">Matched candidate (normalized)</Text>
                  <Text>
                    <Text dimColor>  Title:  </Text>{selected.matchedTitle}
                  </Text>
                  <Text>
                    <Text dimColor>  Time:   </Text>
                    {selected.matchedStartTime
                      ? new Date(selected.matchedStartTime).toLocaleString()
                      : "Unknown"}
                  </Text>
                  {selected.matchedVenueName && (
                    <Text><Text dimColor>  Venue:  </Text>{selected.matchedVenueName}</Text>
                  )}
                </Box>
              )}

              {/* Signals */}
              <Box marginTop={1} flexDirection="column">
                <Text bold color="magenta">Signals</Text>
                {Object.entries(selected.signals).map(([key, value]) => (
                  <Text key={key}>
                    <Text dimColor>  {key}: </Text>
                    <Text>{String(value)}</Text>
                  </Text>
                ))}
              </Box>

              {/* Raw content */}
              {showRaw && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="blue">Raw content</Text>
                  <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
                    <Text>{selected.candidateRawContent}</Text>
                  </Box>
                  <Text dimColor>{selected.candidateSourceUrl}</Text>
                </Box>
              )}
            </Box>
          ) : (
            <Text dimColor>No item selected.</Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
        <Text dimColor>
          ↑↓ Navigate  <Text color="white">⏎</Text> Raw  <Text color="white">m</Text> Merge into match  <Text color="white">n</Text> Mark as new  <Text color="white">r</Text> Refresh
        </Text>
        {statusMessage && <Text>{statusMessage}</Text>}
      </Box>
    </Box>
  );
}
