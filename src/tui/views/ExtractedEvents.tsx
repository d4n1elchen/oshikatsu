import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { db } from "../../db";
import { artists, extractedEvents, extractedEventRelatedLinks, rawItems, venues } from "../../db/schema";
import { desc, eq } from "drizzle-orm";
import type { ExtractedEvent, ExtractedEventRelatedLink, Venue } from "../../core/types";

type EnrichedExtractedEvent = ExtractedEvent & {
  links: ExtractedEventRelatedLink[];
  venue: Venue | null;
  sourceName: string | null;
  artistName: string | null;
};

export default function ExtractedEvents() {
  const [events, setEvents] = useState<EnrichedExtractedEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    
    // Fetch extracted events ordered by start_time.
    const recentEvents = await db.select()
      .from(extractedEvents)
      .orderBy(desc(extractedEvents.startTime))
      .limit(50);

    const enriched = await Promise.all(
      recentEvents.map(async (ev) => {
        const [links, venueRows, rawItemRows, artistRows] = await Promise.all([
          db.select()
            .from(extractedEventRelatedLinks)
            .where(eq(extractedEventRelatedLinks.extractedEventId, ev.id)),
          ev.venueId
            ? db.select().from(venues).where(eq(venues.id, ev.venueId)).limit(1)
            : Promise.resolve([]),
          db.select({ sourceName: rawItems.sourceName })
            .from(rawItems)
            .where(eq(rawItems.id, ev.rawItemId))
            .limit(1),
          ev.artistId
            ? db.select({ name: artists.name })
                .from(artists)
                .where(eq(artists.id, ev.artistId))
                .limit(1)
            : Promise.resolve([]),
        ]);
        return {
          ...ev,
          links,
          venue: venueRows[0] || null,
          sourceName: rawItemRows[0]?.sourceName ?? null,
          artistName: artistRows[0]?.name ?? null,
        };
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
    return <Text color="cyan">Loading Extracted Events...</Text>;
  }

  if (events.length === 0) {
    return <Text color="yellow">No extracted events found. Run the ingestion daemon!</Text>;
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
            <Text bold color="cyan">Extracted Events</Text>
          </Box>
          {visibleEvents.map((ev, idx) => {
            const actualIndex = startIndex + idx;
            const isSelected = actualIndex === cursor;
            
            return (
              <Box key={ev.id} flexDirection="row">
                <Text color={isSelected ? "cyan" : "gray"}>
                  {isSelected ? "▶ " : "  "}
                </Text>
                <Text
                  color={isSelected ? "white" : "gray"}
                  strikethrough={ev.isCancelled}
                  wrap="truncate"
                >
                  [{ev.type}] {ev.title}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Right side: Event details */}
        <Box flexDirection="column" width="60%" paddingLeft={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">Extracted Event Details</Text>
          </Box>
          {selectedEvent ? (
            <Box flexDirection="column">
              <Text>
                <Text bold strikethrough={selectedEvent.isCancelled}>{selectedEvent.title}</Text>
                {selectedEvent.isCancelled && <Text color="red" bold> [CANCELLED]</Text>}
              </Text>
              <Box marginTop={1} flexDirection="column">
                {selectedEvent.artistName && (
                  <Text><Text dimColor>Artist: </Text>{selectedEvent.artistName}</Text>
                )}
                <Text>
                  <Text dimColor>Time:   </Text>
                  {selectedEvent.startTime ? new Date(selectedEvent.startTime).toLocaleString() : "Unknown"}
                  {selectedEvent.endTime && ` – ${new Date(selectedEvent.endTime).toLocaleString()}`}
                </Text>
                <Text><Text dimColor>Type:   </Text>{selectedEvent.type}</Text>
                <Text><Text dimColor>Scope:  </Text>{selectedEvent.eventScope}</Text>
                {selectedEvent.parentEventHint && (
                  <Text><Text dimColor>Parent: </Text>{selectedEvent.parentEventHint}</Text>
                )}
                {(selectedEvent.venueName || selectedEvent.venue) && (
                  <Box flexDirection="column">
                    <Text>
                      <Text dimColor>Venue:  </Text>
                      {selectedEvent.venueName || selectedEvent.venue?.name}
                      {selectedEvent.venue && selectedEvent.venue.name !== selectedEvent.venueName && (
                        <Text dimColor> → {selectedEvent.venue.name}</Text>
                      )}
                      {selectedEvent.venue && (
                        <Text dimColor> [{selectedEvent.venue.kind}, {selectedEvent.venue.status}]</Text>
                      )}
                    </Text>
                    {selectedEvent.venueUrl && (
                      <Text dimColor>        {selectedEvent.venueUrl}</Text>
                    )}
                  </Box>
                )}
                {selectedEvent.tags && selectedEvent.tags.length > 0 && (
                  <Text><Text dimColor>Tags:   </Text>{selectedEvent.tags.join(", ")}</Text>
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
                <Text bold color="blue">Source</Text>
                <Box flexDirection="column" marginTop={1}>
                  <Text>
                    <Text dimColor>└─ </Text>
                    <Text color="blue">{selectedEvent.sourceName ?? "unknown"}</Text>
                    <Text dimColor> (@{selectedEvent.author})</Text>
                  </Text>
                  <Text>
                    <Text dimColor>   Posted: </Text>
                    {new Date(selectedEvent.publishTime).toLocaleString()}
                  </Text>
                  {isExpanded && (
                    <Box marginLeft={3} marginTop={0} flexDirection="column">
                      <Text dimColor>{selectedEvent.sourceUrl}</Text>
                      <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={0}>
                        <Text>{selectedEvent.rawContent}</Text>
                      </Box>
                    </Box>
                  )}
                </Box>
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
