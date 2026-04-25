import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { db } from "../../db";
import { normalizedEvents, sourceReferences } from "../../db/schema";
import { desc, eq } from "drizzle-orm";
import type { NormalizedEvent, SourceReference } from "../../core/types";

type EnrichedEvent = NormalizedEvent & { refs: SourceReference[] };

export default function Events() {
  const [events, setEvents] = useState<EnrichedEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    
    // Fetch events ordered by event_time
    const recentEvents = await db.select()
      .from(normalizedEvents)
      .orderBy(desc(normalizedEvents.eventTime))
      .limit(50);

    const enriched = await Promise.all(
      recentEvents.map(async (ev) => {
        const refs = await db.select()
          .from(sourceReferences)
          .where(eq(sourceReferences.eventId, ev.id));
        return { ...ev, refs };
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
    return <Text color="cyan">Loading Events...</Text>;
  }

  if (events.length === 0) {
    return <Text color="yellow">No normalized events found. Run the ingestion daemon!</Text>;
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
            <Text bold color="cyan">Normalized Events</Text>
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
            <Text bold color="cyan">Event Details</Text>
          </Box>
          {selectedEvent ? (
            <Box flexDirection="column">
              <Text bold>{selectedEvent.title}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text><Text dimColor>Time:  </Text>{new Date(selectedEvent.eventTime).toLocaleString()}</Text>
                <Text><Text dimColor>Type:  </Text>{selectedEvent.type}</Text>
                {selectedEvent.venueName && (
                  <Text><Text dimColor>Venue: </Text>{selectedEvent.venueName}</Text>
                )}
                {selectedEvent.tags && selectedEvent.tags.length > 0 && (
                  <Text><Text dimColor>Tags:  </Text>{selectedEvent.tags.join(", ")}</Text>
                )}
              </Box>

              <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
                <Text>{selectedEvent.description}</Text>
              </Box>

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
