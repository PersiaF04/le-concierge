import { launch } from "file:///C:/Users/persi/.claude/skills/web-design/scripts/lib/browser.mjs";
import { mkdir } from "node:fs/promises";

const OUT = "C:/Users/persi/vibe-work/le-concierge-vibe/.web-design/app-shots";
await mkdir(OUT, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 });

const shot = async (name) => {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log("shot", name);
};

// ── resident
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await shot("resident-setup-light");

await page.evaluate(() => {
  localStorage.setItem(
    "le-concierge:resident",
    JSON.stringify({ id: "local_12", name: "Persia", flat: "12", email: "persia@example.com", anonymous: false }),
  );
  localStorage.setItem("le-concierge:theme", "light");
});
await page.reload({ waitUntil: "networkidle" });
await shot("resident-visit-light");

await page.getByRole("button", { name: /Sign and open/i }).click();
await shot("resident-answered-light");

await page.getByRole("button", { name: "parcels", exact: true }).click();
await shot("resident-parcels-light");

await page.getByRole("button", { name: "me", exact: true }).click();
await shot("resident-me-light");

await page.getByRole("button", { name: /Switch to dark mode/i }).click();
await shot("resident-me-dark");
await page.getByRole("button", { name: "visit", exact: true }).click();
await shot("resident-visit-dark");

// ── concierge
await page.goto("http://localhost:5174/#door", { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.setItem("le-concierge:theme", "light"));
await page.reload({ waitUntil: "networkidle" });
await shot("door-light");

await page.getByRole("button", { name: /Speak the reply/i }).click();
await page.waitForTimeout(900);
await shot("door-speaking-light");

await page.getByRole("button", { name: /Switch to dark mode/i }).click();
await shot("door-dark");

await page.getByRole("button", { name: /The log/i }).click();
await page.waitForTimeout(500);
await shot("ledger-dark");
await page.getByRole("button", { name: /Switch to light mode/i }).click();
await shot("ledger-light");

// mobile ledger + door
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto("http://localhost:5174/#ledger", { waitUntil: "networkidle" });
await mobile.waitForTimeout(600);
await mobile.screenshot({ path: `${OUT}/ledger-mobile.png`, fullPage: false });
await mobile.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await mobile.waitForTimeout(600);
await mobile.screenshot({ path: `${OUT}/resident-mobile.png`, fullPage: false });
console.log("shot mobile");

await browser.close();
