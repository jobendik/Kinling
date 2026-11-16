/**
 * AudioEngine: fully procedural Web Audio for Kinling. No files, no libraries.
 *
 * Signal flow
 *   one-shot voice -> voice gain (level x distance) -> stereo pan -> bus (voice | world | ambience | ui)
 *                                                   \-> reverb send -> generated dark impulse -> master
 *   buses -> master gain (volume / mute) -> soft limiter -> destination
 *
 * Design
 *  - Two synthesis primitives cover almost everything: `tone` (an oscillator with a pitch glide)
 *    and `noise` (a looped pre-rendered noise buffer through one filter). Both take either a
 *    percussive envelope (attack + exponential tail) or a sustained one (attack / hold / release).
 *  - The creature's voice is one function, `sing`: a triangle/sine "glottis" plus breath noise
 *    through two formant bandpasses and a lowpass, with a smooth pitch contour written as a
 *    detune curve, optional vibrato and tremolo. Each vocal kind is a row in VOCALS.
 *  - Spatialisation is deliberately cheap: 1 / (1 + d*k) attenuation that fades out by ~14 units,
 *    and a StereoPannerNode driven by the listener's right vector. No HRTF.
 *  - One-shots are budgeted (MAX_VOICES); the weakest voice is faded and dropped when full, and
 *    every voice disconnects itself once its last source has ended.
 *  - The ambience bed (wind, leaves, water trickle) is three continuous filtered-noise layers
 *    steered from `update`; birds, crickets, owl and drips are sparse one-shots on dt timers.
 *
 * Nothing touches `window` or `AudioContext` until `unlock()`, so the module imports under Node.
 * Every public method is a silent no-op while locked, suspended or disposed, and never throws.
 */
import type { CurioKind, VocalKind } from '../sim/types';

export type Surface = 'grass' | 'stone' | 'water';

type Bus = 'voice' | 'world' | 'ambience' | 'ui';
type Source = OscillatorNode | AudioBufferSourceNode;
type AudioCtor = typeof AudioContext;

const MAX_VOICES = 24;
const BUS_LEVEL: Record<Bus, number> = { voice: 1, world: 0.8, ambience: 0.6, ui: 0.5 };
const VOICE_HZ = 600; // creature base pitch, multiplied by the individual's `pitch`
const TAU = Math.PI * 2;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
const jitter = (amount: number): number => 1 + (Math.random() * 2 - 1) * amount;
const noop = (): void => {};

interface Bed { wind: GainNode; windTone: BiquadFilterNode; leaves: GainNode; water: GainNode }
interface Graph {
  ctx: AudioContext; master: GainNode; buses: Record<Bus, GainNode>; reverb: GainNode;
  white: AudioBuffer; pink: AudioBuffer; bed: Bed;
}
interface Voice {
  g: Graph; in: GainNode; chain: AudioNode[]; sources: Source[];
  pending: number; level: number; born: number; released: boolean;
}
interface Purr {
  level: GainNode; pan: StereoPannerNode | null; sources: Source[];
  active: boolean; stoppedAt: number; stamp: number;
}
/** Percussive when `dur` is absent (attack, then exponential tail `tau`), sustained otherwise. */
interface Env { gain: number; attack?: number; tau?: number; dur?: number; release?: number }
interface ToneOpts extends Env { type?: OscillatorType; f0: number; f1?: number; glide?: number; dest?: AudioNode }
interface NoiseOpts extends Env {
  pink?: boolean; filter?: BiquadFilterType; f0: number; f1?: number; glide?: number; q?: number;
  /** Offsets (s) of several short ticks sharing one source; must be spaced wider than attack + 3*tau. */
  hits?: number[]; dest?: AudioNode;
}
type Contour = readonly (readonly [number, number])[];
interface VocalSpec {
  dur: number; gain: number; pitch: Contour;
  f1: number; f2: number; f1End?: number; f2End?: number;
  bright: number; breath: number; body: number; attack: number; release: number;
  /** [rate Hz, depth cents] */ vib?: readonly [number, number];
  /** [rate Hz, depth 0..1] */ trem?: readonly [number, number];
}

const GLOTTIS: readonly (readonly [OscillatorType, number, number])[] = [
  ['triangle', 1, 0.6], ['sine', 1, 0.35], ['sine', 2, 0.12],
];

const VOCALS: Record<'chirp' | 'trill' | 'squeak' | 'whine' | 'yawn' | 'coo', VocalSpec> = {
  chirp: { dur: 0.18, gain: 0.5, pitch: [[0, 0.84], [0.35, 0.98], [1, 1.34]], f1: 950, f2: 2300, f2End: 2900,
    bright: 4200, breath: 0.1, body: 0.35, attack: 0.025, release: 0.06, trem: [36, 0.3] },
  trill: { dur: 0.45, gain: 0.5, pitch: [[0, 0.92], [0.45, 1.26], [1, 1.02]], f1: 1000, f2: 2500,
    bright: 4500, breath: 0.1, body: 0.3, attack: 0.04, release: 0.12, trem: [22, 0.6], vib: [22, 30] },
  squeak: { dur: 0.14, gain: 0.5, pitch: [[0, 1.3], [0.38, 1.95], [1, 1.25]], f1: 1500, f2: 3300,
    bright: 6500, breath: 0.06, body: 0.3, attack: 0.012, release: 0.06 },
  whine: { dur: 0.6, gain: 0.34, pitch: [[0, 1.3], [0.65, 1.04], [1, 1.12]], f1: 1350, f2: 3000,
    bright: 4200, breath: 0.12, body: 0.12, attack: 0.08, release: 0.2, vib: [6.2, 22] },
  yawn: { dur: 1.1, gain: 0.3, pitch: [[0, 0.72], [0.3, 1.04], [1, 0.52]], f1: 1000, f1End: 650, f2: 1900, f2End: 1500,
    bright: 3200, breath: 0.35, body: 0.3, attack: 0.3, release: 0.45, vib: [4.5, 12] },
  coo: { dur: 0.35, gain: 0.32, pitch: [[0, 0.5], [0.4, 0.56], [1, 0.48]], f1: 520, f2: 1100,
    bright: 1700, breath: 0.08, body: 0.5, attack: 0.07, release: 0.14 },
};

function audioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Two seconds of loopable noise; the tail is cross-faded into the head so the loop has no seam. */
function makeNoise(ctx: BaseAudioContext, pink: boolean): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * 2), fade = Math.floor(ctx.sampleRate * 0.05);
  const raw = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0, peak = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (pink) { // Paul Kellet's economy pink filter
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      raw[i] = b0 + b1 + b2 + w * 0.1848;
    } else raw[i] = w;
    peak = Math.max(peak, Math.abs(raw[i]));
  }
  const buf = ctx.createBuffer(1, n, ctx.sampleRate), out = buf.getChannelData(0), k = 0.9 / (peak || 1);
  for (let i = 0; i < n; i++) {
    const x = i / fade;
    out[i] = k * (i < fade ? raw[i] * Math.sqrt(x) + raw[n + i] * Math.sqrt(1 - x) : raw[i]);
  }
  return buf;
}

/** Short dark impulse: a decaying noise burst that loses its top end as it rings (leaves, not walls). */
function makeImpulse(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 0.85), pre = Math.floor(ctx.sampleRate * 0.008);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre);
      lp += (Math.random() * 2 - 1 - lp) * (0.55 - 0.47 * x);
      d[i] = lp * Math.pow(1 - x, 2) * Math.exp(-3.4 * x);
    }
  }
  return buf;
}

/** Writes the envelope and returns the time at which the source may stop. */
function shape(p: AudioParam, t: number, e: Env): number {
  const a = e.attack ?? 0.004;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(e.gain, t + a);
  if (e.dur !== undefined) {
    const r = e.release ?? 0.05, hold = Math.max(t + a, t + e.dur - r);
    p.setValueAtTime(e.gain, hold);
    p.linearRampToValueAtTime(0, hold + r);
    return hold + r + 0.02;
  }
  const tau = e.tau ?? 0.03;
  p.setTargetAtTime(0, t + a, tau);
  return t + a + tau * 7;
}

function pulses(p: AudioParam, t: number, hits: number[], e: Env): number {
  const a = e.attack ?? 0.002, tau = e.tau ?? 0.007;
  let end = t;
  for (const h of hits) {
    const s = t + h, pk = e.gain * rand(0.55, 1);
    p.setValueAtTime(0, s);
    p.linearRampToValueAtTime(pk, s + a);
    p.linearRampToValueAtTime(pk * 0.3, s + a + tau);
    p.linearRampToValueAtTime(0, s + a + tau * 3);
    end = s + a + tau * 3;
  }
  return end + 0.02;
}

/** Cosine-interpolated lookup into a [position 0..1, value] contour. */
function contour(pts: Contour, x: number): number {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x <= x1) {
      const u = clamp((x - x0) / (x1 - x0 || 1), 0, 1);
      return y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    }
  }
  return pts[pts.length - 1][1];
}

/** Rounded attack / gently sagging sustain / rounded release, as a value curve ending on 0. */
function envelope(attack: number, release: number): Float32Array {
  const n = 64, c = new Float32Array(n);
  for (let i = 0; i < n - 1; i++) {
    const x = i / (n - 1);
    const up = x < attack ? Math.sin((Math.PI / 2) * (x / attack)) ** 2 : 1;
    const down = x > 1 - release ? Math.cos((Math.PI / 2) * ((x - (1 - release)) / release)) ** 2 : 1;
    c[i] = up * down * (1 - 0.2 * x);
  }
  return c;
}

export class AudioEngine {
  private g: Graph | null = null;
  private disposed = false;
  private listening = false;
  private volume = 0.8;
  private muted = false;
  private readonly voices: Voice[] = [];
  private purring: Purr | null = null;
  // listener (ground position, half-weighted height, right vector)
  private lx = 0; private ly = 0; private lz = 0; private rx = 1; private rz = 0;
  // ambience state
  private night = 0; private nearWater = 0; private wind = 0.3;
  private clock = 0; private slowT = 0;
  private birdT = rand(2, 5); private owlT = rand(14, 40); private dripT = 0.5;
  private readonly crickets = [0, 1, 2].map((i) => {
    const a = rand(0, TAU);
    return { x: Math.cos(a) * 11, z: Math.sin(a) * 11, hz: 4200 * (0.94 + i * 0.05), t: rand(0.5, 6), left: 6 };
  });

  private readonly onVisibility = (): void => {
    const ctx = this.g?.ctx;
    if (!ctx) return;
    try { void (document.hidden ? ctx.suspend() : ctx.resume()).catch(noop); } catch { /* closed context */ }
  };

  constructor() { /* nothing is created until unlock() */ }

  get unlocked(): boolean { return this.live() !== null; }

