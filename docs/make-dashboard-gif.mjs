import { chromium } from "playwright";
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { PNG } from "pngjs";
import fs from "node:fs";

const OUT = process.argv[2];
const W = 1240, H = 680, FPS = 8, DELAY = Math.round(1000 / FPS);

const browser = await chromium.launch();
// `viewport` is the newPage option; `viewportSize` is silently ignored and you
// get the 1280x720 default.
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:8799/ui", { waitUntil: "networkidle" });
await page.evaluate(() => {
  const p = document.getElementById("tokenPick");
  if (p) [...p.options].forEach((o) => (o.text = "demo-token"));
});

// Get to the money shot BEFORE recording: the first frame is what people see
// in a preview, and an empty tab is a wasted one.
await page.click("#tab-usage");
await page.waitForTimeout(800);
await page.selectOption("#f-window", "7d");
await page.selectOption("#f-bucket", "day");
await page.waitForTimeout(1200);

const frames = [];
const shoot = async (n = 1) => { for (let i = 0; i < n; i++) frames.push(await page.screenshot({ type: "png" })); };
const hold = (ms) => shoot(Math.max(1, Math.round((ms / 1000) * FPS)));

await page.evaluate(() => window.scrollTo({ top: 150 }));
await page.waitForTimeout(300);
await hold(1100);

for (const i of [2, 5]) {                           // tooltip: billed vs cache-read
  const b = await page.locator("#c-series .hitbox").nth(i).boundingBox();
  if (!b) continue;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.55);
  await page.waitForTimeout(160);
  await hold(650);
}
await page.mouse.move(4, 4); await page.waitForTimeout(150);

await page.selectOption("#f-bucket", "hour");       // finer buckets
await page.waitForTimeout(900); await hold(800);

await page.selectOption("#f-mode", "semi");         // one filter rescopes everything
await page.waitForTimeout(900); await hold(900);
await page.selectOption("#f-mode", ""); await page.waitForTimeout(700);

await page.locator("#c-tools").scrollIntoViewIfNeeded();
await page.waitForTimeout(400); await hold(1000);   // cost per tool

await page.locator("#u-turns").scrollIntoViewIfNeeded();
await page.waitForTimeout(400); await hold(400);
await page.locator("#u-turns tr.turnrow").nth(1).click();
await page.waitForTimeout(900); await hold(1500);   // drill-down: per model call

await page.click("#tab-live");                      // close on the live feed
await page.waitForTimeout(900); await hold(1200);

await browser.close();

const enc = GIFEncoder();
let palette = null;
for (const [i, buf] of frames.entries()) {
  const { data, width, height } = PNG.sync.read(buf);
  // One palette, built from a chart-heavy frame and reused: per-frame palettes
  // make the series colours shimmer.
  if (i === 3) palette = quantize(data, 256, { format: "rgb565" });
}
for (const [i, buf] of frames.entries()) {
  const { data, width, height } = PNG.sync.read(buf);
  const idx = applyPalette(data, palette, "rgb565");
  enc.writeFrame(idx, width, height, { palette: i === 0 ? palette : undefined, delay: DELAY });
}
enc.finish();
fs.writeFileSync(OUT, Buffer.from(enc.bytes()));
console.log(`${W}x${H} · frames ${frames.length} · ${(frames.length / FPS).toFixed(1)}s · ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
