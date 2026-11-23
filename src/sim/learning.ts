/**
 * Experience-driven adaptation. Every rule here changes a stored number that
 * later decisions read; nothing is cosmetic.
 *
 *  - activity affinity   exponential average of how enjoyable each play episode was
 *  - habituation         each harmless exposure shrinks the startle to that stimulus; it slowly recovers
 *  - familiarity         investigating a kind of object makes it less novel
 *  - cue association     Rescorla–Wagner: rewarded responses strengthen, unrewarded ones fade slightly
 *  - bond                trust in the player, moved by gentle or rough handling, feeding and play
 *  - places              remembered spots with a comfort value that steers where it rests
 *  - touch tolerance     slow drift of per-region touch preference
 *  - trait shift         small bounded drift of personality from repeated experience
 */
import { clamp, clamp01 } from '../core/math';
import { TOUCH_REGIONS, TRAIT_KEYS, type Identity, type TouchRegion, type TraitKey, type Traits } from './identity';
import { NEST, SUN_STONE } from './terrain';
import type { ActivityId, CueKind } from './types';

export interface PlaceMemory {
  label: string;
  x: number;
  z: number;
  comfort: number;
  visits: number;
  innate: boolean;
}

export interface LearnData {
  affinity: Record<ActivityId, number>;
  plays: Record<ActivityId, number>;
  habituation: Record<string, { h: number; n: number; lastAt: number }>;
  familiarity: Record<string, number>;
  cues: Record<CueKind, { strength: number; trials: number; rewards: number }>;
  bond: number;
  places: PlaceMemory[];
  touch: Record<TouchRegion, number>;
  traitShift: Traits;
  /** 8×8 grid of how well-trodden each part of the glade is, 0..1. */
  explored: number[];
}

export const TRAIT_SHIFT_LIMIT = 0.12;
export const HABITUATION_RECOVERY_S = 3 * 3600;
const GRID = 8;
const GRID_HALF = 8;

export interface LearnEvent { key: string; value: number; text: string }

export class Learning {
  data: LearnData;
  /** Recent changes, newest last; read by the developer inspector. */
  log: LearnEvent[] = [];
  onChange: ((e: LearnEvent) => void) | null = null;

  constructor(private id: Identity) {
    const t = id.traits;
    this.data = {
      // innate leanings are mild; experience quickly outweighs them
      affinity: { ball: 0.45 + 0.1 * t.playfulness, rattle: 0.45 + 0.1 * t.curiosity, wisp: 0.45 + 0.1 * (1 - t.confidence) },
      plays: { ball: 0, rattle: 0, wisp: 0 },
      habituation: {},
      familiarity: {},
      cues: { come: { strength: 0.25 + 0.2 * t.sociability, trials: 0, rewards: 0 }, sit: { strength: 0.04, trials: 0, rewards: 0 }, spin: { strength: 0.18, trials: 0, rewards: 0 } },
      bond: 0.22 + 0.16 * t.sociability,
      places: [
        { label: 'nest', x: NEST.x, z: NEST.z, comfort: 0.62, visits: 0, innate: true },
        { label: 'sun stone', x: SUN_STONE.x, z: SUN_STONE.z, comfort: 0.42, visits: 0, innate: true },
      ],
      touch: Object.fromEntries(TOUCH_REGIONS.map((r) => [r, 0])) as Record<TouchRegion, number>,
      traitShift: Object.fromEntries(TRAIT_KEYS.map((k) => [k, 0])) as Traits,
      explored: new Array(GRID * GRID).fill(0),
    };
  }

  private note(key: string, value: number, text: string): void {
    const e = { key, value, text };
    this.log.push(e);
    if (this.log.length > 40) this.log.shift();
    this.onChange?.(e);
  }

  /** Personality as it currently stands: seeded base plus bounded drift. */
  traits(): Traits {
    const out = {} as Traits;
    for (const k of TRAIT_KEYS) out[k] = clamp(this.id.traits[k] + this.data.traitShift[k], 0.05, 0.95);
    return out;
  }

  shiftTrait(key: TraitKey, delta: number, why: string): void {
    const before = this.data.traitShift[key];
    const after = clamp(before + delta, -TRAIT_SHIFT_LIMIT, TRAIT_SHIFT_LIMIT);
    if (after === before) return;
    this.data.traitShift[key] = after;
    this.note(`trait.${key}`, after, `${key} ${delta > 0 ? 'grew' : 'eased'} a little (${why})`);
  }

  // ── play preferences ───────────────────────────────────────────
  /** enjoyment in [0,1], measured over one finished play episode. */
  updateAffinity(activity: ActivityId, enjoyment: number): number {
    const a = this.data.affinity[activity];
    const next = clamp01(a + 0.18 * (clamp01(enjoyment) - a));
    this.data.affinity[activity] = next;
    this.data.plays[activity]++;
    this.note(`affinity.${activity}`, next, `${activity} play felt ${enjoyment > a ? 'better' : 'flatter'} than expected → liking ${a.toFixed(2)} → ${next.toFixed(2)}`);
    return next;
  }

  favouriteActivity(candidates: readonly ActivityId[]): ActivityId {
    let best = candidates[0];
    for (const c of candidates) if (this.data.affinity[c] > this.data.affinity[best]) best = c;
    return best;
  }

  // ── habituation ────────────────────────────────────────────────
  /** Current habituation to a stimulus, after spontaneous recovery since last exposure. */
  habituation(kind: string, now: number): number {
    const e = this.data.habituation[kind];
    if (!e) return 0;
    const dt = Math.max(0, now - e.lastAt);
    return e.h * Math.exp(-dt / HABITUATION_RECOVERY_S);
  }

