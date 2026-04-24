import React, { useState } from "react";
import { Box, Text } from "ink";
import WatchList from "./views/WatchList";

export default function App() {
  const [activeTab, setActiveTab] = useState("watchlist");

  return (
    <Box flexDirection="column" padding={1} width="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={2} marginBottom={1}>
        <Text color="cyan" bold>Oshikatsu</Text>
        <Text dimColor> | Terminal UI</Text>
      </Box>

      {/* Navigation Tabs */}
      <Box marginBottom={1} flexDirection="row" gap={2}>
        <Text
          color={activeTab === "watchlist" ? "white" : "gray"}
          backgroundColor={activeTab === "watchlist" ? "blue" : undefined}
          bold={activeTab === "watchlist"}
        >
          [ Watch List ]
        </Text>
        <Text
          color={activeTab === "monitor" ? "white" : "gray"}
          backgroundColor={activeTab === "monitor" ? "blue" : undefined}
          bold={activeTab === "monitor"}
        >
          [ Monitor (WIP) ]
        </Text>
      </Box>

      {/* Main Content Area */}
      <Box flexGrow={1} borderStyle="round" paddingX={1} paddingY={1}>
        {activeTab === "watchlist" && <WatchList />}
        {activeTab === "monitor" && <Text>Monitor implementation coming soon...</Text>}
      </Box>
    </Box>
  );
}
