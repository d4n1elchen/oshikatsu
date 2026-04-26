import React from "react";
import { render } from "ink";
import App from "./tui/App";
import { setSilent } from "./core/logger";

// Suppress core-module logs to avoid corrupting Ink's rendered output.
setSilent(true);

// Clear the terminal screen before rendering the TUI
console.clear();

const { waitUntilExit } = render(<App />);

waitUntilExit().catch((e) => {
  setSilent(false);
  console.error(e);
});
