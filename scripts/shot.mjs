// Headless screenshot helper for visual review.
//   node scripts/shot.mjs <url-path> <out.png> [width] [height] [waitMs] [jsBeforeShot]
import { chromium } from 'playwright-core';

const [, , path = '/', out = 'tmp/shot.png', w = '1280', h = '800', wait = '1500', js = ''] = process.argv;
const base = process.env.KINLING_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base + path, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', null, { timeout: 120000 }).catch(() => logs.push('[shot] __ready timeout'));
if (js) await page.evaluate(js);
await page.waitForTimeout(+wait);
await page.screenshot({ path: out });
const info = await page.evaluate('JSON.stringify(window.__lab ?? window.__kinling?.stats?.() ?? null)').catch(() => null);
if (info && info !== 'null') console.log(info);
if (logs.length) console.log(logs.slice(0, 20).join('\n'));
await browser.close();
