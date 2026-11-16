// Deterministic motion capture for review: steps the app in ?capture mode by
// exact time increments and screenshots each frame, then tiles a contact
// sheet (and optionally an mp4) with ffmpeg.
//   node scripts/capture.mjs --url "/?fresh=1&seed=7" --frames 12 --dt 0.1 --out tmp/walk --setup "js" --each "js" [--video] [--w 640 --h 400] [--cols 4]
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? '1' : arr[i + 1]]); return acc; }, []));
const base = process.env.KINLING_URL ?? 'http://localhost:5173';
const url = args.url ?? '/?fresh=1&seed=7';
const frames = +(args.frames ?? 12), dt = +(args.dt ?? 0.1), w = +(args.w ?? 640), h = +(args.h ?? 400), cols = +(args.cols ?? 4);
const out = args.out ?? 'tmp/cap';
const q = args.q ?? 'low';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${base}${url}${url.includes('?') ? '&' : '?'}capture=1&q=${q}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
if (args.hideui) await page.addStyleTag({ content: '#ui{display:none}' });
if (args.setup) await page.evaluate(args.setup);
const sub = Math.max(1, Math.round(dt / (1 / 30)));
for (let i = 0; i < frames; i++) {
  if (args.each) await page.evaluate(`(function(i){${args.each}})(${i})`);
  await page.evaluate(`window.__kinling.advance(${dt}, ${sub})`);
  await page.screenshot({ path: `${out}/f${String(i).padStart(3, '0')}.png` });
}
const info = await page.evaluate('JSON.stringify(window.__kinling.stats())');
console.log(info);
if (logs.length) console.log([...new Set(logs)].slice(0, 12).join('\n'));
await browser.close();
const rows = Math.ceil(frames / cols);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${out}/f%03d.png`, '-vf', `tile=${cols}x${rows}:padding=4:color=0x101816`, '-frames:v', '1', `${out}/sheet.png`]);
if (args.video) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(Math.round(1 / dt)), '-i', `${out}/f%03d.png`, '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', `${out}/clip.mp4`]);
console.log(`sheet: ${out}/sheet.png`);
