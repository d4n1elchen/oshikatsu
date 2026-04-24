import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import WatchList from "./views/WatchList";
import Monitor from "./views/Monitor";

const TABS = ["watchlist", "monitor"] as const;
type Tab = typeof TABS[number];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("watchlist");

  useInput((input, key) => {
    // Tab switching with 1/2 keys
    if (input === "1") setActiveTab("watchlist");
    if (input === "2") setActiveTab("monitor");

    // Tab key cycles through tabs
    if (key.tab) {
      const currentIndex = TABS.indexOf(activeTab);
      setActiveTab(TABS[(currentIndex + 1) % TABS.length]);
    }

    // Quit with q or Ctrl+C
    if (input === "q") process.exit(0);
  });

  return (
    <Box flexDirection="column" padding={1} width="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={2} marginBottom={1}>
        <Text color="cyan" bold>Oshikatsu</Text>
        <Text dimColor> | Terminal UI</Text>
        <Text dimColor>  (q to quit)</Text>
      </Box>

      {/* Navigation Tabs */}
      <Box marginBottom={1} flexDirection="row" gap={2}>
        <Text
          color={activeTab === "watchlist" ? "white" : "gray"}
          backgroundColor={activeTab === "watchlist" ? "blue" : undefined}
          bold={activeTab === "watchlist"}
        >
          [1] Watch List
        </Text>
        <Text
          color={activeTab === "monitor" ? "white" : "gray"}
          backgroundColor={activeTab === "monitor" ? "blue" : undefined}
          bold={activeTab === "monitor"}
        >
          [2] Monitor
        </Text>
      </Box>

      {/* Main Content Area */}
      <Box flexGrow={1} borderStyle="round" paddingX={1} paddingY={1}>
        {activeTab === "watchlist" && <WatchList />}
        {activeTab === "monitor" && <Monitor />}
      </Box>
    </Box>
  );
}
