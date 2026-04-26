import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { db } from "../../db";
import { artists, eventResolutionDecisions, extractedEvents, normalizedEventSources, normalizedEvents, venues } from "../../db/schema";
import { count, desc, eq, sql } from "drizzle-orm";
import type { NormalizedEvent, Venue } from "../../core/types";

type EnrichedNormalizedEvent = NormalizedEvent & {
  artistName: string | null;
  venue: Venue | null;
  sourceCount: number;
  latestDecision: string | null;
  latestReason: string | null;
  parentTitle: string | null;
  subEventCount: number;
};

const DECISION_COLOR: Record<string, string> = {
  new: "green",
  merged: "cyan",
  needs_review: "yellow",
  linked_as_sub: "magenta",
  no_match: "gray",
  ignored: "gray",
};

export default function NormalizedEvents() {
  const [events, setEvents] = useState<EnrichedNormalizedEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async () => {
    setLoading(true);

    const rows = await db
      .select()
      .from(normalizedEvents)
      .orderBy(desc(normalizedEvents.startTime))
      .limit(50);

    const enriched = await Promise.all(
      rows.map(async (ev) => {
        const [venueRows, artistRows, sourcesRow, decisionRows, parentRows, subEventRow] = await Promise.all([
          ev.venueId
            ? db.select().from(venues).where(eq(venues.id, ev.venueId)).limit(1)
            : Promise.resolve([]),
          ev.artistId
            ? db.select({ name: artists.name }).from(artists).where(eq(artists.id, ev.artistId)).limit(1)
            : Promise.resolve([]),
          db
            .select({ cnt: count() })
            .from(normalizedEventSources)
            .where(eq(normalizedEventSources.normalizedEventId, ev.id)),
          // Get the resolution decision for the primary source
          db
            .select({
              decision: eventResolutionDecisions.decision,
              reason: eventResolutionDecisions.reason,
            })
            .from(normalizedEventSources)
            .innerJoin(
              eventResolutionDecisions,
              eq(normalizedEventSources.extractedEventId, eventResolutionDecisions.candidateExtractedEventId)
            )
            .where(
              sql`${normalizedEventSources.normalizedEventId} = ${ev.id} AND ${normalizedEventSources.role} = 'primary'`
            )
            .limit(1),
          ev.parentEventId
            ? db
                .select({ title: normalizedEvents.title })
                .from(normalizedEvents)
                .where(eq(normalizedEvents.id, ev.parentEventId))
                .limit(1)
            : Promise.resolve([]),
          db
            .select({ cnt: count() })
            .from(normalizedEvents)
            .where(eq(normalizedEvents.parentEventId, ev.id)),
        ]);

        return {
          ...ev,
          venue: venueRows[0] ?? null,
          artistName: artistRows[0]?.name ?? null,
          sourceCount: sourcesRow[0]?.cnt ?? 0,
          latestDecision: decisionRows[0]?.decision ?? null,
          latestReason: decisionRows[0]?.reason ?? null,
          parentTitle: parentRows[0]?.title ?? null,
          subEventCount: subEventRow[0]?.cnt ?? 0,
        };
      })
    );

    setEvents(enriched);
    setLoading(false);
  }, []);

  React.useEffect(() => { loadEvents(); }, [loadEvents]);

  useInput((input, key) => {
    if (key.upArrow && cursor > 0) setCursor(cursor - 1);
    if (key.downArrow && cursor < events.length - 1) setCursor(cursor + 1);
    if (input === "r") loadEvents();
  });

  if (loading) return <Text color="cyan">Loading Normalized Events...</Text>;

  if (events.length === 0) {
    return <Text color="yellow">No normalized events yet. Run the daemon to trigger resolution.</Text>;
  }

  const visibleCount = 10;
  let startIndex = Math.max(0, cursor - Math.floor(visibleCount / 2));
  if (startIndex + visibleCount > events.length) {
    startIndex = Math.max(0, events.length - visibleCount);
  }
  const visibleEvents = events.slice(startIndex, startIndex + visibleCount);
  const selectedEvent = events[cursor];

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="row" borderStyle="single" borderColor="green" paddingX={1} flexGrow={1}>

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
            <Text bold color="green">Normalized Events</Text>
          </Box>
          {visibleEvents.map((ev, idx) => {
            const actualIndex = startIndex + idx;
            const isSelected = actualIndex === cursor;
            const decisionColor = ev.latestDecision ? (DECISION_COLOR[ev.latestDecision] ?? "gray") : "gray";

            return (
              <Box key={ev.id} flexDirection="row">
                <Text color={isSelected ? "green" : "gray"}>{isSelected ? "▶ " : "  "}</Text>
                <Text color={decisionColor} dimColor={!isSelected}>
                  [{ev.latestDecision ?? "?"}]{" "}
                </Text>
                <Text color={isSelected ? "white" : "gray"} wrap="truncate" strikethrough={ev.isCancelled}>
                  {ev.parentEventId ? "↳ " : ""}{ev.title}
                  {ev.subEventCount > 0 ? ` (+${ev.subEventCount} sub)` : ""}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Right: details */}
        <Box flexDirection="column" width="60%" paddingLeft={1}>
          <Box marginBottom={1}>
            <Text bold color="green">Normalized Event Details</Text>
          </Box>
          {selectedEvent ? (
            <Box flexDirection="column">
              <Text>
                <Text bold strikethrough={selectedEvent.isCancelled}>{selectedEvent.title}</Text>
                {selectedEvent.isCancelled && <Text color="red" bold> [CANCELLED]</Text>}
              </Text>

              <Box marginTop={1} flexDirection="column">
                {selectedEvent.artistName && (
                  <Text><Text dimColor>Artist:   </Text>{selectedEvent.artistName}</Text>
                )}
                <Text>
                  <Text dimColor>Time:     </Text>
                  {selectedEvent.startTime
                    ? new Date(selectedEvent.startTime).toLocaleString()
                    : "Unknown"}
                  {selectedEvent.endTime && ` – ${new Date(selectedEvent.endTime).toLocaleString()}`}
                </Text>
                <Text><Text dimColor>Type:     </Text>{selectedEvent.type}</Text>
                {(selectedEvent.venueName || selectedEvent.venue) && (
                  <Text>
                    <Text dimColor>Venue:    </Text>
                    {selectedEvent.venueName ?? selectedEvent.venue?.name}
                    {selectedEvent.venue && (
                      <Text dimColor> [{selectedEvent.venue.kind}]</Text>
                    )}
                  </Text>
                )}
                {selectedEvent.tags && selectedEvent.tags.length > 0 && (
                  <Text><Text dimColor>Tags:     </Text>{selectedEvent.tags.join(", ")}</Text>
                )}
                {selectedEvent.parentTitle && (
                  <Text>
                    <Text dimColor>Parent:   </Text>
                    <Text color="magenta">↳ {selectedEvent.parentTitle}</Text>
                  </Text>
                )}
                {selectedEvent.subEventCount > 0 && (
                  <Text>
                    <Text dimColor>Sub:      </Text>
                    <Text color="magenta">{selectedEvent.subEventCount} sub-event{selectedEvent.subEventCount !== 1 ? "s" : ""}</Text>
                  </Text>
                )}
              </Box>

              {/* Resolution status */}
              <Box marginTop={1} flexDirection="column">
                <Text bold color="green">Resolution</Text>
                <Box marginTop={1} flexDirection="column">
                  <Text>
                    <Text dimColor>Decision: </Text>
                    <Text color={selectedEvent.latestDecision ? (DECISION_COLOR[selectedEvent.latestDecision] ?? "gray") : "gray"}>
                      {selectedEvent.latestDecision ?? "unknown"}
                    </Text>
                  </Text>
                  <Text>
                    <Text dimColor>Sources:  </Text>
                    {selectedEvent.sourceCount} extracted event{selectedEvent.sourceCount !== 1 ? "s" : ""}
                  </Text>
                  {selectedEvent.latestReason && (
                    <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
                      <Text dimColor>{selectedEvent.latestReason}</Text>
                    </Box>
                  )}
                </Box>
              </Box>

              <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
                <Text>{selectedEvent.description}</Text>
              </Box>
            </Box>
          ) : (
            <Text dimColor>Select an event to view details</Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          ↑↓ Navigate  <Text color="white">r</Text> Refresh
        </Text>
      </Box>
    </Box>
  );
}
