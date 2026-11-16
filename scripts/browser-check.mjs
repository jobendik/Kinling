// Browser-level checks against the production build (run `npm run build` first).
// Starts `vite preview`, drives the real page in headless Chrome and reports
// exactly what was exercised. Exit code is non-zero if any check fails.
//   node scripts/browser-check.mjs [--shots docs/media]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const PORT = 4173;
const base = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ } await sleep(250); }
  browser = await chromium.launch({
    executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  const watch = (page) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  };
  const stats = (page) => page.evaluate('window.__kinling.stats()');
  const ready = (page) => page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
  /** Render once and count distinct colours in the frame, to prove the scene is drawing. */
  const colours = (page) => page.evaluate(() => {
    const app = window.__kinling;
    app.stage.render();
    const src = document.getElementById('view');
    const c = document.createElement('canvas');
    c.width = 64; c.height = 40;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, 64, 40);
    const d = g.getImageData(0, 0, 64, 40).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) set.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3));
    return set.size;
  });

  // ── desktop ────────────────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await ctx.newPage();
  watch(page);
  const t0 = Date.now();
  await page.goto(`${base}/?fresh=1&seed=7&q=low`, { waitUntil: 'load' });
  await ready(page);
  check('loads and starts', true, `${((Date.now() - t0) / 1000).toFixed(1)}s to ready`);
  check('scene is rendering', (await colours(page)) > 40, `${await colours(page)} distinct colours sampled`);
  const title = await page.title();
  check('interface text is English and present', (await page.locator('.dock .tool').count()) === 8 && /Kinling/.test(title));
  await sleep(2500);
  const s1 = await stats(page);
  check('simulation advances and a goal is chosen', s1.time > 0.5 && !!s1.goal, `t=${s1.time}s goal="${s1.goal}"`);

  // berry: tool button, then a click on the ground
  await page.locator('.tool', { hasText: 'Berry' }).click();
  await page.mouse.click(620, 520);
  await sleep(600);
  check('berry tool drops a berry in the world', (await page.evaluate('window.__kinling.world.berries.length')) === 1);
  check('audio unlocks on first gesture', (await stats(page)).audio === true, 'AudioContext running after a click');

  // ball: toss via click
  const thrownBefore = await page.evaluate('window.__kinling.world.toys.ball.thrownAt');
  await page.locator('.tool', { hasText: 'Ball' }).click();
  await page.mouse.click(700, 470);
  await sleep(500);
  check('ball tool tosses the ball', (await page.evaluate('window.__kinling.world.toys.ball.thrownAt')) > thrownBefore);

  // call and cue via buttons and keyboard
  await page.evaluate('window.__cues = []; window.__kinling.world.events.on("cue", (e) => window.__cues.push(e.kind + ":" + e.response))');
  await page.locator('.tool', { hasText: 'Call' }).click();
  await page.keyboard.press('s');
  // software rendering runs the simulation slowly, so wait on the event rather than the clock
  await page.waitForFunction(() => window.__cues.length >= 2, null, { timeout: 30000 }).catch(() => {});
  const cues = await page.evaluate('window.__cues');
  check('call button and "sit" key each reach the creature once', cues.filter((c) => c.startsWith('come')).length === 1 && cues.filter((c) => c.startsWith('sit')).length === 1, cues.join(', '));

  // stroke the creature with a real pointer drag across its body
  await page.locator('.tool', { hasText: 'Hand' }).click();
  const at = await page.evaluate(() => {
    const app = window.__kinling;
    const v = app.dbg.body.bones.chest.getWorldPosition(new (app.stage.camera.position.constructor)()).project(app.stage.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
  });
  await page.mouse.move(at.x - 12, at.y);
  await page.mouse.down();
  for (let i = 0; i < 14; i++) { await page.mouse.move(at.x - 12 + (i % 2 ? 14 : -2), at.y - 2 + (i % 3)); await sleep(140); }
  await page.mouse.up();
  const touch = await page.evaluate('({ strokes: window.__kinling.world.kinling.touch.strokes, region: window.__kinling.world.kinling.touch.region, at: window.__kinling.world.kinling.touch.at })');
  check('dragging across the creature strokes it', touch.at > 0 && touch.strokes > 0, `region "${touch.region}", ${touch.strokes} strokes`);

  // dragging open ground orbits the camera instead
  const az0 = await page.evaluate('window.__kinling.dbg.cam.azimuth');
  await page.mouse.move(200, 300); await page.mouse.down(); await page.mouse.move(330, 310, { steps: 6 }); await page.mouse.up();
  check('dragging the ground orbits the camera', Math.abs((await page.evaluate('window.__kinling.dbg.cam.azimuth')) - az0) > 0.2);
  await page.mouse.move(600, 300); await page.mouse.wheel(0, -400);
  check('wheel zooms', (await page.evaluate('window.__kinling.dbg.cam.distance')) < 4.2);

  // settings: mute, reduced motion
  await page.locator('.round[aria-label="Settings"]').click();
  await page.locator('#set-motion').check();
  await page.locator('#set-mute').check();
  const set = await page.evaluate('JSON.parse(localStorage.getItem("kinling.settings.v1"))');
  check('settings persist (mute, reduced motion)', set.muted === true && set.reducedMotion === true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('`');
  const inspected = await page.waitForFunction(() => document.querySelector('.inspector.open')?.textContent?.includes('Goal scores'), null, { timeout: 20000 }).then(() => true, () => false);
  check('developer inspector shows live decision data', inspected);
  await page.keyboard.press('`');
  if (shots) await page.screenshot({ path: `${shots}/check-desktop.png` });

  // save, reload, restore
  await page.evaluate('window.__kinling.world.identity.name = "Tansy"; window.__kinling.world.kinling.learn.reinforceCue("sit", true); window.__kinling.save()');
  const before = await page.evaluate('({ t: window.__kinling.world.time, sit: window.__kinling.world.kinling.learn.data.cues.sit.strength, traits: window.__kinling.world.kinling.identity.traits, episodes: window.__kinling.world.kinling.ltm.data.episodes.length })');
  await page.goto(`${base}/?q=low`, { waitUntil: 'load' });
  await ready(page);
  const after = await page.evaluate('({ name: window.__kinling.world.identity.name, seed: window.__kinling.world.identity.seed, t: window.__kinling.world.time, sit: window.__kinling.world.kinling.learn.data.cues.sit.strength, traits: window.__kinling.world.kinling.identity.traits, episodes: window.__kinling.world.kinling.ltm.data.episodes.length })');
  check('reload restores the same individual', after.name === 'Tansy' && after.seed === 7 && JSON.stringify(after.traits) === JSON.stringify(before.traits), `name ${after.name}, seed ${after.seed}`);
  check('reload restores learning, memory and lived time', Math.abs(after.sit - before.sit) < 1e-9 && after.t >= before.t - 0.01 && after.episodes === before.episodes, `sit ${after.sit.toFixed(3)}, ${after.episodes} episodes`);

  // returning after time away: one bounded transition, no replay
  await page.evaluate(() => { const raw = JSON.parse(localStorage.getItem('kinling.save.v1')); raw.savedAt = Date.now() - 3 * 3600 * 1000; localStorage.setItem('kinling.save.v1', JSON.stringify(raw)); });
  // navigating away would autosave over the edited slot, so block that one write
  await page.evaluate('window.__kinling.save = () => {}');
  await page.goto(`${base}/?q=low`, { waitUntil: 'load' });
  await ready(page);
  const back = await page.evaluate('({ t: window.__kinling.world.time, pending: window.__kinling.world.reunionPending, toast: document.querySelector(".toast").textContent })');
  check('return after 3 hours applies a bounded absence', back.pending > 3 * 3600 - 60 && back.t - after.t < 12 * 3600 + 60 && /away/.test(back.toast), `"${back.toast}"`);

  // resize
  await page.setViewportSize({ width: 640, height: 900 });
  await sleep(1500);
  const size = await page.evaluate('({ w: document.getElementById("view").clientWidth, h: document.getElementById("view").clientHeight, aspect: window.__kinling.stage.camera.aspect })');
  check('resizes with the window', size.w === 640 && size.h === 900 && Math.abs(size.aspect - 640 / 900) < 0.01);
  await ctx.close();

  // ── touch-sized layout ─────────────────────────────────────────
  const mobile = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const mp = await mobile.newPage();
  watch(mp);
  await mp.goto(`${base}/?fresh=1&seed=11&q=low`, { waitUntil: 'load' });
  await ready(mp);
  const dock = await mp.evaluate('(() => { const r = document.querySelector(".dock").getBoundingClientRect(); const b = [...document.querySelectorAll(".dock .tool")].map((e) => e.getBoundingClientRect()); return { left: r.left, right: r.right, minW: Math.min(...b.map((x) => x.width)), minH: Math.min(...b.map((x) => x.height)) }; })()');
  check('dock fits a phone-width screen with touch-sized targets', dock.left >= 0 && dock.right <= 390 && dock.minW >= 36 && dock.minH >= 44, `targets ≥ ${dock.minW.toFixed(0)}×${dock.minH.toFixed(0)} px`);
  await mp.locator('.tool', { hasText: 'Berry' }).tap();
  await mp.touchscreen.tap(200, 520);
  await sleep(700);
  check('touch: tap a tool, tap the ground', (await mp.evaluate('window.__kinling.world.berries.length')) === 1);
  check('scene renders at phone size', (await colours(mp)) > 40);
  if (shots) await mp.screenshot({ path: `${shots}/check-phone.png` });
  await mobile.close();

  check('no console errors or uncaught exceptions', errors.length === 0, errors.slice(0, 4).join(' | '));
} catch (err) {
  check('browser check ran to completion', false, String(err).slice(0, 400));
} finally {
  await browser?.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
