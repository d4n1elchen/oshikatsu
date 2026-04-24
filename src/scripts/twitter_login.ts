import { chromium } from "playwright";
import * as path from "path";

async function main() {
  // In ES Modules, __dirname is not defined. Since we run this from the project root, we use process.cwd()
  const userDataDir = path.resolve(process.cwd(), "browser_data");
  console.log(`Launching browser at: ${userDataDir}`);
  console.log("Please log into Twitter/X manually. The browser will stay open for 3 minutes.");

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

  console.log("Time is up! Closing browser and saving session...");
  await context.close();
  console.log("Session saved to browser_data/! You can now run the automated connector.");
}

main().catch(console.error);