  async unlock(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      if (!this.g) {
        const Ctor = audioCtor();
        if (!Ctor) return false;
        const ctx = new Ctor();
        try { this.g = this.build(ctx); } catch { void ctx.close().catch(noop); return false; }
        document.addEventListener('visibilitychange', this.onVisibility);
        this.listening = true;
      }
      const ctx = this.g.ctx;
      // resume() can stay pending forever when called outside a gesture: never wait on it for long.
      if (ctx.state !== 'running') {
        await Promise.race([ctx.resume(), new Promise<void>((r) => setTimeout(r, 350))]);
      }
      return this.unlocked;
    } catch { return false; }
  }

  setVolume(v: number): void { this.volume = clamp01(v); this.applyMaster(0.05); }
  setMuted(m: boolean): void { this.muted = m; this.applyMaster(0.04); }

  setListener(x: number, y: number, z: number, forwardX: number, forwardZ: number): void {
    if (![x, y, z, forwardX, forwardZ].every(Number.isFinite)) return;
    this.lx = x; this.ly = y; this.lz = z;
    const len = Math.hypot(forwardX, forwardZ);
    if (len > 1e-5) { this.rx = -forwardZ / len; this.rz = forwardX / len; } // right = forward rotated 90 degrees
  }

  update(dt: number, env: { night: number; nearWater: number; wind: number }): void {
    this.play((g, t) => {
      const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
      this.night = clamp01(env.night); this.nearWater = clamp01(env.nearWater); this.wind = clamp01(env.wind);
      this.clock += step;
      if ((this.slowT -= step) <= 0) { this.slowT = 0.12; this.steerBed(g); this.sweep(g); }
      const day = 1 - this.night;
      if (day > 0.15 && (this.birdT -= step * day) <= 0) { this.birdT = rand(4, 11); this.birdPhrase(g, t, day); }
      if (this.night > 0.25) {
        for (const c of this.crickets) {
          if ((c.t -= step) > 0) continue;
          this.cricket(g, t, c.x, c.z, c.hz);
          if (--c.left > 0) c.t = rand(0.52, 0.74);
          else { c.left = 4 + Math.floor(rand(0, 8)); c.t = rand(2.5, 7.5); }
        }
      }
      if (this.night > 0.6 && (this.owlT -= step) <= 0) { this.owlT = rand(28, 70); this.owl(g, t); }
      if (this.nearWater > 0.25 && (this.dripT -= step * this.nearWater) <= 0) {
        this.dripT = rand(0.25, 1.1);
        const v = this.open(g, 'ambience', 0.035 * this.nearWater, rand(-0.5, 0.5), 0.3);
        const f = rand(900, 2000);
        if (v) this.tone(v, t, { f0: f, f1: f * 1.5, glide: 0.03, tau: 0.018, gain: 1 });
      }
    });
  }

  vocal(kind: VocalKind, intensity: number, pitch: number, x: number, z: number): void {
    this.play((g, t) => {
      const i = clamp01(intensity), p = clamp(Number.isFinite(pitch) ? pitch : 1, 0.5, 2), amt = 0.45 + 0.55 * i;
      const voice = (level: number, wet: number): Voice | null => this.at(g, 'voice', level * amt, x, z, wet);
      let v: Voice | null;
      switch (kind) {
        case 'purr': {
          if (!(v = voice(0.5, 0.04))) return;
          const pg = this.purrGraph(g, p), amp = g.ctx.createGain();
          amp.gain.value = 0;
          const end = shape(amp.gain, t, { gain: 1, attack: 0.2, dur: 0.7 + 0.6 * i, release: 0.35 });
          pg.out.connect(amp); amp.connect(v.in);
          for (const s of pg.sources) this.run(v, s, t, end);
          return;
        }
        case 'huff':
          if (!(v = voice(0.5, 0.1))) return;
          this.noise(v, t, { pink: true, f0: 1500 * p, f1: 850 * p, glide: 0.16, q: 0.8, attack: 0.03, dur: 0.2, release: 0.13, gain: 1.4 });
          this.noise(v, t, { f0: 3000, q: 0.7, attack: 0.03, dur: 0.16, release: 0.1, gain: 0.22 });
          return;
        case 'sniff': {
          if (!(v = voice(0.38, 0.06))) return;
          const n = Math.random() < 0.5 ? 2 : 3;
          for (let k = 0, at = t; k < n; k++, at += rand(0.085, 0.115)) {
            this.noise(v, at, { f0: 2200 * p, f1: 3300 * p, glide: 0.05, q: 1.3, attack: 0.015, tau: 0.018, gain: 1 });
          }
          return;
        }
        case 'munch':
          if (!(v = voice(0.3, 0.08))) return;
          for (let k = 0, at = t; k < 2; k++, at += rand(0.15, 0.2)) {
            this.noise(v, at, { f0: rand(1500, 2300), q: 1.8, attack: 0.002, tau: 0.016, gain: 1 });
            this.noise(v, at, { pink: true, filter: 'highpass', f0: 3000, attack: 0.002, tau: 0.006, gain: 0.3 });
            this.tone(v, at, { f0: 130, f1: 80, glide: 0.04, tau: 0.03, gain: 0.5 });
          }
          return;
        case 'lap':
          if (!(v = voice(0.3, 0.1))) return;
          this.tone(v, t, { f0: 950 * jitter(0.08), f1: 400, glide: 0.045, tau: 0.022, gain: 0.8 });
          this.noise(v, t, { f0: 3200, q: 1.5, attack: 0.003, tau: 0.012, gain: 0.25 });
          return;
        default: {
          const spec = VOCALS[kind];
          if (!(v = voice(spec.gain, 0.12))) return;
          // Smaller (higher) individuals also get slightly higher formants.
          this.sing(v, t, VOICE_HZ * p * jitter(0.025), Math.sqrt(p), spec, spec.dur * jitter(0.08));
        }
      }
    });
  }

  purr(active: boolean, intensity: number, pitch: number, x: number, z: number): void {
    const g = this.g;
    if (!g || this.disposed) return;
    try {
      const now = g.ctx.currentTime;
      if (!active) { // allowed even while suspended, so a purr never hangs on after the page returns
        const p = this.purring;
        if (p?.active) { p.active = false; p.stoppedAt = now; p.level.gain.setTargetAtTime(0, now, 0.22); }
        return;
      }
      if (g.ctx.state !== 'running') return;
      let p = this.purring;
      if (!p) {
        const pg = this.purrGraph(g, clamp(Number.isFinite(pitch) ? pitch : 1, 0.5, 2));
        const level = g.ctx.createGain();
        level.gain.value = 0;
        pg.out.connect(level);
        let pan: StereoPannerNode | null = null;
        if (typeof g.ctx.createStereoPanner === 'function') { pan = g.ctx.createStereoPanner(); level.connect(pan); }
        (pan ?? level).connect(g.buses.voice);
        for (const s of pg.sources) s.start(now);
        p = this.purring = { level, pan, sources: pg.sources, active: false, stoppedAt: now, stamp: -1 };
      }
      if (p.active && now - p.stamp < 0.08) return; // called every frame: keep the automation timeline short
      const sp = this.spatial(x, z);
      if (!Number.isFinite(sp.gain)) return;
      p.level.gain.setTargetAtTime(0.55 * (0.4 + 0.6 * clamp01(intensity)) * sp.gain, now, p.active ? 0.15 : 0.3);
      p.pan?.pan.setTargetAtTime(sp.pan, now, 0.12);
      p.active = true; p.stamp = now;
    } catch { /* audio must never break the game */ }
  }

  footstep(x: number, z: number, strength: number, surface: Surface): void {
    this.play((g, t) => {
      const v = this.at(g, 'world', 0.22 * (0.3 + 0.7 * clamp01(strength)), x, z, 0.1);
      if (!v) return;
      if (surface === 'grass') {
        this.noise(v, t, { pink: true, filter: 'lowpass', f0: rand(800, 1100), attack: 0.008, tau: 0.035, gain: 1.2 });
        this.tone(v, t, { f0: 95 * jitter(0.1), f1: 60, glide: 0.05, attack: 0.006, tau: 0.03, gain: 0.5 });
      } else if (surface === 'stone') {
        this.noise(v, t, { f0: rand(2100, 2700), q: 1.2, attack: 0.003, tau: 0.014, gain: 1.4 });
        this.tone(v, t, { f0: 180 * jitter(0.1), f1: 140, glide: 0.03, tau: 0.018, gain: 0.35 });
      } else {
        this.tone(v, t, { f0: 620 * jitter(0.12), f1: 300, glide: 0.05, tau: 0.03, gain: 0.6 });
        this.noise(v, t, { f0: 1800, f1: 900, glide: 0.1, q: 1, attack: 0.004, tau: 0.05, gain: 0.7 });
      }
    });
  }

  toyImpact(kind: 'ball' | 'rattle' | 'berry', speed: number, surface: 'ground' | 'rock' | 'water', x: number, z: number): void {
    const s = clamp01(speed / 5);
    if (s < 0.03) return; // resting contacts
    if (surface === 'water') { this.splash(x, z, kind === 'berry' ? 0.35 * s + 0.15 : 0.3 + 0.7 * s); return; }
    this.play((g, t) => {
      const rock = surface === 'rock';
      if (kind === 'ball') { // hollow wooden "tok": damped fundamental, one short inharmonic partial, a soft click
        const v = this.at(g, 'world', 0.5 * (0.15 + 0.85 * s), x, z, 0.2);
        if (!v) return;
        const f = rock ? rand(380, 520) : rand(220, 320);
        this.tone(v, t, { f0: f * 1.12, f1: f, glide: 0.03, attack: 0.003, tau: rock ? 0.04 : 0.065, gain: 1 });
        this.tone(v, t, { f0: f * (rock ? 2.76 : 2.42), attack: 0.003, tau: 0.028, gain: rock ? 0.45 : 0.3 });
        this.noise(v, t, { f0: rock ? 3400 : 1700, q: 1, attack: 0.002, tau: rock ? 0.005 : 0.006, gain: rock ? 0.8 : 0.5 });
      } else if (kind === 'rattle') { // gourd rattle: a scatter of seed ticks over a small body knock
        const v = this.at(g, 'world', 0.6 * (0.25 + 0.75 * s), x, z, 0.15);
        if (!v) return;
        const hits: number[] = [];
        for (let k = 0, at = 0, n = 4 + Math.floor(rand(0, 4)); k < n; k++, at += rand(0.026, 0.05)) hits.push(at);
        this.noise(v, t, { f0: rand(4200, 6200), q: 3, hits, attack: 0.002, tau: 0.006, gain: 1.5 });
        this.tone(v, t, { f0: rand(360, 440) * (rock ? 1.3 : 1), attack: 0.003, tau: 0.03, gain: 0.25 });
      } else { // berry: tiny plop
        const v = this.at(g, 'world', 0.25 * (0.4 + 0.6 * s), x, z, 0.12);
        if (!v) return;
        this.tone(v, t, { f0: 320 * jitter(0.1), f1: 150, glide: 0.06, attack: 0.004, tau: 0.035, gain: 0.8 });
        this.noise(v, t, { pink: true, filter: 'lowpass', f0: 700, attack: 0.004, tau: 0.02, gain: 0.5 });
      }
    });
  }

  rustle(x: number, z: number, strength: number): void {
    this.play((g, t) => {
      const st = clamp01(strength), dur = (0.15 + 0.15 * st) * jitter(0.1);
      const v = this.at(g, 'world', 0.3 * (0.3 + 0.7 * st), x, z, 0.25);
      if (!v) return;
      this.noise(v, t, { f0: rand(2200, 3000), f1: rand(3200, 4200), glide: dur * 0.5, q: 0.9, attack: dur * 0.4, dur, release: dur * 0.5, gain: 0.8 });
      this.noise(v, t, { pink: true, filter: 'highpass', f0: 1400, hits: [dur * 0.2, dur * 0.48, dur * 0.74], attack: 0.006, tau: 0.008, gain: 0.5 });
    });
  }

  splash(x: number, z: number, strength: number): void {
    this.play((g, t) => {
      const st = clamp01(strength);
      const v = this.at(g, 'world', 0.4 * (0.3 + 0.7 * st), x, z, 0.3);
      if (!v) return;
      this.noise(v, t, { f0: 2600 * jitter(0.1), f1: 700, glide: 0.18, q: 1.1, attack: 0.004, tau: 0.05 + 0.07 * st, gain: 1 });
      this.tone(v, t, { f0: 420 * jitter(0.1), f1: 160, glide: 0.09, attack: 0.004, tau: 0.05, gain: 0.6 });
      for (let k = 0, n = st > 0.35 ? 1 + Math.floor(rand(0, 3)) : 0; k < n; k++) { // droplets falling back
        const f = rand(1000, 1800);
        this.tone(v, t + rand(0.07, 0.26), { f0: f, f1: f * 1.35, glide: 0.03, tau: 0.02, gain: 0.25 });
      }
    });
  }

  chime(kind: CurioKind, x: number, z: number): void {
    this.play((g, t) => {
      const { ctx } = g;
      if (kind === 'hummer') { // warm swelling hum: detuned pair on G3, a fifth, a hint of octave
        const v = this.at(g, 'world', 0.24, x, z, 0.35);
        if (!v) return;
        const f = 196 * jitter(0.01), e = { attack: 0.45, dur: 1.2, release: 0.5 };
        const trem = this.wobble(v, t, t + 1.25, 4.6, 0.13);
        this.tone(v, t, { ...e, f0: f, gain: 0.5, dest: trem });
        this.tone(v, t, { ...e, f0: f * 1.007, gain: 0.45, dest: trem });
        this.tone(v, t, { ...e, f0: f * 1.5, gain: 0.3, dest: trem });
        this.tone(v, t, { ...e, f0: f * 2, gain: 0.1, dest: trem });
        this.tone(v, t, { ...e, type: 'triangle', f0: f / 2, gain: 0.15, dest: trem });
      } else if (kind === 'spinner') { // whirring flutter that spins down
        const v = this.at(g, 'world', 0.55, x, z, 0.2);
        if (!v) return;
        const dur = 0.95 * jitter(0.06), e = { attack: 0.05, dur, release: 0.5 };
        const am = ctx.createGain(), lfo = ctx.createOscillator(), depth = ctx.createGain();
        am.gain.value = 0.5; depth.gain.value = 0.5; lfo.type = 'triangle';
        lfo.frequency.setValueAtTime(30 * jitter(0.08), t);
        lfo.frequency.exponentialRampToValueAtTime(11, t + dur);
        lfo.connect(depth); depth.connect(am.gain); am.connect(v.in);
        this.run(v, lfo, t, t + dur + 0.05);
        this.noise(v, t, { ...e, pink: true, f0: 1100, f1: 700, glide: dur, q: 2.2, gain: 1.6, dest: am });
        this.tone(v, t, { ...e, type: 'triangle', f0: 330, f1: 262, glide: dur, gain: 0.18, dest: am });
      } else { // shell: glassy bell, free-bar partials with a slow beat on the fundamental
        const v = this.at(g, 'world', 0.22, x, z, 0.6);
        if (!v) return;
        const f = 990 * jitter(0.015);
        const partials = [[1, 1, 0.34], [1.004, 0.5, 0.34], [2.756, 0.42, 0.2], [5.404, 0.2, 0.11], [8.933, 0.07, 0.06]];
        for (const [ratio, gain, tau] of partials) this.tone(v, t, { f0: f * ratio, attack: 0.005, tau, gain });
      }
    });
  }

  whistle(kind: 'come' | 'sit'): void {
    this.play((g, t) => {
      const v = this.open(g, 'world', 0.14, 0, 0.35);
      if (!v) return;
      const r = jitter(0.012);
      if (kind === 'come') this.airy(v, t, 0.5, 1320 * r, 1760 * r, 0.19, 0.07); // "whee-eet", up a fourth
      else for (const at of [0, 0.21]) this.airy(v, t + at, 0.12, 1480 * r, 1480 * r, 0, 0);
    });
  }

  ui(kind: 'tap' | 'select' | 'place' | 'deny'): void {
    this.play((g, t) => {
      const v = this.open(g, 'ui', 0.16, 0, 0.05);
      if (!v) return;
      const j = jitter(0.02);
      if (kind === 'tap') {
        this.tone(v, t, { f0: 880 * j, f1: 700, glide: 0.02, attack: 0.003, tau: 0.012, gain: 0.5 });
        this.noise(v, t, { f0: 2400, q: 1, attack: 0.002, tau: 0.004, gain: 0.25 });
      } else if (kind === 'select') {
        this.tone(v, t, { f0: 660 * j, attack: 0.004, tau: 0.02, gain: 0.5 });
        this.tone(v, t + 0.055, { f0: 990 * j, attack: 0.004, tau: 0.028, gain: 0.45 });
      } else if (kind === 'place') {
        this.tone(v, t, { f0: 330 * j, f1: 290, glide: 0.04, attack: 0.004, tau: 0.04, gain: 0.8 });
        this.noise(v, t, { pink: true, filter: 'lowpass', f0: 900, attack: 0.003, tau: 0.015, gain: 0.5 });
      } else {
        for (const [at, f] of [[0, 233], [0.09, 208]]) {
          this.tone(v, t + at, { type: 'triangle', f0: f * j, attack: 0.008, tau: 0.035, gain: 0.7 });
        }
      }
    });
  }

  shimmer(x: number, z: number, intensity: number): void {
    this.play((g, t) => {
      const i = clamp01(intensity);
      const v = this.at(g, 'world', 0.07 * (0.4 + 0.6 * i), x, z, 0.7);
      if (!v) return;
      const scale = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2], base = 2093 * jitter(0.01);
      for (let k = 0, at = t, n = 5 + Math.floor(i * 3); k < n; k++, at += rand(0.05, 0.11)) {
        const ratio = scale[Math.min(scale.length - 1, Math.floor(rand(0, 3)) + k)];
        this.tone(v, at, { f0: base * ratio, attack: 0.006, tau: rand(0.07, 0.12), gain: rand(0.3, 0.8) });
      }
      this.noise(v, t, { filter: 'highpass', f0: 5500, attack: 0.25, dur: 0.6, release: 0.3, gain: 0.08 });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const g = this.g;
    this.g = null; this.purring = null; this.voices.length = 0;
    if (!g) return;
    try {
      if (this.listening) document.removeEventListener('visibilitychange', this.onVisibility);
      g.master.gain.setTargetAtTime(0, g.ctx.currentTime, 0.02);
      setTimeout(() => { try { void g.ctx.close().catch(noop); } catch { /* already closed */ } }, 150);
    } catch { /* nothing left to clean up */ }
  }

  // ---------------------------------------------------------------- graph

  private build(ctx: AudioContext): Graph {
    const gain = (value: number): GainNode => { const n = ctx.createGain(); n.gain.value = value; return n; };
    const biquad = (type: BiquadFilterType, f: number, q: number): BiquadFilterNode => {
      const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n;
    };
    const loop = (buffer: AudioBuffer, rate: number): AudioBufferSourceNode => {
      const n = ctx.createBufferSource(); n.buffer = buffer; n.loop = true; n.playbackRate.value = rate; n.start(); return n;
    };
    const lfo = (hz: number, depth: number, target: AudioParam): void => {
      const o = ctx.createOscillator(), d = gain(depth); o.frequency.value = hz; o.connect(d); d.connect(target); o.start();
    };
    const master = gain(0), limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10; limiter.knee.value = 8; limiter.ratio.value = 12;
    limiter.attack.value = 0.003; limiter.release.value = 0.25;
    master.connect(limiter); limiter.connect(ctx.destination);
    const buses = { voice: gain(BUS_LEVEL.voice), world: gain(BUS_LEVEL.world), ambience: gain(BUS_LEVEL.ambience), ui: gain(BUS_LEVEL.ui) };
    for (const b of Object.values(buses)) b.connect(master);

    const reverb = gain(1), conv = ctx.createConvolver(), dark = biquad('lowpass', 3000, 0.5), ret = gain(0.7);
    conv.buffer = makeImpulse(ctx);
    reverb.connect(conv); conv.connect(dark); dark.connect(ret); ret.connect(master);

    const white = makeNoise(ctx, false), pink = makeNoise(ctx, true);
    // Wind: one pink loop feeding a low "air" band and a high "leaves" band.
    const air = loop(pink, 0.8), windTone = biquad('bandpass', 380, 0.5), wind = gain(0), leafBand = biquad('bandpass', 2600, 0.7), leaves = gain(0);
    air.connect(windTone); windTone.connect(wind); wind.connect(buses.ambience);
    air.connect(leafBand); leafBand.connect(leaves); leaves.connect(buses.ambience);
    // Water: two narrow wandering bands of white noise, gently chopped, read as a trickle.
    const stream = loop(white, 0.9), w1 = biquad('bandpass', 1500, 2.5), w2 = biquad('bandpass', 2900, 4), w2g = gain(0.5), chop = gain(0.7), water = gain(0);
    stream.connect(w1); stream.connect(w2); w1.connect(chop); w2.connect(w2g); w2g.connect(chop); chop.connect(water); water.connect(buses.ambience);
    lfo(2.7, 350, w1.frequency); lfo(6.3, 600, w2.frequency); lfo(4.1, 0.3, chop.gain);

    const g: Graph = { ctx, master, buses, reverb, white, pink, bed: { wind, windTone, leaves, water } };
    master.gain.setTargetAtTime(this.muted ? 0 : this.volume, ctx.currentTime, 0.4); // fade the bed in
    return g;
  }

  private live(): Graph | null {
    const g = this.g;
    return g && !this.disposed && g.ctx.state === 'running' ? g : null;
  }

  /** Runs `fn` only while audio is live, a few ms ahead of now, and swallows any audio error. */
  private play(fn: (g: Graph, t: number) => void): void {
    const g = this.live();
    if (!g) return;
    try { fn(g, g.ctx.currentTime + 0.006); } catch { /* audio must never break the game */ }
  }

  private applyMaster(tau: number): void {
    const g = this.g;
    if (!g || this.disposed) return;
    try { g.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, g.ctx.currentTime, tau); } catch { /* closed */ }
  }

  private spatial(x: number, z: number): { gain: number; pan: number; far: number } {
    const dx = x - this.lx, dz = z - this.lz, ground = Math.hypot(dx, dz), d = Math.hypot(ground, this.ly * 0.5);
    const u = clamp((d - 9) / 6, 0, 1), fade = 1 - u * u * (3 - 2 * u); // gone by ~14-15 units
    return {
      gain: fade / (1 + d * 0.12),
      pan: clamp((dx * this.rx + dz * this.rz) / (ground + 2), -0.85, 0.85),
      far: clamp(d / 12, 0, 1),
    };
  }

  // ---------------------------------------------------------------- voices

  /** Positioned one-shot: attenuated and panned from the listener; distant sounds get more reverb. */
  private at(g: Graph, bus: Bus, level: number, x: number, z: number, wet: number): Voice | null {
    const s = this.spatial(x, z);
    return this.open(g, bus, level * s.gain, s.pan, wet + s.far * 0.35);
  }

  private open(g: Graph, bus: Bus, level: number, pan: number, wet: number): Voice | null {
    if (!(level > 0.0015) || !Number.isFinite(level) || !Number.isFinite(pan)) return null; // inaudible or bad input
    const { ctx } = g, now = ctx.currentTime;
    if (this.voices.length >= MAX_VOICES) { // drop the weakest: quiet and old score lowest
      let weakest = this.voices[0], score = Infinity;
      for (const v of this.voices) {
        const s = v.level / (1 + (now - v.born) * 3);
        if (s < score) { score = s; weakest = v; }
      }
      if (level < score * 0.5) return null; // the newcomer is the quietest of all
      this.kill(weakest, now);
    }
    const input = ctx.createGain();
    input.gain.value = level;
    const chain: AudioNode[] = [input];
    let tail: AudioNode = input;
    if (typeof ctx.createStereoPanner === 'function' && Math.abs(pan) > 0.01) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      input.connect(p); chain.push(p); tail = p;
    }
    tail.connect(g.buses[bus]);
    if (wet > 0.01) {
      const send = ctx.createGain();
      send.gain.value = Math.min(wet, 1);
      tail.connect(send); send.connect(g.reverb); chain.push(send);
    }
    const v: Voice = { g, in: input, chain, sources: [], pending: 0, level, born: now, released: false };
    this.voices.push(v);
    return v;
  }

  /** Starts a source inside a voice; the voice is released when its last source has ended. */
  private run(v: Voice, src: Source, t0: number, t1: number): void {
    v.pending++;
    v.sources.push(src);
    src.onended = (): void => {
      src.onended = null;
      try { src.disconnect(); } catch { /* already gone */ }
      if (--v.pending <= 0) this.release(v);
    };
    if ('buffer' in src) src.start(t0, Math.random() * 1.8); else src.start(t0);
    src.stop(Math.max(t1, t0 + 0.01));
  }

  private release(v: Voice): void {
    if (v.released) return;
    v.released = true;
    for (const n of v.chain) { try { n.disconnect(); } catch { /* already gone */ } }
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /** Fades a voice out quickly and frees its slot now; `onended` finishes the disconnect. */
  private kill(v: Voice, now: number): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    try {
      v.in.gain.setTargetAtTime(0, now, 0.012);
      for (const s of v.sources) s.stop(now + 0.08);
    } catch { this.release(v); }
  }

  /** Housekeeping on the slow tick: reap stuck voices, tear down a purr that has faded out. */
  private sweep(g: Graph): void {
    const now = g.ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.pending <= 0 || now - v.born > 8) { this.kill(v, now); if (v.pending <= 0) this.release(v); }
    }
    const p = this.purring;
    if (p && !p.active && now - p.stoppedAt > 1.6) {
      this.purring = null;
      for (const s of p.sources) { try { s.stop(); s.disconnect(); } catch { /* already gone */ } }
      try { p.level.disconnect(); p.pan?.disconnect(); } catch { /* already gone */ }
    }
  }

  // ---------------------------------------------------------------- primitives

  private tone(v: Voice, t: number, o: ToneOpts): void {
    const { ctx } = v.g, osc = ctx.createOscillator(), amp = ctx.createGain();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.glide ?? 0.05));
    amp.gain.value = 0;
    const end = shape(amp.gain, t, o);
    osc.connect(amp); amp.connect(o.dest ?? v.in);
    this.run(v, osc, t, end);
  }

  private noise(v: Voice, t: number, o: NoiseOpts): void {
    const { ctx } = v.g, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), amp = ctx.createGain();
    src.buffer = o.pink ? v.g.pink : v.g.white;
    src.loop = true;
    f.type = o.filter ?? 'bandpass';
    f.Q.value = o.q ?? 0.7;
    f.frequency.setValueAtTime(o.f0, t);
    if (o.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.glide ?? 0.05));
    amp.gain.value = 0;
    const end = o.hits ? pulses(amp.gain, t, o.hits, o) : shape(amp.gain, t, o);
    src.connect(f); f.connect(amp); amp.connect(o.dest ?? v.in);
    this.run(v, src, t, end);
  }

  /** A gain stage feeding the voice whose level wobbles at `hz` (tremolo). */
  private wobble(v: Voice, t: number, end: number, hz: number, depth: number): GainNode {
    const { ctx } = v.g, stage = ctx.createGain(), lfo = ctx.createOscillator(), d = ctx.createGain();
    stage.gain.value = 1 - depth / 2; d.gain.value = depth / 2; lfo.frequency.value = hz;
    lfo.connect(d); d.connect(stage.gain); stage.connect(v.in);
    this.run(v, lfo, t, end);
    return stage;
  }

  /** Breathy whistle note: sine plus a narrow band of noise on the same pitch path, light vibrato. */
  private airy(v: Voice, t: number, dur: number, f0: number, f1: number, glideAt: number, glideLen: number): void {
    const { ctx } = v.g, osc = ctx.createOscillator(), air = ctx.createBufferSource(), band = ctx.createBiquadFilter();
    const airGain = ctx.createGain(), amp = ctx.createGain(), vib = ctx.createOscillator(), vibDepth = ctx.createGain();
    const path = (p: AudioParam): void => {
      p.setValueAtTime(f0 * 0.965, t); // small scoop into the note, as lips do
      p.exponentialRampToValueAtTime(f0, t + 0.035);
      if (glideLen > 0) { p.setValueAtTime(f0, t + glideAt); p.exponentialRampToValueAtTime(f1, t + glideAt + glideLen); }
    };
    path(osc.frequency); path(band.frequency);
    air.buffer = v.g.white; air.loop = true; band.type = 'bandpass'; band.Q.value = 5; airGain.gain.value = 1.1;
    vib.frequency.value = 5.5; vibDepth.gain.value = 9; vib.connect(vibDepth); vibDepth.connect(osc.detune);
    amp.gain.value = 0;
    const end = shape(amp.gain, t, { gain: 0.8, attack: 0.03, dur, release: Math.min(0.12, dur * 0.45) });
    if (glideLen > 0) { // a small dip articulates the second note without breaking the breath
      amp.gain.setValueAtTime(0.8, t + glideAt - 0.01);
      amp.gain.linearRampToValueAtTime(0.42, t + glideAt + glideLen * 0.5);
      amp.gain.linearRampToValueAtTime(0.8, t + glideAt + glideLen + 0.03);
    }
    osc.connect(amp); air.connect(band); band.connect(airGain); airGain.connect(amp); amp.connect(v.in);
    this.run(v, osc, t, end); this.run(v, air, t, end); this.run(v, vib, t, end);
  }

  /** The creature's throat: glottis blend + breath -> two formants + body -> lowpass -> envelope. */
  private sing(v: Voice, t: number, f0: number, formantScale: number, s: VocalSpec, dur: number): void {
    const { ctx } = v.g, end = t + dur + 0.03, steps = 48;
    const cents = new Float32Array(steps);
    for (let i = 0; i < steps; i++) cents[i] = 1200 * Math.log2(contour(s.pitch, i / (steps - 1)));
    const mix = ctx.createGain(), lp = ctx.createBiquadFilter(), amp = ctx.createGain();
    let vib: GainNode | null = null;
    if (s.vib) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = s.vib[0] * jitter(0.05);
      vib = ctx.createGain(); vib.gain.value = s.vib[1];
      lfo.connect(vib);
      this.run(v, lfo, t, end);
    }
    for (const [type, mult, level] of GLOTTIS) {
      const osc = ctx.createOscillator(), og = ctx.createGain();
      osc.type = type; osc.frequency.value = f0 * mult; og.gain.value = level;
      osc.detune.setValueCurveAtTime(cents, t, dur);
      vib?.connect(osc.detune);
      osc.connect(og); og.connect(mix);
      this.run(v, osc, t, end);
    }
    if (s.breath > 0) {
      const air = ctx.createBufferSource(), ag = ctx.createGain();
      air.buffer = v.g.pink; air.loop = true; ag.gain.value = s.breath * 3;
      air.connect(ag); ag.connect(mix);
      this.run(v, air, t, end);
    }
    lp.type = 'lowpass'; lp.frequency.value = s.bright; lp.Q.value = 0.5;
    const formant = (f: number, fEnd: number | undefined, q: number, level: number): void => {
      const bp = ctx.createBiquadFilter(), fg = ctx.createGain();
      bp.type = 'bandpass'; bp.Q.value = q; fg.gain.value = level;
      bp.frequency.setValueAtTime(f * formantScale, t);
      if (fEnd !== undefined) bp.frequency.exponentialRampToValueAtTime(fEnd * formantScale, t + dur);
      mix.connect(bp); bp.connect(fg); fg.connect(lp);
    };
    formant(s.f1, s.f1End, 3, 1);
    formant(s.f2, s.f2End, 5, 0.7);
    const body = ctx.createGain();
    body.gain.value = s.body;
    mix.connect(body); body.connect(lp);
    amp.gain.value = 0;
    amp.gain.setValueCurveAtTime(envelope(s.attack / dur, s.release / dur), t, dur);
    lp.connect(amp);
    amp.connect(s.trem ? this.wobble(v, t, end, s.trem[0] * jitter(0.06), s.trem[1]) : v.in);
  }

  /** Purr body: low saw + dark noise, chopped at ~26 Hz, with a slow breath that also nudges the rate. */
  private purrGraph(g: Graph, pitch: number): { out: GainNode; sources: Source[] } {
    const { ctx } = g;
    const saw = ctx.createOscillator(), sawGain = ctx.createGain(), air = ctx.createBufferSource(), airLp = ctx.createBiquadFilter();
    const airGain = ctx.createGain(), chop = ctx.createGain(), rate = ctx.createOscillator(), rateDepth = ctx.createGain();
    const lp = ctx.createBiquadFilter(), hp = ctx.createBiquadFilter(), out = ctx.createGain(), breath = ctx.createOscillator(), breathDepth = ctx.createGain(), breathRate = ctx.createGain();
    saw.type = 'sawtooth'; saw.frequency.value = 112 * pitch * jitter(0.04); sawGain.gain.value = 0.32;
    air.buffer = g.pink; air.loop = true; airLp.type = 'lowpass'; airLp.frequency.value = 500; airGain.gain.value = 0.9;
    chop.gain.value = 0.5; rate.type = 'triangle'; rate.frequency.value = 26 * jitter(0.04); rateDepth.gain.value = 0.46;
    lp.type = 'lowpass'; lp.frequency.value = 480 * pitch; lp.Q.value = 0.8;
    hp.type = 'highpass'; hp.frequency.value = 60; hp.Q.value = 0.5; // keep sub-audio rumble out of the limiter
    out.gain.value = 0.72; breath.frequency.value = 0.42 * jitter(0.1); breathDepth.gain.value = 0.26; breathRate.gain.value = 1.6;
    saw.connect(sawGain); sawGain.connect(chop);
    air.connect(airLp); airLp.connect(airGain); airGain.connect(chop);
    rate.connect(rateDepth); rateDepth.connect(chop.gain);
    breath.connect(breathDepth); breathDepth.connect(out.gain);
    breath.connect(breathRate); breathRate.connect(rate.frequency);
    chop.connect(lp); lp.connect(hp); hp.connect(out);
    return { out, sources: [saw, air, rate, breath] };
  }

  // ---------------------------------------------------------------- ambience

  private steerBed(g: Graph): void {
    const now = g.ctx.currentTime, c = this.clock, w = this.wind, bed = g.bed;
    const gust = 0.62 + 0.24 * Math.sin(c * 0.21) + 0.14 * Math.sin(c * 0.57 + 1.3); // slow, never periodic-sounding
    bed.wind.gain.setTargetAtTime((0.03 + 0.13 * w) * gust, now, 0.5);
    bed.windTone.frequency.setTargetAtTime(300 + 420 * w * gust, now, 0.6);
    bed.leaves.gain.setTargetAtTime(0.06 * w * w * gust * gust, now, 0.4);
    bed.water.gain.setTargetAtTime(0.075 * this.nearWater, now, 0.4);
  }

  /** A far-off sound somewhere around the glade: panned by bearing, not attenuated by distance. */
  private distant(g: Graph, level: number, wet: number, x?: number, z?: number): Voice | null {
    const a = rand(0, TAU);
    return this.open(g, 'ambience', level, this.spatial(x ?? Math.cos(a) * 11, z ?? Math.sin(a) * 11).pan, wet);
  }

  private birdPhrase(g: Graph, t: number, day: number): void {
    const v = this.distant(g, 0.055 * day * rand(0.6, 1), 0.55);
    if (!v) return;
    const base = rand(2300, 3600), style = Math.floor(rand(0, 3));
    if (style === 0) { // "tsip tsip tsip"
      for (let k = 0, at = t, n = 2 + Math.floor(rand(0, 3)); k < n; k++, at += rand(0.12, 0.15)) {
        this.tone(v, at, { f0: base * 0.9, f1: base * 1.15, glide: 0.05, attack: 0.012, dur: 0.07, release: 0.04, gain: 0.8 });
      }
    } else if (style === 1) { // falling twitter
      for (let k = 0, at = t, n = 4 + Math.floor(rand(0, 3)); k < n; k++, at += rand(0.075, 0.095)) {
        const f = base * 1.2 * Math.pow(0.92, k);
        this.tone(v, at, { f0: f, f1: f * 0.85, glide: 0.045, attack: 0.01, dur: 0.055, release: 0.03, gain: 0.7 });
      }
    } else { // slow two-note "fee-bee"
      this.tone(v, t, { f0: base * 0.98, f1: base, glide: 0.2, attack: 0.04, dur: 0.28, release: 0.1, gain: 0.7 });
      this.tone(v, t + 0.36, { f0: base * 0.84, f1: base * 0.82, glide: 0.3, attack: 0.04, dur: 0.34, release: 0.14, gain: 0.7 });
    }
  }

  private cricket(g: Graph, t: number, x: number, z: number, hz: number): void {
    const v = this.distant(g, 0.05 * this.night, 0.3, x, z);
    if (!v) return;
    const f = hz * jitter(0.01), hits = [0, 0.034, 0.068];
    this.noise(v, t, { f0: f, q: 16, hits, attack: 0.006, tau: 0.008, gain: 3 });
    this.tone(v, t, { f0: f, attack: 0.03, dur: 0.1, release: 0.05, gain: 0.05 });
  }

  private owl(g: Graph, t: number): void {
    const v = this.distant(g, 0.07 * this.night, 0.7);
    if (!v) return;
    const f = rand(300, 350);
    for (const [at, dur] of [[0, 0.34], [0.58, 0.16], [0.82, 0.3]]) {
      this.tone(v, t + at, { f0: f * 1.04, f1: f * 0.96, glide: dur, attack: 0.07, dur, release: Math.min(0.14, dur * 0.5), gain: 0.9 });
      this.noise(v, t + at, { pink: true, f0: f, q: 4, attack: 0.07, dur, release: 0.1, gain: 0.6 });
    }
  }
}
