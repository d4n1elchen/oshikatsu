import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { db } from "../../db";
import { preprocessedEvents, preprocessedEventRelatedLinks, sourceReferences, venues } from "../../db/schema";
import { desc, eq } from "drizzle-orm";
import type { PreprocessedEvent, PreprocessedEventRelatedLink, SourceReference, Venue } from "../../core/types";

type EnrichedPreprocessedEvent = PreprocessedEvent & { links: PreprocessedEventRelatedLink[]; refs: SourceReference[]; venue: Venue | null };

export default function Events() {
  const [events, setEvents] = useState<EnrichedPreprocessedEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    
    // Fetch preprocessed events ordered by start_time.
    const recentEvents = await db.select()
      .from(preprocessedEvents)
      .orderBy(desc(preprocessedEvents.startTime))
      .limit(50);

    const enriched = await Promise.all(
      recentEvents.map(async (ev) => {
        const [links, refs, venueRows] = await Promise.all([
          db.select()
            .from(preprocessedEventRelatedLinks)
            .where(eq(preprocessedEventRelatedLinks.preprocessedEventId, ev.id)),
          db.select()
            .from(sourceReferences)
            .where(eq(sourceReferences.preprocessedEventId, ev.id)),
          ev.venueId
            ? db.select().from(venues).where(eq(venues.id, ev.venueId)).limit(1)
            : Promise.resolve([]),
        ]);
        return { ...ev, links, refs, venue: venueRows[0] || null };
      })
    );

    setEvents(enriched);
    setLoading(false);
  }, []);

  React.useEffect(() => { loadEvents(); }, [loadEvents]);

  useInput((input, key) => {
    if (key.upArrow && cursor > 0) {
      setCursor(cursor - 1);
      setIsExpanded(false);
    }
    if (key.downArrow && cursor < events.length - 1) {
      setCursor(cursor + 1);
      setIsExpanded(false);
    }
    if (key.return && events.length > 0) {
      setIsExpanded(!isExpanded);
    }
    if (input === "r") {
      loadEvents();
    }
  });

  if (loading) {
    return <Text color="cyan">Loading Preprocessed Events...</Text>;
  }

  if (events.length === 0) {
    return <Text color="yellow">No preprocessed events found. Run the ingestion daemon!</Text>;
  }

  // Calculate sliding window to keep cursor in view
  const visibleCount = 10;
  let startIndex = Math.max(0, cursor - Math.floor(visibleCount / 2));
  if (startIndex + visibleCount > events.length) {
    startIndex = Math.max(0, events.length - visibleCount);
  }
  const visibleEvents = events.slice(startIndex, startIndex + visibleCount);

  const selectedEvent = events[cursor];

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="row" borderStyle="single" borderColor="cyan" paddingX={1} flexGrow={1}>
        
        {/* Left side: List of events */}
        <Box flexDirection="column" width="40%" borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false} borderColor="gray" paddingRight={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">Preprocessed Events</Text>
          </Box>
          {visibleEvents.map((ev, idx) => {
            const actualIndex = startIndex + idx;
            const isSelected = actualIndex === cursor;
            
            return (
              <Box key={ev.id} flexDirection="row">
                <Text color={isSelected ? "cyan" : "gray"}>
                  {isSelected ? "▶ " : "  "}
                </Text>
                <Text color={isSelected ? "white" : "gray"} wrap="truncate">
                  [{ev.type}] {ev.title}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Right side: Event details */}
        <Box flexDirection="column" width="60%" paddingLeft={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">Preprocessed Event Details</Text>
          </Box>
          {selectedEvent ? (
            <Box flexDirection="column">
              <Text bold>{selectedEvent.title}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text><Text dimColor>Time:  </Text>{selectedEvent.startTime ? new Date(selectedEvent.startTime).toLocaleString() : "Unknown"}</Text>
                <Text><Text dimColor>Type:  </Text>{selectedEvent.type}</Text>
                {(selectedEvent.venueName || selectedEvent.venue) && (
                  <Text>
                    <Text dimColor>Venue: </Text>
                    {selectedEvent.venueName || selectedEvent.venue?.name}
                    {selectedEvent.venue && selectedEvent.venue.name !== selectedEvent.venueName && (
                      <Text dimColor> → {selectedEvent.venue.name}</Text>
                    )}
                    {selectedEvent.venue && (
                      <Text dimColor> [{selectedEvent.venue.kind}, {selectedEvent.venue.status}]</Text>
                    )}
                  </Text>
                )}
                {selectedEvent.tags && selectedEvent.tags.length > 0 && (
                  <Text><Text dimColor>Tags:  </Text>{selectedEvent.tags.join(", ")}</Text>
                )}
              </Box>

              <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
                <Text>{selectedEvent.description}</Text>
              </Box>

              {selectedEvent.links.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="green">Related Links ({selectedEvent.links.length})</Text>
                  {selectedEvent.links.map((link) => (
                    <Box key={link.id} flexDirection="column" marginTop={1}>
                      <Text>
                        <Text dimColor>└─ </Text>
                        <Text color="green">{link.title || link.url}</Text>
                      </Text>
                      {link.title && (
                        <Box marginLeft={3}>
                          <Text dimColor>{link.url}</Text>
                        </Box>
                      )}
                    </Box>
                  ))}
                </Box>
              )}

              <Box marginTop={1} flexDirection="column">
                <Text bold color="blue">Source References ({selectedEvent.refs.length})</Text>
                {selectedEvent.refs.map((ref) => (
                  <Box key={ref.id} flexDirection="column" marginTop={1}>
                    <Text>
                      <Text dimColor>└─ </Text>
                      <Text color="blue">{ref.sourceName}</Text>
                      <Text dimColor> (@{ref.author})</Text>
                    </Text>
                    {isExpanded && (
                      <Box marginLeft={3} marginTop={0} flexDirection="column">
                        <Text dimColor>{ref.url}</Text>
                        {(ref.venueName || ref.venueUrl) && (
                          <Text dimColor>
                            Venue: {ref.venueName || "unknown"}{ref.venueUrl ? ` (${ref.venueUrl})` : ""}
                          </Text>
                        )}
                        <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={0}>
                          <Text>{ref.rawContent}</Text>
                        </Box>
                      </Box>
                    )}
                  </Box>
                ))}
              </Box>
            </Box>
          ) : (
            <Text dimColor>Select an event to view details</Text>
          )}
        </Box>
      </Box>

      {/* Help Bar */}
      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          ↑↓ Navigate  <Text color="white">⏎</Text> Toggle Raw Source  <Text color="white">r</Text> Refresh
        </Text>
      </Box>
    </Box>
  );
}
