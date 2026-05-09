import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import * as fs from "fs";
import * as path from "path";
import { dashboardRoute } from "./api/dashboard";
import { eventsRoute } from "./api/events";
import { tagged } from "../core/logger";

const log = tagged("WebServer");

const app = new Hono();

app.route("/api", dashboardRoute);
app.route("/api", eventsRoute);

// In production we serve the built client bundle from dist/web. In dev,
// Vite serves the client on its own port and proxies /api here, so we
// skip static mounting when the bundle isn't present.
const clientDist = path.resolve(process.cwd(), "dist/web");
if (fs.existsSync(clientDist)) {
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), clientDist) }));
  app.get("/*", serveStatic({ path: path.relative(process.cwd(), path.join(clientDist, "index.html")) }));
} else {
  log.info("No client bundle at dist/web — running API-only (use Vite for dev client).");
}

const port = Number(process.env.WEB_PORT) || 5174;
serve({ fetch: app.fetch, port }, (info) => {
  log.info(`Listening on http://127.0.0.1:${info.port}`);
});
