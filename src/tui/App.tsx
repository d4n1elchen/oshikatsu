import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import WatchList from "./views/WatchList";
import RawItems from "./views/RawItems";
import ExtractedEvents from "./views/ExtractedEvents";
import NormalizedEvents from "./views/NormalizedEvents";

const TABS = ["watchlist", "rawItems", "extractedEvents", "normalizedEvents"] as const;
type Tab = typeof TABS[number];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("watchlist");

  useInput((input, key) => {
    // Tab switching with 1/2/3/4 keys
    if (input === "1") setActiveTab("watchlist");
    if (input === "2") setActiveTab("rawItems");
    if (input === "3") setActiveTab("extractedEvents");
    if (input === "4") setActiveTab("normalizedEvents");

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
          color={activeTab === "rawItems" ? "white" : "gray"}
          backgroundColor={activeTab === "rawItems" ? "blue" : undefined}
          bold={activeTab === "rawItems"}
        >
          [2] Raw Items
        </Text>
        <Text
          color={activeTab === "extractedEvents" ? "white" : "gray"}
          backgroundColor={activeTab === "extractedEvents" ? "blue" : undefined}
          bold={activeTab === "extractedEvents"}
        >
          [3] Extracted Events
        </Text>
        <Text
          color={activeTab === "normalizedEvents" ? "white" : "gray"}
          backgroundColor={activeTab === "normalizedEvents" ? "blue" : undefined}
          bold={activeTab === "normalizedEvents"}
        >
          [4] Normalized Events
        </Text>
      </Box>

      {/* Main Content Area */}
      <Box flexGrow={1} borderStyle="round" paddingX={1} paddingY={1}>
        {activeTab === "watchlist" && <WatchList />}
        {activeTab === "rawItems" && <RawItems />}
        {activeTab === "extractedEvents" && <ExtractedEvents />}
        {activeTab === "normalizedEvents" && <NormalizedEvents />}
      </Box>
    </Box>
  );
}
