/**
 * One photograph channel, both directions. Each direction gets a fresh browser
 * because this machine has a single synthetic capture device and two tabs
 * cannot both hold it — that is a harness limit, not an app one.
 *
 * A: the phone takes a picture, the door shows it without being asked.
 * B: the door takes a picture, the phone shows it without being asked.
 */
import { findBrowser } from "file:///C:/Users/persi/.claude/skills/web-design/scripts/lib/browser.mjs";
import { mkdir } from "node:fs/promises";

const OUT = "C:/Users/persi/vibe-work/le-concierge-vibe/.web-design/app-shots";
const PW = "file:///C:/Users/persi/.claude/skills/web-design/scripts/node_modules/playwright-core/index.mjs";
await mkdir(OUT, { recursive: true });

const pw = await import(PW);
const launch = () =>
  pw.chromium.launch({
    executablePath: findBrowser(),
    headless: true,
    args: [
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
};

const results = [];

// ── A: phone photographs, door receives
{
  const browser = await launch();
  const context = await browser.newContext({ permissions: ["camera"] });
  const door = await context.newPage();
  await door.setViewportSize({ width: 1440, height: 940 });
  await door.goto("http://localhost:5174/#door", { waitUntil: "networkidle" });

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 430, height: 932 });
  await phone.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await phone.evaluate(() => {
    localStorage.setItem(
      "le-concierge:resident",
      JSON.stringify({ id: "local_12", name: "Persia", flat: "12", email: "persia@example.com", anonymous: false }),
    );
    localStorage.setItem("le-concierge:theme", "light");
  });
  await phone.reload({ waitUntil: "networkidle" });
  await phone.waitForTimeout(900);

  const opener = phone.getByRole("button", { name: /camera/i }).first();
  await opener.click();
  await phone.getByRole("button", { name: /Take .*photograph/i }).waitFor({ timeout: 20000 });
  await phone.getByRole("button", { name: /Take .*photograph/i }).click();
  await phone.waitForTimeout(1200);

  const phoneNotice = (await phone.locator(".notice").innerText().catch(() => "")).trim();
  console.log("A · phone says:", phoneNotice);
  await shot(phone, "bridge-phone-photographed");

  const doorPhoto = door.locator("figure.door-plate img");
  await doorPhoto.waitFor({ state: "visible", timeout: 20000 });
  const doorCaption = (await door.locator("figure.door-plate figcaption").innerText()).trim();
  const doorSize = await doorPhoto.evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight }));
  console.log("A · door caption:", doorCaption, JSON.stringify(doorSize));
  await shot(door, "bridge-door-received");
  results.push({ direction: "phone → door", caption: doorCaption, size: doorSize, notice: phoneNotice });
  await browser.close();
}

// ── B: door photographs, phone receives
{
  const browser = await launch();
  const context = await browser.newContext({ permissions: ["camera"] });
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 430, height: 932 });
  await phone.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await phone.evaluate(() => {
    localStorage.setItem(
      "le-concierge:resident",
      JSON.stringify({ id: "local_12", name: "Persia", flat: "12", email: "persia@example.com", anonymous: false }),
    );
    localStorage.setItem("le-concierge:theme", "light");
  });
  await phone.reload({ waitUntil: "networkidle" });

  const door = await context.newPage();
  await door.setViewportSize({ width: 1440, height: 940 });
  await door.goto("http://localhost:5174/#door", { waitUntil: "networkidle" });
  await phone.waitForTimeout(900);

  await door.getByRole("button", { name: /Open the camera/i }).click();
  await door.getByRole("button", { name: /Take .*photograph/i }).waitFor({ timeout: 20000 });
  await door.getByRole("button", { name: /Take .*photograph/i }).click();
  await door.waitForTimeout(1200);

  const doorNotice = (await door.locator(".notice").innerText().catch(() => "")).trim();
  console.log("B · door says:", doorNotice);
  await shot(door, "bridge-door-photographed");

  const figure = phone.locator("figure.intercom-shot");
  await figure.locator("img").waitFor({ state: "visible", timeout: 20000 });
  const phoneCaption = (await figure.locator("figcaption").innerText()).replace(/\s+/g, " ").trim();
  const phoneSize = await figure.locator("img").evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight }));
  console.log("B · phone caption:", phoneCaption, JSON.stringify(phoneSize));
  await shot(phone, "bridge-phone-received");
  results.push({ direction: "door → phone", caption: phoneCaption, size: phoneSize, notice: doorNotice });
  await browser.close();
}

console.log(JSON.stringify(results, null, 1));
const ok =
  results[0].caption.includes("flat 12's phone") &&
  results[0].size.w > 0 &&
  results[1].caption.includes("the door") &&
  results[1].size.w > 0;
console.log(ok ? "RESULT: both directions work" : "RESULT: the channel is still broken");
process.exit(ok ? 0 : 1);
