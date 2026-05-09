import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web/client",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Anchored regex so the proxy doesn't grab the client's own `api.ts`
      // module import (Vite would otherwise forward `/api.ts` → 404).
      "^/api/": "http://127.0.0.1:5174",
    },
  },
  build: {
    outDir: "../../../dist/web",
    emptyOutDir: true,
  },
});
