import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { WatchListManager } from "../../core/WatchListManager";
import type { Artist, SourceEntry } from "../../core/types";

type Mode = "browse" | "add-artist" | "edit-artist" | "add-source";

interface FormState {
  step: number;
  name: string;
  categories: string;
  platform: string;
  username: string;
}

export default function WatchList() {
  const [artists, setArtists] = useState<(Artist & { sources?: SourceEntry[] })[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [expandedArtistId, setExpandedArtistId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("browse");
  const [form, setForm] = useState<FormState>({ step: 0, name: "", categories: "", platform: "twitter", username: "" });
  const [message, setMessage] = useState<string | null>(null);

  const wlm = React.useMemo(() => new WatchListManager(), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    const data = await wlm.listArtists();
    // Load sources for each artist
    const enriched = await Promise.all(
      data.map(async (artist) => ({
        ...artist,
        sources: await wlm.getSourcesForArtist(artist.id),
      }))
    );
    setArtists(enriched);
    setLoading(false);
  }, [wlm]);

  React.useEffect(() => { loadData(); }, [loadData]);

  // Show a temporary message
  const flash = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 2000);
  };

  useInput(async (input, key) => {
    if (mode !== "browse") return;

    if (key.upArrow && cursor > 0) {
      setCursor(cursor - 1);
    }
    if (key.downArrow && cursor < artists.length - 1) {
      setCursor(cursor + 1);
    }

    // Toggle expand/collapse
    if (key.return && artists.length > 0) {
      const selected = artists[cursor];
      setExpandedArtistId(expandedArtistId === selected.id ? null : selected.id);
    }

    // Add artist
    if (input === "a") {
      setMode("add-artist");
    }

    // Edit artist
    if (input === "e" && artists.length > 0) {
      setMode("edit-artist");
    }

    // Add source to selected artist
    if (input === "s" && artists.length > 0) {
      setMode("add-source");
      setForm({ step: 0, name: "", categories: "", platform: "twitter", username: "" });
    }

    // Toggle artist
    if (input === "t" && artists.length > 0) {
      const selected = artists[cursor];
      await wlm.toggleArtist(selected.id, !selected.enabled);
      flash(`${selected.name} ${selected.enabled ? "disabled" : "enabled"}`);
      await loadData();
    }

    // Delete artist
    if (input === "d" && artists.length > 0) {
      const selected = artists[cursor];
      await wlm.removeArtist(selected.id);
      flash(`Deleted ${selected.name}`);
      if (cursor >= artists.length - 1 && cursor > 0) setCursor(cursor - 1);
      await loadData();
    }
  });

  // --- Artist Form (Add/Edit) ---
  if (mode === "add-artist" || mode === "edit-artist") {
    const isEdit = mode === "edit-artist";
    const selectedArtist = isEdit && artists.length > 0 ? artists[cursor] : null;

    return (
      <ArtistForm
        initialName={selectedArtist?.name || ""}
        initialCategories={selectedArtist?.categories.join(", ") || ""}
        initialGroups={selectedArtist?.groups.join(", ") || ""}
        isEdit={isEdit}
        onDone={async (name, categories, groups) => {
          if (name.trim()) {
            const cats = categories.split(",").map(s => s.trim()).filter(Boolean);
            const grps = groups.split(",").map(s => s.trim()).filter(Boolean);
            
            if (isEdit && selectedArtist) {
              await wlm.updateArtist(selectedArtist.id, { name: name.trim(), categories: cats, groups: grps });
              flash(`Updated ${name.trim()}`);
            } else {
              await wlm.addArtist(name.trim(), cats, grps);
              flash(`Added ${name.trim()}`);
            }
          }
          setMode("browse");
          await loadData();
        }}
        onCancel={() => setMode("browse")}
      />
    );
  }

  // --- Add Source Form ---
  if (mode === "add-source" && artists.length > 0) {
    const selectedArtist = artists[cursor];
    return (
      <AddSourceForm
        artistName={selectedArtist.name}
        onDone={async (username) => {
          if (username.trim()) {
            await wlm.addSource(selectedArtist.id, "twitter", "user_timeline", { username: username.trim() });
            flash(`Added source @${username.trim()} to ${selectedArtist.name}`);
          }
          setMode("browse");
          await loadData();
        }}
        onCancel={() => setMode("browse")}
      />
    );
  }

  // --- Browse Mode ---
  if (loading) {
    return <Text>Loading artists...</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold color="green" underline>Watch List</Text>

      {artists.length === 0 ? (
        <Box marginTop={1}>
          <Text color="yellow">No artists yet. Press <Text bold color="white">a</Text> to add one.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {artists.map((artist, i) => (
            <Box key={artist.id} flexDirection="column">
              <Box>
                <Text color={i === cursor ? "cyan" : undefined}>
                  {i === cursor ? "▸ " : "  "}
                </Text>
                <Text bold={i === cursor} color={artist.enabled ? "white" : "gray"} strikethrough={!artist.enabled}>
                  {artist.name}
                </Text>
                <Text dimColor> [{artist.categories.join(", ") || "no tags"}]</Text>
                {artist.groups && artist.groups.length > 0 && (
                  <Text dimColor> &lt;{artist.groups.join(", ")}&gt;</Text>
                )}
                <Text> {artist.enabled ? "✅" : "❌"}</Text>
                {artist.sources && artist.sources.length > 0 && (
                  <Text dimColor> ({artist.sources.length} source{artist.sources.length > 1 ? "s" : ""})</Text>
                )}
              </Box>

              {/* Expanded source list */}
              {expandedArtistId === artist.id && artist.sources && (
                <Box flexDirection="column" marginLeft={4} marginBottom={1}>
                  {artist.sources.length === 0 ? (
                    <Text dimColor italic>No sources configured</Text>
                  ) : (
                    artist.sources.map(src => (
                      <Box key={src.id}>
                        <Text color={src.enabled ? "green" : "gray"}>
                          {src.enabled ? "● " : "○ "}
                        </Text>
                        <Text dimColor>{src.platform}</Text>
                        <Text> @{(src.sourceConfig as any).username || "?"}</Text>
                      </Box>
                    ))
                  )}
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Message flash */}
      {message && (
        <Box marginTop={1}>
          <Text color="yellow" italic>{message}</Text>
        </Box>
      )}

      {/* Keybindings help */}
      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          ↑↓ Navigate  ⏎ Expand  <Text color="white">a</Text> Add Artist  <Text color="white">e</Text> Edit  <Text color="white">s</Text> Add Source  <Text color="white">t</Text> Toggle  <Text color="white">d</Text> Delete
        </Text>
      </Box>
    </Box>
  );
}

// --- Sub-components ---

function ArtistForm({ initialName = "", initialCategories = "", initialGroups = "", isEdit, onDone, onCancel }: {
  initialName?: string;
  initialCategories?: string;
  initialGroups?: string;
  isEdit: boolean;
  onDone: (name: string, categories: string, groups: string) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(initialName);
  const [categories, setCategories] = useState(initialCategories);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const title = isEdit ? "Edit Artist" : "Add Artist";

  if (step === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">{title}</Text>
        <Box marginTop={1}>
          <Text>Name: </Text>
          <TextInput
            key={`artist-name-${isEdit}`}
            placeholder="Artist name..."
            defaultValue={name}
            onSubmit={(value: string) => {
              setName(value);
              setStep(1);
            }}
          />
        </Box>
        <Text dimColor>Press Esc to cancel</Text>
      </Box>
    );
  }

  if (step === 1) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">{title}: {name}</Text>
        <Box marginTop={1}>
          <Text>Categories (comma-separated): </Text>
          <TextInput
            key={`artist-categories-${isEdit}`}
            placeholder="singer, vtuber..."
            defaultValue={categories}
            onSubmit={(value: string) => {
              setCategories(value);
              setStep(2);
            }}
          />
        </Box>
        <Text dimColor>Press Esc to cancel, Enter to skip</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{title}: {name}</Text>
      <Box marginTop={1}>
        <Text>Groups (comma-separated): </Text>
        <TextInput
          key={`artist-groups-${isEdit}`}
          placeholder="hololive, nijisanji..."
          defaultValue={initialGroups}
          onSubmit={(value: string) => {
            onDone(name, categories, value);
          }}
        />
      </Box>
      <Text dimColor>Press Esc to cancel, Enter to skip</Text>
    </Box>
  );
}

function AddSourceForm({ artistName, onDone, onCancel }: {
  artistName: string;
  onDone: (username: string) => void;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Add Source for: {artistName}</Text>
      <Box marginTop={1}>
        <Text>Twitter/X username: </Text>
        <TextInput
          key="source-username"
          placeholder="username (no @)..."
          onSubmit={(value: string) => {
            onDone(value);
          }}
        />
      </Box>
      <Text dimColor>Press Esc to cancel</Text>
    </Box>
  );
}

