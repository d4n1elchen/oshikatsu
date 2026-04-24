import React from "react";
import { render } from "ink";
import App from "./tui/App";

// Clear the terminal screen before rendering the TUI
console.clear();

const { waitUntilExit } = render(<App />);

waitUntilExit().catch(console.error);
