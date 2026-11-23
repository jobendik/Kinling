/**
 * Wires the simulation to its presentation and runs the loop: fixed-step
 * simulation with bounded catch-up, interpolated rendering, autosave, and a
 * bounded "time away" transition when the tab or the page comes back.
 */
import * as THREE from 'three';
import { Task, TaskQueue } from 'yuka';
import { AudioEngine } from '../audio/AudioEngine';
import { clamp01, lerp } from '../core/math';
import { FixedStepper } from '../core/stepper';
import { Pointer, type Tool } from '../input/pointer';
import { clearSave, exportSave, importSave, readSave, readSettings, writeSave, writeSettings, type Settings } from '../persistence/storage';
import { CameraRig } from '../render/camera';
import { buildKinling, type KinlingBody } from '../render/creature/build';
import { KinlingRig } from '../render/creature/rig';
import { Environment } from '../render/environment';
import { Props } from '../render/props';
import { QUALITY, Stage, type QualityLevel } from '../render/Stage';
import { makeIdentity, suggestName } from '../sim/identity';
import { applyAbsence } from '../sim/offline';
import { restore, serialize, type SaveData } from '../sim/save';
import { POND, WATER_Y, heightAt } from '../sim/terrain';
import { CURIO_KINDS } from '../sim/types';
import { World } from '../sim/world';
import { WildlifeView } from '../render/wildlife';
import { PADS, type Subject } from '../sim/wildlife';
import { WildlifeHud } from '../ui/wildlife';
import { Hud } from '../ui/hud';
import { Inspector } from '../ui/inspector';
import { buildJournal } from './journal';

const AUTOSAVE_S = 20;

class SaveTask extends Task {
  constructor(private fn: () => void) {
    super();
  }
  override execute(): void {
    this.fn();
  }
}

export class App {
  world!: World;
  stage: Stage;
  private env: Environment;
  private props!: Props;
  private body!: KinlingBody;
  private rig!: KinlingRig;
  private cam: CameraRig;
  private pointer!: Pointer;
  private hud: Hud;
  private visitors!: WildlifeView;
  private wildlifeHud: WildlifeHud;
  private watchPoint = new THREE.Vector3();
  private kinlingCamera = { distance: 4.3, polar: 1.25, azimuth: .12 };
  private inspector!: Inspector;
  private audio = new AudioEngine();
  private settings: Settings;
  private tasks = new TaskQueue();
  private stepper = new FixedStepper(1 / 60, 5, 0.1);
  private last = 0;
  private prev = new THREE.Vector3();
  private interp = new THREE.Vector3();
  private mouth = new THREE.Vector3();
  private head = new THREE.Vector3();
  private saveTimer = AUTOSAVE_S;
  private hiddenAt = 0;
  private running = false;
  private petting = false;
  private curioIndex = 0;
  private spotTimer = 0;
  private perf = { fps: 60, frameMs: 16, steps: 1, acc: 0, n: 0, slow: 0, fast: 0 };
  private quality: QualityLevel;
  private clock = 0;
  private hints = new Set<string>();
  private unsub: Array<() => void> = [];
  private firstSession = false;
  private namePrompted = false;
  private keys = new Set<string>();