  /** Call when an exposure turned out harmless. */
  habituate(kind: string, now: number): number {
    const sens = this.traits().sensitivity;
    const h0 = this.habituation(kind, now);
    const rate = 0.3 * (1.15 - 0.6 * sens);
    const h = clamp01(h0 + rate * (1 - h0));
    const e = this.data.habituation[kind];
    this.data.habituation[kind] = { h, n: (e?.n ?? 0) + 1, lastAt: now };
    this.note(`habituation.${kind}`, h, `"${kind}" proved harmless again → startle scaled by ${(1 - h).toFixed(2)}`);
    return h;
  }

  // ── familiarity with kinds of things ───────────────────────────
  familiarity(kind: string): number {
    return this.data.familiarity[kind] ?? 0;
  }
  familiarise(kind: string, amount: number): number {
    const f0 = this.familiarity(kind);
    const f = clamp01(f0 + amount * (1 - f0));
    this.data.familiarity[kind] = f;
    this.note(`familiarity.${kind}`, f, `"${kind}" is more familiar (${f0.toFixed(2)} → ${f.toFixed(2)})`);
    return f;
  }

  // ── cue learning (Rescorla–Wagner) ─────────────────────────────
  reinforceCue(kind: CueKind, rewarded: boolean): number {
    const c = this.data.cues[kind];
    c.trials++;
    const before = c.strength;
    if (rewarded) {
      c.rewards++;
      c.strength = clamp01(c.strength + 0.24 * (1 - c.strength));
    } else {
      c.strength = clamp01(c.strength - 0.06 * c.strength);
    }
    this.note(`cue.${kind}`, c.strength, `"${kind}" cue ${rewarded ? 'was rewarded' : 'went unrewarded'} → ${before.toFixed(2)} → ${c.strength.toFixed(2)}`);
    return c.strength;
  }

  // ── bond ───────────────────────────────────────────────────────
  adjustBond(delta: number, why: string): void {
    const before = this.data.bond;
    this.data.bond = clamp01(before + delta * (delta > 0 ? 1 - before * 0.5 : 1));
    if (Math.abs(delta) >= 0.004) this.note('bond', this.data.bond, `trust ${delta > 0 ? 'grew' : 'dipped'} (${why})`);
  }

  // ── places ─────────────────────────────────────────────────────
  reinforcePlace(x: number, z: number, value: number, label = 'spot'): PlaceMemory {
    let near: PlaceMemory | null = null;
    let nd = 1.1;
    for (const p of this.data.places) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < nd) { nd = d; near = p; }
    }
    if (near) {
      near.comfort = clamp01(near.comfort + 0.22 * (clamp01(value) - near.comfort));
      near.visits++;
      if (!near.innate) { near.x += (x - near.x) * 0.15; near.z += (z - near.z) * 0.15; }
      this.note(`place.${near.label}`, near.comfort, `the ${near.label} feels ${value > 0.5 ? 'good' : 'less good'} → comfort ${near.comfort.toFixed(2)}`);
      return near;
    }
    const fresh: PlaceMemory = { label, x, z, comfort: clamp01(0.3 + 0.4 * value), visits: 1, innate: false };
    if (this.data.places.length >= 7) {
      let worst = -1;
      for (let i = 0; i < this.data.places.length; i++) {
        const p = this.data.places[i];
        if (!p.innate && (worst < 0 || p.comfort < this.data.places[worst].comfort)) worst = i;
      }
      if (worst >= 0 && this.data.places[worst].comfort < fresh.comfort) this.data.places[worst] = fresh;
      else return fresh;
    } else this.data.places.push(fresh);
    this.note(`place.${label}`, fresh.comfort, `a new place worth remembering (${label})`);
    return fresh;
  }

  /** Where to rest: learned comfort, less a little for distance; the nest is favoured at night. */
  restPlace(fromX: number, fromZ: number, night: number): PlaceMemory {
    let best = this.data.places[0];
    let bs = -Infinity;
    for (const p of this.data.places) {
      let s = p.comfort - 0.025 * Math.hypot(p.x - fromX, p.z - fromZ);
      if (p.label === 'nest') s += 0.14 * night;
      if (p.label === 'sun stone') s += 0.1 * (1 - night) - 0.2 * night;
      if (s > bs) { bs = s; best = p; }
    }
    return best;
  }

  favouritePlace(): PlaceMemory {
    let best = this.data.places[0];
    for (const p of this.data.places) if (p.comfort > best.comfort) best = p;
    return best;
  }

  // ── exploration map ────────────────────────────────────────────
  private cell(x: number, z: number): number {
    const cx = clamp(Math.floor(((x + GRID_HALF) / (GRID_HALF * 2)) * GRID), 0, GRID - 1);
    const cz = clamp(Math.floor(((z + GRID_HALF) / (GRID_HALF * 2)) * GRID), 0, GRID - 1);
    return cx + cz * GRID;
  }
  exploredAt(x: number, z: number): number {
    return this.data.explored[this.cell(x, z)] ?? 0;
  }
  tread(x: number, z: number, dt: number): void {
    const i = this.cell(x, z);
    this.data.explored[i] = clamp01((this.data.explored[i] ?? 0) + dt / 45);
  }
  fadeExplored(dt: number): void {
    const k = Math.exp(-dt / 5400);
    for (let i = 0; i < this.data.explored.length; i++) this.data.explored[i] *= k;
  }

  // ── touch ──────────────────────────────────────────────────────
  touchLiking(region: TouchRegion): number {
    return clamp(this.id.touchLikes[region] + this.data.touch[region], -1, 1);
  }
  adjustTouch(region: TouchRegion, delta: number): void {
    this.data.touch[region] = clamp(this.data.touch[region] + delta, -0.35, 0.35);
  }
}
