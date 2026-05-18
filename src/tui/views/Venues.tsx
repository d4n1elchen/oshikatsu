import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import {
  listVenues,
  updateVenue,
  type VenueListItem,
} from "../../core/queries/VenuesQueries";

type StatusFilter = "all" | "discovered" | "verified" | "ignored";
type EditField = "url" | "city" | null;

const FILTERS: StatusFilter[] = ["all", "discovered", "verified", "ignored"];
const KIND_CYCLE: VenueListItem["kind"][] = ["unknown", "physical", "virtual"];

export default function Venues() {
  const [venues, setVenues] = useState<VenueListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [editing, setEditing] = useState<EditField>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (next: StatusFilter) => {
    setLoading(true);
    const rows = await listVenues({ status: next === "all" ? undefined : next });
    setVenues(rows);
    setLoading(false);
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, []);

  useEffect(() => { void reload(filter); }, [reload, filter]);

  const flash = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 2000);
  };

  const selected = venues[cursor];

  const patchSelected = useCallback(
    async (fields: Parameters<typeof updateVenue>[1], label: string) => {
      if (!selected) return;
      await updateVenue(selected.id, fields);
      flash(label);
      await reload(filter);
    },
    [selected, reload, filter],
  );

  useInput(async (input, key) => {
    if (editing !== null) return;

    if (key.upArrow && cursor > 0) setCursor(cursor - 1);
    if (key.downArrow && cursor < venues.length - 1) setCursor(cursor + 1);

    if (input === "f") {
      const next = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length];
      setFilter(next);
    }
    if (input === "r") {
      await reload(filter);
      flash("Reloaded");
    }
    if (!selected) return;

    if (input === "v" && selected.status !== "verified") {
      await patchSelected({ status: "verified" }, `Verified ${selected.name}`);
    }
    if (input === "i" && selected.status !== "ignored") {
      await patchSelected({ status: "ignored" }, `Ignored ${selected.name}`);
    }
    if (input === "d" && selected.status !== "discovered") {
      await patchSelected({ status: "discovered" }, `Back to discovered`);
    }
    if (input === "k") {
      const next = KIND_CYCLE[(KIND_CYCLE.indexOf(selected.kind) + 1) % KIND_CYCLE.length];
      await patchSelected({ kind: next }, `Kind → ${next}`);
    }
    if (input === "u") setEditing("url");
    if (input === "c") setEditing("city");
  });

  if (editing && selected) {
    return (
      <EditFieldForm
        venueName={selected.name}
        field={editing}
        initial={editing === "url" ? selected.url ?? "" : selected.city ?? ""}
        onDone={async (value) => {
          const trimmed = value.trim();
          const next = trimmed || null;
          await patchSelected(
            editing === "url" ? { url: next } : { city: next },
            editing === "url" ? `URL updated` : `City updated`,
          );
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (loading) return <Text>Loading venues…</Text>;

  return (
    <Box flexDirection="column">
      <Text bold color="green" underline>Venues</Text>

      <Box marginTop={1}>
        <Text dimColor>Filter: </Text>
        {FILTERS.map((f, i) => (
          <Text
            key={f}
            color={f === filter ? "white" : "gray"}
            backgroundColor={f === filter ? "blue" : undefined}
            bold={f === filter}
          >
            {i > 0 ? " " : ""}{f}
          </Text>
        ))}
      </Box>

      {venues.length === 0 ? (
        <Box marginTop={1}>
          <Text color="yellow">No venues in this bucket.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <VenueHeader />
          {venues.map((v, i) => (
            <VenueRow key={v.id} venue={v} selected={i === cursor} />
          ))}
        </Box>
      )}

      {message && (
        <Box marginTop={1}>
          <Text color="yellow" italic>{message}</Text>
        </Box>
      )}

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          ↑↓ Nav  <Text color="white">f</Text> Filter  <Text color="white">v</Text> Verify  <Text color="white">i</Text> Ignore  <Text color="white">d</Text> Discovered  <Text color="white">k</Text> Kind  <Text color="white">u</Text> URL  <Text color="white">c</Text> City  <Text color="white">r</Text> Reload
        </Text>
      </Box>
    </Box>
  );
}

// Fixed-width text columns keep alignment predictable across rows even when
// some fields are empty. Truncation is intentional — the TUI is for triage,
// not full inspection; use the web admin for long names.
function VenueHeader() {
  return (
    <Box>
      <Text color="gray">{pad("STATUS", 11)}</Text>
      <Text color="gray">{pad("NAME", 32)}</Text>
      <Text color="gray">{pad("KIND", 10)}</Text>
      <Text color="gray">{pad("URL", 36)}</Text>
      <Text color="gray">{pad("CITY", 14)}</Text>
      <Text color="gray">{pad("ALI", 4)}</Text>
      <Text color="gray">{pad("MENT", 5)}</Text>
    </Box>
  );
}

function VenueRow({ venue, selected }: { venue: VenueListItem; selected: boolean }) {
  const isIgnored = venue.status === "ignored";
  const isDiscovered = venue.status === "discovered";
  const statusColor =
    venue.status === "verified" ? "green" :
    venue.status === "discovered" ? "yellow" :
    "gray";
  return (
    <Box>
      <Text color={selected ? "cyan" : undefined}>{selected ? "▸ " : "  "}</Text>
      <Text color={statusColor}>{pad(venue.status, 9)}</Text>
      <Text bold={selected} dimColor={isIgnored} strikethrough={isIgnored}>
        {pad(venue.name, 32)}
      </Text>
      <Text dimColor>{pad(venue.kind, 10)}</Text>
      <Text color={venue.url ? "blue" : "red"}>
        {pad(venue.url ?? (isDiscovered ? "(missing)" : "—"), 36)}
      </Text>
      <Text dimColor>{pad(venue.city ?? "—", 14)}</Text>
      <Text dimColor>{pad(String(venue.aliasCount), 4)}</Text>
      <Text dimColor>{pad(String(venue.eventMentionCount), 5)}</Text>
    </Box>
  );
}

function EditFieldForm({
  venueName,
  field,
  initial,
  onDone,
  onCancel,
}: {
  venueName: string;
  field: "url" | "city";
  initial: string;
  onDone: (value: string) => void;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });
  const placeholder = field === "url" ? "https://…" : "Tokyo, San Jose, …";
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Edit {field}: {venueName}</Text>
      <Box marginTop={1}>
        <Text>{field === "url" ? "URL: " : "City: "}</Text>
        <TextInput
          key={`venue-${field}`}
          placeholder={placeholder}
          defaultValue={initial}
          onSubmit={onDone}
        />
      </Box>
      <Text dimColor>Press Esc to cancel · empty to clear</Text>
    </Box>
  );
}

function pad(s: string, width: number): string {
  if (s.length === width) return s;
  if (s.length < width) return s + " ".repeat(width - s.length);
  return s.slice(0, Math.max(0, width - 1)) + "…";
}