  constructor(private canvas: HTMLCanvasElement, private uiRoot: HTMLElement) {
    this.settings = readSettings();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches && !localStorage.getItem('kinling.settings.v1')) this.settings.reducedMotion = true;
    this.hints = new Set(this.settings.hintsSeen);
    const forced = new URLSearchParams(location.search).get('q');
    if (forced === 'low' || forced === 'medium' || forced === 'high') this.settings.quality = forced;
    this.quality = this.settings.quality === 'auto' ? this.guessQuality() : this.settings.quality;
    this.stage = new Stage(canvas, this.quality);
    this.cam = new CameraRig(this.stage.camera);
    this.env = new Environment(this.stage.scene, { grass: 1 });
    this.env.setGrassDensity(QUALITY[this.quality].grass);
    this.hud = new Hud(uiRoot, {
      tool: (t) => this.setTool(t),
      call: () => this.call(),
      cueSit: () => this.cueSit(),
      cueSpin: () => this.cueSpin(),
      settings: () => this.applySettings(),
      name: (n) => { this.world.identity.name = n; this.save(); },
      exportSave: () => exportSave(serialize(this.world)),
      importSave: (f) => void this.import(f),
      reset: () => { clearSave(); location.href = location.pathname; },
      toggleInspector: () => this.inspector.toggle(),
      journal: () => buildJournal(this.world),
      gesture: () => this.unlockAudio(),
    }, this.settings);
    this.wildlifeHud = new WildlifeHud(uiRoot, {
      watch: subject => this.watch(subject),
      scatter: () => this.world.wildlife.scatter(),
      whistle: () => { this.audio.whistle('come'); this.world.wildlife.whistle(); },
      chorus: () => this.world.wildlife.startChorus(),
      pad: i => this.world.wildlife.choosePad(i),
    });
    this.bindWindow();
  }

  private guessQuality(): QualityLevel {
    const small = Math.min(innerWidth, innerHeight) < 520;
    const cores = navigator.hardwareConcurrency || 4;
    return small || cores <= 4 ? 'medium' : 'high';
  }

  /** Create or restore the world, then start the loop. */
  async start(): Promise<void> {
    const q = new URLSearchParams(location.search);
    const loaded = q.has('fresh') ? { data: null, recovered: false, damaged: false } : readSave();
    let data: SaveData | null = loaded.data;
    if (q.has('seed') && data && data.identity.seed !== Number(q.get('seed'))) data = null;
    await new Promise((r) => setTimeout(r, 30)); // let the veil paint before the heavy build
    if (data) {
      this.world = restore(data);
      const report = applyAbsence(this.world, (Date.now() - data.savedAt) / 1000);
      if (report.applied) this.hud.toast(report.summary, 6500);
      else if (loaded.recovered) this.hud.toast('Your last save was damaged, so the one before it was restored.', 7000);
    } else {
      const seed = q.has('seed') ? Number(q.get('seed')) >>> 0 : (crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000) + 1;
      this.world = new World(makeIdentity(seed, '', Date.now()));
      this.firstSession = true;
      if (loaded.damaged) this.hud.toast('The saved kinling could not be read, so a new one has arrived.', 7000);
    }
    this.mount();
    this.hud.ready();
    this.last = performance.now();
    if (q.has('capture')) { this.captureT = this.last; this.frame(this.last); return; }
    this.running = true;
    requestAnimationFrame(this.frame);
  }

  /**
   * Capture mode (?capture): advance simulated time by exact amounts and
   * render one frame, so motion can be reviewed frame by frame on any machine.
   */
  advance(seconds: number, frames = 1, renderAll = false): void {
    for (let i = 0; i < frames; i++) {
      this.captureT += (seconds / frames) * 1000;
      this.skipRender = !renderAll && i < frames - 1;
      this.frame(this.captureT);
    }
    this.skipRender = false;
  }
  private captureT = 0;
  private skipRender = false;

  /** Build everything that depends on a particular world/individual. */
  private mount(): void {
    const w = this.world;
    const k = w.kinling;
    for (const u of this.unsub) u();
    this.unsub = [];
    if (this.rig) { this.rig.dispose(); this.stage.scene.remove(this.body.group); this.body.dispose(); this.pointer.destroy(); }
    this.body = buildKinling(w.identity.look, { shells: QUALITY[this.quality].shells });
    this.stage.scene.add(this.body.group);
    this.rig = new KinlingRig(this.body, k, this.stage.scene);
    this.rig.motionScale = this.settings.reducedMotion ? 0.55 : 1;
    this.rig.onFootfall = (e) => {
      this.audio.footstep(e.x, e.z, e.strength * (k.style === 'sneak' ? 0.4 : 1), e.wet ? 'water' : 'grass');
      if (e.wet) this.env.ripple(e.x, e.z, 0.3 + 0.3 * e.strength);
    };
    this.visitors?.dispose();
    this.visitors = new WildlifeView(this.stage.scene);
    if (this.wildlifeHud.subject !== 'kinling') Object.assign(this.cam, this.kinlingCamera);
    this.wildlifeHud.select('kinling');
    this.props?.toys.ball.removeFromParent();
    this.props = new Props(this.stage.scene, w);
    this.pointer = new Pointer(this.canvas, this.stage.camera, this.cam, w, () => this.body, (kind) => this.props.toys[kind], {
      act: (tool, x, z) => this.act(tool, x, z),
      gesture: () => { this.unlockAudio(); this.hud.closePanels(); },
      petting: (on) => { this.petting = on; },
      hover: (what) => {
        this.canvas.classList.toggle('over-creature', what === 'creature');
        this.canvas.classList.toggle('over-toy', what === 'toy');
      },
    });
    this.inspector?.el.remove();
    this.inspector = new Inspector(this.uiRoot, w, this.stage.scene);
    if (new URLSearchParams(location.search).has('dev')) this.inspector.toggle();
    this.prev.set(k.position.x, k.position.y, k.position.z);
    this.cam.snap(this.prev);
    this.rig.snap(k.position.x, k.position.y, k.position.z);
    this.hud.setName(w.identity.name);
    this.setTool('hand');
    this.applySettings();
    this.subscribe();
  }

  private subscribe(): void {
    const w = this.world, k = w.kinling, ev = w.events, a = this.audio;
    const on = <K extends Parameters<typeof ev.on>[0]>(type: K, fn: Parameters<typeof ev.on<K>>[1]): void => { this.unsub.push(ev.on(type, fn)); };
    on('wildlifeCall', e => a.wildlifeCall(e.species, e.x, e.z));
    on('vocal', (e) => a.vocal(e.kind, e.intensity, w.identity.voice, k.position.x, k.position.z));
    on('toyImpact', (e) => { a.toyImpact(e.kind, e.speed, e.surface, e.x, e.z); if (e.surface === 'water') this.env.ripple(e.x, e.z, 0.8); });
    on('ripple', (e) => { this.env.ripple(e.x, e.z, e.strength); });
    on('rustle', (e) => a.rustle(e.x, e.z, e.strength));
    on('sound', (e) => {
      if (e.kind === 'whistle') a.whistle('come');
      else if (e.kind === 'cue') a.whistle(e.cue ?? 'sit');
      else if (e.kind === 'splash') a.splash(e.x, e.z, e.loud * 2);
      else if (e.kind === 'tap') a.ui('tap');
    });
    on('curio', (e) => { if (e.type === 'chime') { a.chime(e.kind, e.x, e.z); this.props.pulseCurio(); } else if (e.type === 'placed') a.ui('place'); });
    on('berry', (e) => { if (e.type === 'drop') a.ui('place'); });
    on('action', (e) => { if (e.kind === 'greet' && e.phase === 'contact') a.shimmer(k.position.x, k.position.z, 0.6); });
    on('cue', (e) => {
      if (e.response === 'postpone') this.hint('cue-later', 'It heard you. It will come when it is ready.');
      else if (e.response === 'decline') this.hint('cue-no', 'It heard you — and has other ideas just now.');
      else if (e.response === 'unheard') this.hint('cue-asleep', 'It is fast asleep.');
      else if (e.kind === 'spin' && e.response === 'correct') this.hint('spin-yes', 'Here comes a twirl. Stroke it as it turns to reward the trick.');
      else if (e.kind === 'spin') this.hint('spin-try', 'It is still learning the twirl. Try again when it looks up.');
      else if (e.response === 'correct') this.hint('cue-sit', 'It sat! Reward it now — a stroke or a berry — and the cue will stick.');
      else if (e.response === 'offered' || e.response === 'puzzled') this.hint('cue-try', 'It is guessing what the cue means. Reward it only when it sits.');
    });
    on('goal', (e) => {
      if (e.name.startsWith('offer')) this.hint('offer', 'It is bringing you a toy. Select it and click the ground to throw.');
      if (e.name === 'seek company') this.hint('company', 'It has come to you. Drag gently across its fur.');
    });
    on('touch', (e) => {
      if (e.kind === 'stroke' && e.liked < 0) this.hint('touch-no', `Not everywhere is welcome. Try somewhere other than its ${e.region}.`);
    });
  }

  // ── player actions ─────────────────────────────────────────────
  private setTool(tool: Tool): void {
    this.pointer.setTool(tool);
    this.hud.setTool(tool);
    this.canvas.classList.toggle('tool', tool !== 'hand');
    this.audio.ui('select');
    if (tool === 'wisp') this.hint('wisp', 'Move the pointer over the ground: the wisp follows. Let it be caught now and then.');
    if (tool === 'curio') this.hint('curio', 'Click the ground to set down something it has never seen. Click again elsewhere to move it.');
  }

  private watch(subject: Subject): void {
    if (!this.world || subject === this.wildlifeHud.subject) return;
    this.unlockAudio();
    this.hud.closePanels();
    if (this.wildlifeHud.subject === 'kinling') this.kinlingCamera = { distance: this.cam.distance, polar: this.cam.polar, azimuth: this.cam.azimuth };
    if (this.wildlifeHud.subject === 'frog') this.world.wildlife.leaveChorus();
    this.wildlifeHud.select(subject);
    this.setTool(subject === 'kinling' ? 'hand' : 'watch');
    if (subject === 'kinling') {
      Object.assign(this.cam, this.kinlingCamera);
      this.cam.snap(this.interp);
    } else {
      this.cam.distance = subject === 'frog' && this.stage.camera.aspect < .8 ? 4.3 : 2.7;
      this.cam.azimuth = subject === 'frog' ? 0 : -.38;
      this.cam.polar = subject === 'frog' ? .98 : 1.28;
      this.visitorFocus(subject);
      this.cam.snap(this.watchPoint);
      this.wildlifeHud.update(this.world.wildlife);
    }
  }

  private visitorFocus(subject: 'robin' | 'frog'): void {
    const p = subject === 'frog' ? PADS[1] : this.world.wildlife.robin.position;
    this.watchPoint.set(p.x, p.y - (subject === 'frog' ? .15 : 0), p.z + (subject === 'frog' ? .28 : 0));
  }

  private act(tool: Tool, x: number, z: number): void {
    const w = this.world;
    switch (tool) {
      case 'watch': {
        const visitors = w.wildlife;
        if (this.wildlifeHud.subject === 'frog') {
          const i = PADS.findIndex(p => Math.hypot(x - p.x, z - p.z) < .39);
          visitors.choosePad(i);
        } else if (this.wildlifeHud.subject === 'robin') visitors.scatter({ x, z });
        break;
      }
      case 'hand':
        // a tap on the ground: a small sound it may look toward
        w.emitSound({ kind: 'tap', x, z, loud: 0.22 });
        break;
      case 'berry':
        if (!w.dropBerry(x, z)) { this.hud.toast('There are plenty of berries out already.'); this.audio.ui('deny'); }
        break;
      case 'ball':
      case 'rattle':
        if (!w.tossToy(tool, x, z)) { this.hud.toast(w.toys[tool].state === 'carried' ? 'It has that just now.' : 'Click a little further away.'); this.audio.ui('deny'); }
        break;
      case 'curio': {
        const kind = CURIO_KINDS[this.curioIndex % CURIO_KINDS.length];
        if (w.curio && Math.hypot(w.curio.position.x - x, w.curio.position.z - z) < 0.5) { w.removeCurio(); this.curioIndex++; }
        else w.placeCurio(w.curio ? w.curio.kind : kind, x, z);
        break;
      }
    }
  }

  private call(): void {
    this.world.cue('come');
  }
  private cueSpin(): void {
    this.world.cue('spin');
    this.hint('spin-how', 'Watch for a full turn, then reward it with a stroke.');
  }
  private cueSit(): void {
    this.world.cue('sit');
    this.hint('sit-how', 'That is the "sit" cue. It will not know it yet: reward it whenever it happens to sit.');
  }

  private hint(id: string, text: string): void {
    if (this.hints.has(id)) return;
    this.hints.add(id);
    this.settings.hintsSeen = [...this.hints];
    writeSettings(this.settings);
    this.hud.toast(text, 5200);
  }

  private unlockAudio(): void {
    if (!this.audio.unlocked) void this.audio.unlock().then(() => this.applySettings());
  }

  private applySettings(): void {
    const s = this.settings;
    writeSettings(s);
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.cam.reducedMotion = s.reducedMotion;
    if (this.rig) this.rig.motionScale = s.reducedMotion ? 0.55 : 1;
    if (s.quality !== 'auto') this.setQuality(s.quality);
  }

  private setQuality(level: QualityLevel): void {
    if (level === this.quality) return;
    this.quality = level;
    this.stage.setQuality(level);
    this.body?.setShellCount(QUALITY[level].shells);
    this.env.setGrassDensity(QUALITY[level].grass);
  }

  // ── persistence ────────────────────────────────────────────────
  save(): void {
    if (this.world) writeSave(serialize(this.world));
  }
  private queueSave(): void {
    // serialising and writing is not urgent: let Yuka's task queue do it in idle time
    if (typeof requestIdleCallback === 'function') { this.tasks.enqueue(new SaveTask(() => this.save())); this.tasks.update(); }
    else this.save();
  }
  private async import(file: File): Promise<void> {
    const data = await importSave(file);
    if (!data) { this.hud.toast('That file is not a kinling save.'); return; }
    writeSave(data);
    this.world = restore(data);
    this.mount();
    this.hud.toast(`${data.identity.name || 'A kinling'} has arrived.`);
  }

  private bindWindow(): void {
    const resize = (): void => this.stage.resize(innerWidth, innerHeight);
    addEventListener('resize', resize);
    resize();
    document.addEventListener('visibilitychange', () => {
      if (!this.world) return;
      if (document.hidden) { this.hiddenAt = Date.now(); this.save(); }
      else this.resume();
    });
    addEventListener('pagehide', () => this.save());
    addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (e.key === 'Escape') { this.hud.closePanels(); target?.blur?.(); return; }
      const typing = target?.tagName === 'SELECT' || (target?.tagName === 'INPUT' && ['text', 'range'].includes((target as HTMLInputElement).type));
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!this.world) return;
      if (this.wildlifeHud.subject !== 'kinling' && /^[1-6cspt]$/i.test(e.key)) {
        if (this.wildlifeHud.subject === 'frog' && /^[1-3]$/.test(e.key)) this.world.wildlife.choosePad(Number(e.key) - 1);
        return;
      }
      const tools: Tool[] = ['hand', 'berry', 'ball', 'rattle', 'wisp', 'curio'];
      const n = Number(e.key);
      if (n >= 1 && n <= 6) this.setTool(tools[n - 1]);
      else if (e.key === 'c' || e.key === 'C') { this.unlockAudio(); this.call(); }
      else if (e.key.toLowerCase() === 't') { this.unlockAudio(); this.cueSpin(); }
      else if (e.key === 's' || e.key === 'S') { this.unlockAudio(); this.cueSit(); }
      else if (e.key === 'm' || e.key === 'M') { this.settings.muted = !this.settings.muted; this.applySettings(); }
      else if (e.key === '`') this.inspector.toggle();
      else if (e.key === '+' || e.key === '=') this.cam.zoom(0.88);
      else if (e.key === '-' || e.key === '_') this.cam.zoom(1.14);
      else if (e.key === 'p' || e.key === 'P') { const k = this.world.kinling; this.unlockAudio(); this.world.touch('head', 'stroke', k.position.x, k.position.y + 0.5, k.position.z); }
      else this.keys.add(e.key);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.key));
  }

  /** Coming back to a hidden tab: no replay, one bounded transition. */
  private resume(): void {
    const gap = this.hiddenAt ? (Date.now() - this.hiddenAt) / 1000 : 0;
    this.hiddenAt = 0;
    this.last = performance.now();
    this.stepper.reset();
    const report = applyAbsence(this.world, gap);
    if (report.applied) {
      const k = this.world.kinling;
      this.prev.set(k.position.x, k.position.y, k.position.z);
      this.rig.snap(k.position.x, k.position.y, k.position.z);
      this.hud.toast(report.summary, 6500);
    }
  }

  // ── the loop ───────────────────────────────────────────────────
  private frame = (now: number): void => {
    if (this.running) requestAnimationFrame(this.frame);
    const raw = (now - this.last) / 1000;
    this.last = now;
    // never integrate a long stall as if it were play time
    const dt = Math.min(Math.max(raw, 0), 0.1);
    this.clock += dt;
    const w = this.world, k = w.kinling;

    const steps = this.stepper.advance(raw, (h) => {
      this.prev.set(k.position.x, k.position.y, k.position.z);
      w.step(h);
    });
    const alpha = this.stepper.alpha;
    this.interp.set(lerp(this.prev.x, k.position.x, alpha), lerp(this.prev.y, k.position.y, alpha), lerp(this.prev.z, k.position.z, alpha));

    // keyboard camera
    if (this.keys.size) {
      const sp = 260 * dt;
      if (this.keys.has('ArrowLeft')) this.cam.orbit(sp, 0);
      if (this.keys.has('ArrowRight')) this.cam.orbit(-sp, 0);
      if (this.keys.has('ArrowUp')) this.cam.orbit(0, sp);
      if (this.keys.has('ArrowDown')) this.cam.orbit(0, -sp);
    }
    this.rig.headWorld(this.head);
    const subject = this.wildlifeHud.subject;
    if (subject === 'kinling') this.cam.update(dt, this.interp, this.head.y);
    else {
      this.visitorFocus(subject);
      this.cam.update(dt, this.watchPoint, this.watchPoint.y + .2);
    }
    this.visitors.update(w.wildlife, w.time, this.settings.reducedMotion);
    this.wildlifeHud.update(w.wildlife);
    if ((this.spotTimer -= dt) <= 0) {
      this.spotTimer = 0.4;
      const spot = { x: 0, z: 0 };
      this.cam.playerSpot(spot);
      w.setPlayerSpot(spot.x, spot.z);
    }

    const sky = this.stage.sky;
    sky.update(w.dayTime, this.clock, this.cam.focus);
    this.rig.update(dt, this.interp.x, this.interp.y, this.interp.z, this.stage.camera);
    this.rig.mouthWorld(this.mouth);
    this.props.update(dt, alpha, this.mouth, sky.night);
    const pushers = [{ x: this.interp.x, y: this.interp.y, z: this.interp.z, r: k.posture === 'stand' ? 0.34 : 0.42 }];
    for (const kind of ['ball', 'rattle'] as const) { const t = w.toys[kind]; pushers.push({ x: t.position.x, y: t.position.y - t.radius, z: t.position.z, r: 0.2 }); }
    const wind = 0.35 + 0.25 * Math.sin(this.clock * 0.13) + 0.15 * Math.sin(this.clock * 0.41);
    this.env.update(dt, { night: sky.night, skyColor: sky.hemi.color, sunDir: sky.sunDir, sunColor: sky.sun.color, pushers, pixelRatio: this.stage.pixelRatio * (innerHeight / 900), wind });
    this.env.setBushStock(w.bushStock);

    // audio follows the camera
    const c = this.stage.camera.position;
    const fx = this.cam.focus.x - c.x, fz = this.cam.focus.z - c.z;
    const fl = Math.hypot(fx, fz) || 1;
    this.audio.setListener(c.x, c.y, c.z, fx / fl, fz / fl);
    const nearWater = clamp01(1.3 - Math.hypot(this.cam.focus.x - POND.x, this.cam.focus.z - POND.z) / (POND.r + 3));
    this.audio.update(dt, { night: sky.night, nearWater, wind });
    const purring = this.petting && k.now - k.touch.at < 0.8 && k.touch.liked > 0.1;
    this.audio.purr(purring, 0.4 + 0.5 * clamp01(k.touch.liked), w.identity.voice, k.position.x, k.position.z);

    if (!this.skipRender) this.stage.render();
    this.afterFrame(dt, raw, steps);
  };

  private afterFrame(dt: number, raw: number, steps: number): void {
    const w = this.world, k = w.kinling;
    // one-line reading of the creature
    const who = w.identity.name || 'It';
    const doing = k.asleep ? 'asleep' : k.startle.phase !== 'none' ? 'startled' : k.brain.activity?.phase ?? '';
    this.hud.setMood(`${who} is ${k.affect.label(k.needs.values)}${doing && doing !== 'asleep' ? ` · ${doing}` : doing === 'asleep' ? ' · fast asleep' : ''}`);

    // first meeting: light guidance, and a name once it has shown itself
    if (this.firstSession) {
      if (this.clock > 3) this.hint('look', 'Drag to look around. Scroll or pinch to come closer.');
      if (this.clock > 14 && this.wildlifeHud.subject === 'kinling' && !this.namePrompted) {
        this.namePrompted = true;
        this.hud.askName(suggestName(w.identity.seed), (name) => {
          if (name) { w.identity.name = name; this.hud.setName(name); this.save(); }
          this.hint('stroke', 'When it comes near, drag slowly across its fur to stroke it.');
        });
      }
      if (this.clock > 60) this.hint('toss', 'Select the ball and click the ground to toss it. See what it makes of that.');
    }
    if (k.needs.values.nourishment < 0.3) this.hint('hungry', 'It looks peckish. Select the berry and click the ground nearby.');

    if ((this.saveTimer -= dt) <= 0) { this.saveTimer = AUTOSAVE_S; this.queueSave(); }

    // measure, and adapt detail when on automatic
    const p = this.perf;
    p.acc += raw; p.n++; p.steps = steps;
    if (p.acc >= 1) {
      p.frameMs = (p.acc / p.n) * 1000;
      p.fps = p.n / p.acc;
      p.acc = 0; p.n = 0;
      if (this.settings.quality === 'auto' && this.clock > 6 && !document.hidden) {
        p.slow = p.frameMs > 24 ? p.slow + 1 : 0;
        p.fast = p.frameMs < 11 ? p.fast + 1 : 0;
        if (p.slow >= 3 && this.quality !== 'low') { this.setQuality(this.quality === 'high' ? 'medium' : 'low'); p.slow = 0; }
        else if (p.fast >= 12 && this.quality === 'medium') { this.setQuality('high'); p.fast = 0; }
      }
    }
    const info = this.stage.renderer.info;
    this.inspector.update(dt, { fps: p.fps, frameMs: p.frameMs, steps, quality: this.quality, tris: info.render.triangles, calls: info.render.calls });
    void heightAt; void WATER_Y;
  }

  /** Handles for automated checks and capture scripts. */
  get dbg(): { cam: CameraRig; rig: KinlingRig; pointer: Pointer; body: KinlingBody } {
    return { cam: this.cam, rig: this.rig, pointer: this.pointer, body: this.body };
  }

  /** Small surface for automated checks. */
  stats(): Record<string, unknown> {
    const k = this.world.kinling;
    const info = this.stage.renderer.info;
    return {
      fps: +this.perf.fps.toFixed(1), frameMs: +this.perf.frameMs.toFixed(2), quality: this.quality,
      triangles: info.render.triangles, calls: info.render.calls, geometries: info.memory.geometries, textures: info.memory.textures,
      time: +this.world.time.toFixed(1), goal: k.brain.activity?.label ?? null, mode: k.mode, posture: k.posture,
      x: +k.position.x.toFixed(2), z: +k.position.z.toFixed(2), name: this.world.identity.name, seed: this.world.identity.seed,
      audio: this.audio.unlocked,
    };
  }
}
