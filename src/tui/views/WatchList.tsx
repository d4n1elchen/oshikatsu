import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { WatchListManager } from "../../core/WatchListManager";
import type { Artist, WatchTarget } from "../../core/types";

type Mode = "browse" | "add-artist" | "edit-artist" | "add-target";

interface FormState {
  step: number;
  name: string;
  categories: string;
  platform: string;
  username: string;
}

export default function WatchList() {
  const [artists, setArtists] = useState<(Artist & { targets?: WatchTarget[] })[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [expandedArtistId, setExpandedArtistId] = useState<string | null>(null);
  const [targetCursor, setTargetCursor] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("browse");
  const [form, setForm] = useState<FormState>({ step: 0, name: "", categories: "", platform: "twitter", username: "" });
  const [message, setMessage] = useState<string | null>(null);

  const wlm = React.useMemo(() => new WatchListManager(), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    const data = await wlm.listArtists();
    // Load targets for each artist
    const enriched = await Promise.all(
      data.map(async (artist) => ({
        ...artist,
        targets: await wlm.getTargetsForArtist(artist.id),
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

    const isExpanded = expandedArtistId !== null;
    const selectedArtist = artists[cursor];

    if (key.upArrow) {
      if (isExpanded && targetCursor !== null) {
        if (targetCursor > 0) setTargetCursor(targetCursor - 1);
        else {
          setExpandedArtistId(null);
          setTargetCursor(null);
        }
      } else if (cursor > 0) {
        setCursor(cursor - 1);
        setExpandedArtistId(null);
      }
    }
    
    if (key.downArrow) {
      if (isExpanded && targetCursor !== null && selectedArtist.targets) {
        if (targetCursor < selectedArtist.targets.length - 1) setTargetCursor(targetCursor + 1);
      } else if (cursor < artists.length - 1) {
        setCursor(cursor + 1);
        setExpandedArtistId(null);
      }
    }

    // Toggle expand/collapse
    if (key.return && artists.length > 0) {
      if (expandedArtistId === selectedArtist.id) {
        setExpandedArtistId(null);
        setTargetCursor(null);
      } else {
        setExpandedArtistId(selectedArtist.id);
        setTargetCursor(selectedArtist.targets && selectedArtist.targets.length > 0 ? 0 : null);
      }
    }

    // Add artist
    if (input === "a") {
      setMode("add-artist");
    }

    // Edit artist
    if (input === "e" && artists.length > 0) {
      setMode("edit-artist");
    }

    // Add target to selected artist
    if (input === "s" && artists.length > 0) {
      setMode("add-target");
      setForm({ step: 0, name: "", categories: "", platform: "twitter", username: "" });
    }

    // Toggle artist or target
    if (input === "t" && artists.length > 0) {
      if (isExpanded && targetCursor !== null && selectedArtist.targets) {
        const target = selectedArtist.targets[targetCursor];
        await wlm.toggleTarget(target.id, !target.enabled);
        flash(`Target ${target.enabled ? "disabled" : "enabled"}`);
      } else {
        await wlm.toggleArtist(selectedArtist.id, !selectedArtist.enabled);
        flash(`${selectedArtist.name} ${selectedArtist.enabled ? "disabled" : "enabled"}`);
      }
      await loadData();
    }

    // Delete artist or target
    if (input === "d" && artists.length > 0) {
      if (isExpanded && targetCursor !== null && selectedArtist.targets) {
        const target = selectedArtist.targets[targetCursor];
        await wlm.removeTarget(target.id);
        flash(`Deleted target`);
        
        // Adjust cursor
        if (targetCursor >= selectedArtist.targets.length - 1 && targetCursor > 0) {
          setTargetCursor(targetCursor - 1);
        } else if (selectedArtist.targets.length === 1) {
          setTargetCursor(null);
        }
      } else {
        await wlm.removeArtist(selectedArtist.id);
        flash(`Deleted ${selectedArtist.name}`);
        if (cursor >= artists.length - 1 && cursor > 0) setCursor(cursor - 1);
        setExpandedArtistId(null);
        setTargetCursor(null);
      }
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

  // --- Add Target Form ---
  if (mode === "add-target" && artists.length > 0) {
    const selectedArtist = artists[cursor];
    return (
      <AddTargetForm
        artistName={selectedArtist.name}
        onDone={async (username) => {
          if (username.trim()) {
            await wlm.addTarget(selectedArtist.id, "twitter", "user_timeline", { username: username.trim() });
            flash(`Added target @${username.trim()} to ${selectedArtist.name}`);
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
                  <Text dimColor> {`<${artist.groups.join(", ")}>`}</Text>
                )}
                <Text> {artist.enabled ? "✅" : "❌"}</Text>
                {artist.targets && artist.targets.length > 0 && (
                  <Text dimColor> ({artist.targets.length} target{artist.targets.length > 1 ? "s" : ""})</Text>
                )}
              </Box>

              {/* Targets List (Expanded) */}
              {expandedArtistId === artist.id && artist.targets && (
                <Box flexDirection="column" marginLeft={4} marginTop={1} marginBottom={1}>
                  {artist.targets.length === 0 ? (
                    <Text color="yellow" italic>No targets configured.</Text>
                  ) : (
                    artist.targets.map((target, targetIdx) => (
                      <Box key={target.id} flexDirection="row" gap={2}>
                        <Text color={targetCursor === targetIdx ? "cyan" : undefined}>
                          {targetCursor === targetIdx ? "▸" : "└─"}
                        </Text>
                        <Text color="blue">{target.platform}</Text>
                        <Text color="cyan">{target.sourceConfig.username ? `@${target.sourceConfig.username}` : target.sourceType}</Text>
                        <Text> {target.enabled ? "✅" : "❌"}</Text>
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
          ↑↓ Navigate  ⏎ Expand  <Text color="white">a</Text> Add Artist  <Text color="white">e</Text> Edit  <Text color="white">s</Text> Add Target  <Text color="white">t</Text> Toggle  <Text color="white">d</Text> Delete
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

function AddTargetForm({ artistName, onDone, onCancel }: {
  artistName: string;
  onDone: (username: string) => void;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Add Target for: {artistName}</Text>
      <Box marginTop={1}>
        <Text>Twitter/X username: </Text>
        <TextInput
          key="target-username"
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

