import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { WatchListManager } from "../../core/WatchListManager";
import type { Artist } from "../../core/types";

export default function WatchList() {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      const wlm = new WatchListManager();
      const data = await wlm.listArtists();
      setArtists(data);
      setLoading(false);
    }
    loadData();
  }, []);

  if (loading) {
    return <Text>Loading artists...</Text>;
  }

  if (artists.length === 0) {
    return <Text color="yellow">No artists in the watch list yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold color="green" underline>Registered Artists</Text>
      <Box flexDirection="column" marginTop={1}>
        {artists.map((artist) => (
          <Box key={artist.id} marginBottom={1} flexDirection="column">
            <Text bold>{artist.name}</Text>
            <Text dimColor>  Categories: {artist.categories.join(", ") || "None"}</Text>
            <Text dimColor>  Status: {artist.enabled ? "✅ Enabled" : "❌ Disabled"}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
