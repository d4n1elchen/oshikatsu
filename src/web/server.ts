import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import * as path from "path";
import { dashboardRoute } from "./api/dashboard";
import { tagged } from "../core/logger";

const log = tagged("WebServer");

const app = new Hono();

app.route("/api", dashboardRoute);

// Static client bundle (only matters in production; dev runs Vite on its own port).
const clientDist = path.resolve(process.cwd(), "dist/web");
app.use("/*", serveStatic({ root: clientDist }));
app.get("/*", serveStatic({ path: path.join(clientDist, "index.html") }));

const port = Number(process.env.WEB_PORT) || 5174;
serve({ fetch: app.fetch, port }, (info) => {
  log.info(`Listening on http://127.0.0.1:${info.port}`);
});
