import { chromium } from "playwright";
import { getConfig } from "../config";
import { tagged } from "../core/logger";

const log = tagged("login:twitter");

async function main() {
  const config = getConfig();
  const userDataDir = config.paths.browserData;
  log.info(`Launching browser at ${userDataDir}`);
  log.info("Log into Twitter/X manually; the browser will stay open for 3 minutes");

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // We need to see it to log in
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const page = await context.newPage();
  await page.goto("https://x.com/login");

  // Keep it open for 3 minutes (180,000 ms) to allow manual login + 2FA
  await new Promise((resolve) => setTimeout(resolve, 180000));

  log.info("Time is up; closing browser and saving session");
  await context.close();
  log.info(`Session saved to ${userDataDir}; the automated connector can now run`);
}

main().catch((e) => log.error("Fatal:", e));
