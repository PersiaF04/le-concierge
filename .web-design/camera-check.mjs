/**
 * Camera check, with a fake device so it runs unattended: open the door's
 * camera, take the photograph, and prove an <img> with real pixels replaced
 * the "the door has no photograph yet" placeholder.
 *
 * Needs the door dev server on :5174.
 */
import { findBrowser } from "file:///C:/Users/persi/.claude/skills/web-design/scripts/lib/browser.mjs";
import { mkdir } from "node:fs/promises";

const OUT = "C:/Users/persi/vibe-work/le-concierge-vibe/.web-design/app-shots";
await mkdir(OUT, { recursive: true });

const pw = await import("file:///C:/Users/persi/.claude/skills/web-design/scripts/node_modules/playwright-core/index.mjs");
const executablePath = findBrowser();
const browser = await pw.chromium.launch({
  executablePath,
  headless: true,
  args: [
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 940 },
  permissions: ["camera"],
});
const page = await context.newPage();
const failed = [];
page.on("console", (message) => {
  if (message.type() === "error") failed.push(message.text().slice(0, 160));
});

await page.goto("http://localhost:5174/#door", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Open the camera/i }).click();
await page.waitForTimeout(1200);

const state = await page.evaluate(() => {
  const preview = document.querySelector("video.camera-preview");
  const plate = document.querySelector("video.door-video");
  const info = (element) =>
    element
      ? {
          w: element.videoWidth,
          h: element.videoHeight,
          playing: !element.paused,
          hasStream: Boolean(element.srcObject),
        }
      : null;
  return { preview: info(preview), plate: info(plate) };
});
console.log("video elements after Open the camera:", JSON.stringify(state));

await page.getByRole("button", { name: /Take the photograph/i }).click();
await page.waitForTimeout(900);

const shot = await page.evaluate(() => {
  const img = document.querySelector("figure.door-plate img");
  return img ? { src: img.src.slice(0, 40), width: img.naturalWidth, height: img.naturalHeight } : null;
});
console.log("photograph:", JSON.stringify(shot));

const caption = await page.locator("figure.door-plate figcaption").innerText();
console.log("caption:", caption.trim());

await page.screenshot({ path: `${OUT}/live-door-camera.png` });
console.log("shot live-door-camera");
console.log("console errors:", failed.length ? failed : "none");

await browser.close();
if (!shot || !shot.width) {
  console.log("RESULT: the photograph is still broken");
  process.exit(1);
}
console.log("RESULT: the camera works");
