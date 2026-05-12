import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const guildId = "1502315385523802215";
const channelId = process.argv[2] ?? "1502914420802846742";
const statePath = "output/playwright/discord-state.json";
const screenshotPath = `output/playwright/discord-transcript-${channelId}.png`;

await mkdir("output/playwright", { recursive: true });

const browser = await chromium.launch({
  headless: false,
  slowMo: 60,
});
const context = await browser.newContext({
  storageState: statePath,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();

try {
  await page.goto(`https://discord.com/channels/${guildId}/${channelId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(12000);

  const visibleText = await page.locator("body").innerText({ timeout: 10000 });
  const visibleLines = visibleText.split(/\r?\n/);
  const result = {
    url: page.url(),
    title: await page.title(),
    loggedIn: !page.url().includes("/login"),
    hasVisibleTranscriptMetadata: visibleLines.some((line) => line.trim().startsWith("[Transcript")),
    hasCodexPrefix: visibleText.includes("Codex:"),
    hasUserPrefix: visibleText.includes("User:"),
    screenshotPath,
  };

  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
