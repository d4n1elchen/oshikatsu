import { chromium } from "playwright";
import { getConfig } from "../config";
import { tagged } from "../core/logger";
import { buildLaunchOptions } from "../connectors/twitter/browser";

const log = tagged("login:twitter");

async function main() {
  const config = getConfig();
  const userDataDir = config.paths.browserData;
  log.info(`Launching browser at ${userDataDir}`);
  log.info("Log into Twitter/X manually; the browser will stay open for 3 minutes");

  // Same launch options as the scraping connector — same UA, same viewport,
  // same flags — so the auth cookie minted here doesn't trip X's
  // session-binding heuristics when the connector reuses it.
  const context = await chromium.launchPersistentContext(
    userDataDir,
    buildLaunchOptions({ userDataDir, headless: false })
  );

  const page = await context.newPage();
  await page.goto("https://x.com/login");

  // Keep it open for 3 minutes (180,000 ms) to allow manual login + 2FA
  await new Promise((resolve) => setTimeout(resolve, 180000));

  log.info("Time is up; closing browser and saving session");
  await context.close();
  log.info(`Session saved to ${userDataDir}; the automated connector can now run`);
}

main().catch((e) => log.error("Fatal:", e));
